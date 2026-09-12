import { createHash, randomBytes } from "node:crypto";
import { access, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { constants } from "node:fs";
import { sessionBus, variantValue, Variant, type DBusInterface } from "dbus-native";

export const LOGIN_MARKER = "--run-in-background-login";

export type LinuxPackageKind = "flatpak" | "snap" | "appimage" | "native";

export interface LinuxLauncher {
  kind: LinuxPackageKind;
  portalCommand: string[];
  desktopCommand: string[];
  autostartDirectory: string;
}

interface BackgroundPortal extends DBusInterface {
  RequestBackground(parentWindow: string, options: Record<string, Variant>): PromiseLike<string>;
}

export interface LinuxAutostartOptions {
  env?: NodeJS.ProcessEnv;
  executable?: string;
  home?: string;
  requestPortal?: (enabled: boolean, command: string[]) => Promise<boolean>;
}

interface VaultStartupRecord {
  desktopCommand: string[];
  desktopPath: string;
  portalCommand: string[];
  vaultName: string;
}

export class PortalPermissionDeniedError extends Error {
  constructor() {
    super("Desktop portal permission was denied");
    this.name = "PortalPermissionDeniedError";
  }
}

function hostConfigHome(env: NodeJS.ProcessEnv, home: string): string {
  return env.XDG_CONFIG_HOME && !env.FLATPAK_ID && !env.SNAP
    ? env.XDG_CONFIG_HOME
    : join(home, ".config");
}

export function detectLinuxLauncher(
  env: NodeJS.ProcessEnv,
  executable: string,
  home = homedir(),
): LinuxLauncher {
  if (env.FLATPAK_ID) {
    return {
      kind: "flatpak",
      portalCommand: [executable, LOGIN_MARKER],
      desktopCommand: ["flatpak", "run", env.FLATPAK_ID, LOGIN_MARKER],
      autostartDirectory: join(hostConfigHome(env, home), "autostart"),
    };
  }
  if (env.SNAP) {
    const snapName = env.SNAP_NAME || basename(env.SNAP);
    return {
      kind: "snap",
      portalCommand: [executable, LOGIN_MARKER],
      desktopCommand: ["snap", "run", snapName, LOGIN_MARKER],
      autostartDirectory: join(env.SNAP_USER_DATA || join(home, "snap", snapName, "current"), ".config", "autostart"),
    };
  }
  if (env.APPIMAGE) {
    return {
      kind: "appimage",
      portalCommand: [env.APPIMAGE, LOGIN_MARKER],
      desktopCommand: [env.APPIMAGE, LOGIN_MARKER],
      autostartDirectory: join(hostConfigHome(env, home), "autostart"),
    };
  }
  return {
    kind: "native",
    portalCommand: [executable, LOGIN_MARKER],
    desktopCommand: [executable, LOGIN_MARKER],
    autostartDirectory: join(hostConfigHome(env, home), "autostart"),
  };
}

export function isLinuxLoginLaunch(argv: string[]): boolean {
  return argv.includes(LOGIN_MARKER);
}

export function quoteDesktopArgument(argument: string): string {
  return `"${argument.replace(/[\\"`$]/gu, "\\$&").replace(/%/gu, "%%")}"`;
}

export function createDesktopEntry(command: string[], vaultName = "Obsidian"): string {
  const safeVaultName = vaultName.replace(/[\r\n]/gu, " ");
  return [
    "[Desktop Entry]",
    "Type=Application",
    `Name=${safeVaultName} (Run in Background)`,
    `Exec=${command.map(quoteDesktopArgument).join(" ")}`,
    "Terminal=false",
    "X-GNOME-Autostart-enabled=true",
    "X-RunInBackground-Owned=true",
    "",
  ].join("\n");
}

async function defaultPortalRequest(enabled: boolean, command: string[]): Promise<boolean> {
  const bus = sessionBus({ timeout: 65_000 });
  let responseTimeout: NodeJS.Timeout | undefined;
  let subscription: Awaited<ReturnType<typeof bus.watch>> | undefined;
  try {
    await bus.listNames();
    if (!bus.name) throw new Error("The session bus did not assign a unique name");
    const token = `run_in_background_${randomBytes(8).toString("hex")}`;
    const sender = bus.name.slice(1).replace(/\./gu, "_");
    const requestPath = `/org/freedesktop/portal/desktop/request/${sender}/${token}`;
    const signalKey = bus.mangle(requestPath, "org.freedesktop.portal.Request", "Response");
    subscription = await bus.watch([
      "type='signal'",
      `path='${requestPath}'`,
      "interface='org.freedesktop.portal.Request'",
      "member='Response'",
    ].join(","));
    const response = new Promise<boolean>((resolve, reject) => {
      responseTimeout = setTimeout(() => reject(new Error("Timed out waiting for the desktop portal")), 65_000);
      bus.signals.once(signalKey, (body: unknown[]) => {
        if (responseTimeout) clearTimeout(responseTimeout);
        const result = Number(body[0]);
        const values = body[1] as Record<string, unknown> | undefined;
        const autostart = variantValue<boolean | undefined>(values?.autostart);
        resolve(result === 0 && (!enabled || autostart !== false));
      });
    });
    const portal = await bus.getInterface<BackgroundPortal>(
      "org.freedesktop.portal.Desktop",
      "/org/freedesktop/portal/desktop",
      "org.freedesktop.portal.Background",
    );
    await portal.RequestBackground("", {
      handle_token: new Variant("s", token),
      reason: new Variant("s", "Keep Obsidian vaults and Sync running in the background"),
      autostart: new Variant("b", enabled),
      commandline: new Variant("as", command),
    });
    return await response;
  } finally {
    if (responseTimeout) clearTimeout(responseTimeout);
    if (subscription) await subscription.remove().catch(() => undefined);
    await bus.close();
  }
}

export class LinuxAutostartManager {
  private readonly launcher: LinuxLauncher;
  private readonly markerDirectory: string;
  private readonly markerPath: string;
  private readonly desktopPath: string;
  private readonly legacyDesktopPath: string;
  private readonly record: VaultStartupRecord;
  private readonly requestPortal: (enabled: boolean, command: string[]) => Promise<boolean>;

  constructor(vaultPath: string, vaultName = basename(vaultPath), options: LinuxAutostartOptions = {}) {
    const env = options.env ?? process.env;
    const home = options.home ?? homedir();
    this.launcher = detectLinuxLauncher(env, options.executable ?? process.execPath, home);
    const configHome = hostConfigHome(env, home);
    this.markerDirectory = join(configHome, "run-in-background", "autostart-vaults");
    const vaultId = createHash("sha256").update(vaultPath).digest("hex").slice(0, 20);
    this.markerPath = join(this.markerDirectory, vaultId);
    this.desktopPath = join(this.launcher.autostartDirectory, `run-in-background-obsidian-${vaultId}.desktop`);
    this.legacyDesktopPath = join(this.launcher.autostartDirectory, "run-in-background-obsidian.desktop");
    this.launcher.portalCommand = this.withVaultPath(this.launcher.portalCommand, vaultPath);
    this.launcher.desktopCommand = this.withVaultPath(this.launcher.desktopCommand, vaultPath);
    this.record = {
      desktopCommand: this.launcher.desktopCommand,
      desktopPath: this.desktopPath,
      portalCommand: this.launcher.portalCommand,
      vaultName,
    };
    this.requestPortal = options.requestPortal ?? defaultPortalRequest;
  }

  async setEnabled(enabled: boolean): Promise<void> {
    await mkdir(this.markerDirectory, { recursive: true });
    if (enabled) await writeFile(this.markerPath, JSON.stringify(this.record));
    else await rm(this.markerPath, { force: true });
    const activeVaults = await this.readActiveVaults();
    try {
      await this.removeLegacyDesktopEntry();
      await this.apply(enabled, activeVaults);
    } catch (error) {
      if (enabled) await rm(this.markerPath, { force: true });
      throw error;
    }
  }

  private async apply(enabledForVault: boolean, activeVaults: VaultStartupRecord[]): Promise<void> {
    if (this.launcher.kind === "flatpak" || this.launcher.kind === "snap") {
      try {
        if (activeVaults.length > 1) {
          const accepted = await this.requestPortal(false, this.launcher.portalCommand);
          if (!accepted) throw new PortalPermissionDeniedError();
          await Promise.all(activeVaults.map((record) => this.writeDesktopEntry(record)));
          return;
        }
        const remaining = activeVaults[0];
        const accepted = await this.requestPortal(Boolean(remaining), remaining?.portalCommand ?? this.launcher.portalCommand);
        if (!accepted) throw new PortalPermissionDeniedError();
        await rm(this.desktopPath, { force: true });
        if (remaining) await rm(remaining.desktopPath, { force: true });
        return;
      } catch (error) {
        if (error instanceof PortalPermissionDeniedError) throw error;
        // A package-aware XDG entry is the permitted fallback when the portal is unavailable.
        if (activeVaults.length > 0) {
          await rm(this.desktopPath, { force: true });
          await Promise.all(activeVaults.map((record) => this.writeDesktopEntry(record)));
          return;
        }
      }
    }
    if (!enabledForVault) {
      await rm(this.desktopPath, { force: true });
      return;
    }
    await this.writeDesktopEntry(this.record);
  }

  private async writeDesktopEntry(record: VaultStartupRecord): Promise<void> {
    const command = record.desktopCommand;
    if (command[0]?.startsWith("/")) await access(command[0], constants.X_OK);
    await mkdir(dirname(record.desktopPath), { recursive: true });
    const temporary = `${record.desktopPath}.${process.pid}.tmp`;
    await writeFile(temporary, createDesktopEntry(command, record.vaultName), { mode: 0o600 });
    await rename(temporary, record.desktopPath);
  }

  private withVaultPath(command: string[], vaultPath: string): string[] {
    const markerIndex = command.indexOf(LOGIN_MARKER);
    if (markerIndex < 0) return [...command, vaultPath, LOGIN_MARKER];
    return [...command.slice(0, markerIndex), vaultPath, ...command.slice(markerIndex)];
  }

  private async removeLegacyDesktopEntry(): Promise<void> {
    try {
      const contents = await readFile(this.legacyDesktopPath, "utf8");
      if (contents.includes("X-RunInBackground-Owned=true")) {
        await rm(this.legacyDesktopPath, { force: true });
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw error;
    }
  }

  private async readActiveVaults(): Promise<VaultStartupRecord[]> {
    const records: VaultStartupRecord[] = [];
    for (const file of await readdir(this.markerDirectory)) {
      try {
        const value = JSON.parse(await readFile(join(this.markerDirectory, file), "utf8")) as Partial<VaultStartupRecord>;
        if (
          Array.isArray(value.desktopCommand)
          && typeof value.desktopPath === "string"
          && Array.isArray(value.portalCommand)
          && typeof value.vaultName === "string"
        ) records.push(value as VaultStartupRecord);
      } catch {
        // Ignore legacy empty markers; their vault will rewrite them on its next settings refresh.
      }
    }
    return records;
  }
}
