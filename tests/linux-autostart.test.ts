import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDesktopEntry,
  createVaultOpenUri,
  detectLinuxLauncher,
  isLinuxLoginLaunch,
  LinuxAutostartManager,
  LOGIN_MARKER,
  PortalPermissionDeniedError,
  quoteDesktopArgument,
} from "../src/linux-autostart";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

async function temporaryHome(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "run-in-background-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("Linux launcher detection", () => {
  it("detects native, AppImage, Flatpak, and Snap launchers", () => {
    expect(detectLinuxLauncher({}, "/opt/Obsidian/obsidian", "/home/me").kind).toBe("native");
    expect(detectLinuxLauncher({ APPIMAGE: "/apps/Obsidian.AppImage" }, "/tmp/.mount/obsidian", "/home/me")).toMatchObject({
      kind: "appimage",
      desktopCommand: ["/apps/Obsidian.AppImage", LOGIN_MARKER],
    });
    expect(detectLinuxLauncher({ FLATPAK_ID: "md.obsidian.Obsidian" }, "/app/obsidian", "/home/me")).toMatchObject({
      kind: "flatpak",
      desktopCommand: ["flatpak", "run", "md.obsidian.Obsidian", LOGIN_MARKER],
    });
    expect(detectLinuxLauncher({ SNAP: "/snap/obsidian/1", SNAP_NAME: "obsidian" }, "/snap/obsidian", "/home/me")).toMatchObject({
      kind: "snap",
      desktopCommand: ["snap", "run", "obsidian", LOGIN_MARKER],
    });
  });

  it("recognizes only an explicit login marker", () => {
    expect(isLinuxLoginLaunch(["obsidian", LOGIN_MARKER])).toBe(true);
    expect(isLinuxLoginLaunch(["obsidian"])).toBe(false);
  });

  it("escapes desktop entry arguments", () => {
    expect(quoteDesktopArgument('/path/with "quotes" and %U')).toBe('"/path/with \\"quotes\\" and %%U"');
    expect(createDesktopEntry(["/opt/Obsidian/obsidian", LOGIN_MARKER])).toContain("X-RunInBackground-Owned=true");
  });

  it("creates encoded Obsidian vault URIs", () => {
    expect(createVaultOpenUri("G&A Workdesk")).toBe("obsidian://open?vault=G%26A%20Workdesk");
  });
});

describe("Linux autostart coordination", () => {
  it("creates one launcher for a primary vault and bootstrap commands for the others", async () => {
    const home = await temporaryHome();
    const env = { XDG_CONFIG_HOME: join(home, "config") };
    const first = new LinuxAutostartManager("/vault/G&A Workdesk", "G&A Workdesk", { env, executable: "/bin/sh", home });
    const second = new LinuxAutostartManager("/vault/GB-AI-Context", "GB-AI-Context", { env, executable: "/bin/sh", home });
    await first.setEnabled(true);
    const activeVaults = await second.setEnabled(true);
    const autostartDirectory = join(env.XDG_CONFIG_HOME, "autostart");
    expect(await readdir(autostartDirectory)).toEqual(["run-in-background-obsidian.desktop"]);
    const contents = await readFile(join(autostartDirectory, "run-in-background-obsidian.desktop"), "utf8");
    expect(contents).toContain("/vault/G&A Workdesk");
    expect(second.startupCommands(activeVaults, "G&A Workdesk")).toEqual([
      ["/bin/sh", "obsidian://open?vault=GB-AI-Context", LOGIN_MARKER],
    ]);
    await first.setEnabled(false);
    expect(await readFile(join(autostartDirectory, "run-in-background-obsidian.desktop"), "utf8"))
      .toContain("/vault/GB-AI-Context");
    await second.setEnabled(false);
    expect(await readdir(autostartDirectory)).toHaveLength(0);
  });

  it("removes plugin-owned 1.3.3 per-vault launchers", async () => {
    const home = await temporaryHome();
    const env = { XDG_CONFIG_HOME: join(home, "config") };
    const autostartDirectory = join(env.XDG_CONFIG_HOME, "autostart");
    await mkdir(autostartDirectory, { recursive: true });
    const legacyPath = join(autostartDirectory, "run-in-background-obsidian-0123456789abcdef0123.desktop");
    await writeFile(legacyPath, createDesktopEntry(["/bin/sh", "/vault/one", LOGIN_MARKER]));
    const manager = new LinuxAutostartManager("/vault/one", "One", { env, executable: "/bin/sh", home });
    await manager.setEnabled(true);
    await expect(readFile(legacyPath, "utf8")).rejects.toThrow();
  });

  it("allows only one vault plugin to bootstrap a process", async () => {
    const home = await temporaryHome();
    const env = { XDG_CONFIG_HOME: join(home, "config") };
    const first = new LinuxAutostartManager("/vault/one", "One", { env, executable: "/bin/sh", home });
    const second = new LinuxAutostartManager("/vault/two", "Two", { env, executable: "/bin/sh", home });
    await first.setEnabled(true);
    expect(await first.claimStartupBootstrap()).toBe(true);
    expect(await second.claimStartupBootstrap()).toBe(false);
  });

  it("removes bootstrap claims left by an earlier Obsidian process", async () => {
    const home = await temporaryHome();
    const env = { XDG_CONFIG_HOME: join(home, "config") };
    const manager = new LinuxAutostartManager("/vault/one", "One", { env, executable: "/bin/sh", home });
    await manager.setEnabled(true);
    const markerDirectory = join(env.XDG_CONFIG_HOME, "run-in-background", "autostart-vaults");
    await writeFile(join(markerDirectory, "startup-session-999999"), "");
    expect(await manager.claimStartupBootstrap()).toBe(true);
    expect((await readdir(markerDirectory)).some((file) => file === "startup-session-999999")).toBe(false);
  });

  it("uses the portal for sandboxed packages", async () => {
    const home = await temporaryHome();
    const requests: Array<{ enabled: boolean; command: string[] }> = [];
    const manager = new LinuxAutostartManager("/vault/flatpak", "Flatpak", {
      env: { FLATPAK_ID: "md.obsidian.Obsidian" },
      executable: "/app/obsidian",
      home,
      requestPortal: (enabled, command) => {
        requests.push({ enabled, command });
        return Promise.resolve(true);
      },
    });
    await manager.setEnabled(true);
    expect(requests).toEqual([{ enabled: true, command: ["/app/obsidian", "/vault/flatpak", LOGIN_MARKER] }]);
  });

  it("uses per-vault entries when a sandbox has multiple startup vaults", async () => {
    const home = await temporaryHome();
    const requests: boolean[] = [];
    const options = {
      env: { FLATPAK_ID: "md.obsidian.Obsidian" },
      executable: "/bin/sh",
      home,
      requestPortal: (enabled: boolean) => {
        requests.push(enabled);
        return Promise.resolve(true);
      },
    };
    const first = new LinuxAutostartManager("/vault/one", "One", options);
    const second = new LinuxAutostartManager("/vault/two", "Two", options);
    await first.setEnabled(true);
    await second.setEnabled(true);
    expect(requests).toEqual([true, true]);
    expect(await readdir(join(home, ".config", "autostart")).catch(() => [])).toHaveLength(0);
  });

  it("does not bypass a denied portal permission", async () => {
    const home = await temporaryHome();
    const manager = new LinuxAutostartManager("/vault/denied", "Denied", {
      env: { FLATPAK_ID: "md.obsidian.Obsidian" },
      executable: "/app/obsidian",
      home,
      requestPortal: () => Promise.resolve(false),
    });
    await expect(manager.setEnabled(true)).rejects.toBeInstanceOf(PortalPermissionDeniedError);
    expect(await readdir(join(home, ".config", "autostart")).catch(() => [])).toHaveLength(0);
  });

  it("removes its marker when both portal and fallback fail", async () => {
    const home = await temporaryHome();
    const manager = new LinuxAutostartManager("/vault/broken", "Broken", {
      env: { APPIMAGE: "/missing/Obsidian.AppImage" },
      executable: "/missing/mount",
      home,
    });
    await expect(manager.setEnabled(true)).rejects.toThrow();
    const markers = join(home, ".config", "run-in-background", "autostart-vaults");
    const retry = new LinuxAutostartManager("/vault/working", "Working", { env: {}, executable: "/bin/sh", home });
    await retry.setEnabled(true);
    const entries = await readdir(join(home, ".config", "autostart"));
    expect(await readFile(join(home, ".config", "autostart", entries[0]!), "utf8")).toContain("/bin/sh");
    await rm(markers, { recursive: true, force: true });
  });
});
