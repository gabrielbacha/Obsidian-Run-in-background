import { withRegistryLock, processIsAlive } from "./registry-lock";
import { createHash, randomBytes } from "node:crypto";
import { access, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { constants } from "node:fs";
import { sessionBus, variantValue, Variant, type DBusInterface } from "dbus-native";
import { LOGIN_MARKER } from "./lifecycle";

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
  vaultExists?: (vaultPath: string) => Promise<boolean>;
  processAlive?: (pid: number) => boolean;
  removeLegacyEntry?: (path: string) => Promise<void>;
}

export interface VaultStartupRecord {
  vaultPath: string;
  vaultName: string;
}

interface LegacyVaultStartupRecord extends Partial<VaultStartupRecord> {
  desktopCommand?: unknown;
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

export function createVaultOpenUri(vaultName: string): string {
  return `obsidian://open?vault=${encodeURIComponent(vaultName)}`;
}

function legacyVaultPath(command: unknown): string {
  if (!Array.isArray(command)) return "";
  const argumentsList = command as unknown[];
  for (let index = argumentsList.length - 1; index >= 0; index -= 1) {
    const argument = argumentsList[index];
    if (typeof argument === "string" && argument.startsWith("/")) return argument;
  }
  return "";
}

async function pathExists(path: string): Promise<boolean> {
  if (path === "") return false;
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
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
  private readonly record: VaultStartupRecord;
  private readonly requestPortal: (enabled: boolean, command: string[]) => Promise<boolean>;
  private readonly processAlive: (pid: number) => boolean;
  private readonly removeLegacyEntry: (path: string) => Promise<void>;
  private readonly vaultExists: (vaultPath: string) => Promise<boolean>;

  constructor(vaultPath: string, vaultName = basename(vaultPath), options: LinuxAutostartOptions = {}) {
    const env = options.env ?? process.env;
    const home = options.home ?? homedir();
    this.launcher = detectLinuxLauncher(env, options.executable ?? process.execPath, home);
    const configHome = hostConfigHome(env, home);
    this.markerDirectory = join(configHome, "run-in-background", "autostart-vaults");
    const vaultId = createHash("sha256").update(vaultPath).digest("hex").slice(0, 20);
    this.markerPath = join(this.markerDirectory, vaultId);
    this.desktopPath = join(this.launcher.autostartDirectory, "run-in-background-obsidian.desktop");
    this.record = {
      vaultPath,
      vaultName,
    };
    this.requestPortal = options.requestPortal ?? defaultPortalRequest;
    this.vaultExists = options.vaultExists ?? pathExists;
    this.processAlive = options.processAlive ?? processIsAlive;
    this.removeLegacyEntry = options.removeLegacyEntry ?? (path => rm(path, { force: true }));
  }

  async setEnabled(enabled: boolean): Promise<VaultStartupRecord[]> {
    return withRegistryLock(this.markerDirectory, async () => {
      const prior = await this.readOptional(this.markerPath);
      const priorDesktop = await this.readOptional(this.desktopPath);
      const previous = await this.readActiveVaults();
      const legacy = await this.ownedLegacyEntries();
      let applied = false;
      try {
        if (enabled) await this.writeAtomic(this.markerPath, JSON.stringify(this.record));
        else await rm(this.markerPath, { force: true });
        const activeVaults = await this.readActiveVaults();
        if (enabled || activeVaults.length > 0 || previous.length > 0 || prior !== undefined) { await this.apply(activeVaults); applied = true; }
        // The replacement is usable before any owned legacy launcher is removed.
        await this.removePerVaultDesktopEntries();
        return activeVaults;
      } catch (error) {
        let rollbackError: unknown;
        if (applied) { try { await this.apply(previous); } catch (failure) { rollbackError = failure; } }
        await this.restore(this.markerPath, prior);
        await this.restore(this.desktopPath, priorDesktop);
        for (const [path, body] of legacy) await this.writeAtomic(path, body);
        if (rollbackError) throw new Error("Startup update failed; prior OS registration could not be restored. Check OS startup settings before retrying.", { cause: rollbackError });
        throw error;
      }
    });
  }

  startupCommands(activeVaults: VaultStartupRecord[], currentVaultPath: string): string[][] {
    return activeVaults.filter((record) => record.vaultPath !== currentVaultPath)
      .map((record) => this.withVaultPath(this.launcher.desktopCommand, record.vaultPath));
  }

  async claimStartupBootstrap(facts: { pid: number; sessionId: string; loginLaunch: boolean }): Promise<boolean> {
    if (!facts.loginLaunch) return false;
    if (!Number.isSafeInteger(facts.pid) || facts.pid <= 0 || !facts.sessionId) throw new Error("Invalid main-process startup identity.");
    return withRegistryLock(this.markerDirectory, async () => {
      const sessionPath = join(this.markerDirectory, "startup-session-owner.json");
      const previous = await this.readOptional(sessionPath);
      if (previous) {
        try {
          const owner = JSON.parse(previous) as { pid?: number; sessionId?: string };
          if (typeof owner.pid === "number" && Number.isSafeInteger(owner.pid) && owner.pid > 0 && this.processAlive(owner.pid) && !(owner.pid === facts.pid && owner.sessionId !== facts.sessionId)) return false;
        } catch { /* An invalid claim is replaced under the shared lock. */ }
      }
      for (const file of await readdir(this.markerDirectory)) {
        const match = /^startup-session-(\d+)$/u.exec(file);
        if (match && !this.processAlive(Number(match[1]))) await rm(join(this.markerDirectory, file), { force: true });
      }
      await this.writeAtomic(sessionPath, JSON.stringify({ pid: facts.pid, sessionId: facts.sessionId }));
      return true;
    });
  }

  private async readOptional(path: string): Promise<string | undefined> {
    return readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
  }
  private async restore(path: string, body: string | undefined): Promise<void> {
    if (body === undefined) await rm(path, { force: true });
    else await this.writeAtomic(path, body);
  }
  private async writeAtomic(path: string, body: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const staged = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try { await writeFile(staged, body, { flag: "wx", mode: 0o600 }); await rename(staged, path); }
    finally { await rm(staged, { force: true }); }
  }

  private async apply(activeVaults: VaultStartupRecord[]): Promise<void> {
    const primary = activeVaults[0];
    const enabled = Boolean(primary);
    const portalCommand = primary ? this.withVaultPath(this.launcher.portalCommand, primary.vaultPath) : this.launcher.portalCommand;
    if (this.launcher.kind === "flatpak" || this.launcher.kind === "snap") {
      try {
        const accepted = await this.requestPortal(enabled, portalCommand);
        if (!accepted) throw new PortalPermissionDeniedError();
        await rm(this.desktopPath, { force: true });
        return;
      } catch (error) {
        if (error instanceof PortalPermissionDeniedError) throw error;
        // A package-aware XDG entry is the permitted fallback when the portal is unavailable.
      }
    }
    if (!primary) {
      await rm(this.desktopPath, { force: true });
      return;
    }
    await this.writeDesktopEntry(this.withVaultPath(this.launcher.desktopCommand, primary.vaultPath));
  }

  private async writeDesktopEntry(command: string[]): Promise<void> {
    if (command[0]?.startsWith("/")) await access(command[0], constants.X_OK);
    await mkdir(dirname(this.desktopPath), { recursive: true });
    await this.writeAtomic(this.desktopPath, createDesktopEntry(command));
  }

  private withVaultPath(command: string[], vaultPath: string): string[] {
    const markerIndex = command.indexOf(LOGIN_MARKER);
    if (markerIndex < 0) return [...command, vaultPath, LOGIN_MARKER];
    return [...command.slice(0, markerIndex), vaultPath, ...command.slice(markerIndex)];
  }

  private async ownedLegacyEntries(): Promise<Map<string, string>> {
    const entries = new Map<string, string>();
    const files = await readdir(this.launcher.autostartDirectory).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; });
    for (const file of files) {
      if (!/^run-in-background-obsidian-[a-f0-9]{20}\.desktop$/u.test(file)) continue;
      const path = join(this.launcher.autostartDirectory, file);
      const contents = await this.readOptional(path);
      if (contents?.includes("X-RunInBackground-Owned=true")) entries.set(path, contents);
    }
    return entries;
  }
  private async removePerVaultDesktopEntries(): Promise<void> { for (const path of (await this.ownedLegacyEntries()).keys()) await this.removeLegacyEntry(path); }

  private async readActiveVaults(): Promise<VaultStartupRecord[]> {
    const records: VaultStartupRecord[] = [];
    for (const file of await readdir(this.markerDirectory)) {
      if (file.startsWith("startup-session-") || file.startsWith(".") || file.endsWith(".tmp")) continue;
      try {
        const value = JSON.parse(await readFile(join(this.markerDirectory, file), "utf8")) as LegacyVaultStartupRecord;
        if (typeof value.vaultName === "string") {
          const vaultPath = typeof value.vaultPath === "string"
            ? value.vaultPath
            : legacyVaultPath(value.desktopCommand);
          // A deleted or moved vault cannot withdraw its marker. It must not become the primary
          // vault, or the login entry opens a missing folder and no live vault opens the others.
          if (await this.vaultExists(vaultPath)) records.push({ vaultName: value.vaultName, vaultPath });
        }
      } catch {
        // Ignore legacy empty markers; their vault will rewrite them on its next settings refresh.
      }
    }
    return records.sort((left, right) => left.vaultPath.localeCompare(right.vaultPath));
  }
}
