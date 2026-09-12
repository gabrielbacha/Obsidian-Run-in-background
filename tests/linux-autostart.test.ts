import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDesktopEntry,
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
});

describe("Linux autostart coordination", () => {
  it("creates an independent launcher containing each vault path", async () => {
    const home = await temporaryHome();
    const env = { XDG_CONFIG_HOME: join(home, "config") };
    const first = new LinuxAutostartManager("/vault/G&A Workdesk", "G&A Workdesk", { env, executable: "/bin/sh", home });
    const second = new LinuxAutostartManager("/vault/GB-AI-Context", "GB-AI-Context", { env, executable: "/bin/sh", home });
    await first.setEnabled(true);
    await second.setEnabled(true);
    const autostartDirectory = join(env.XDG_CONFIG_HOME, "autostart");
    const launchers = await readdir(autostartDirectory);
    expect(launchers).toHaveLength(2);
    const contents = await Promise.all(launchers.map((file) => readFile(join(autostartDirectory, file), "utf8")));
    expect(contents.some((entry) => entry.includes('"/vault/G&A Workdesk"') && entry.includes("Name=G&A Workdesk"))).toBe(true);
    expect(contents.some((entry) => entry.includes('"/vault/GB-AI-Context"') && entry.includes("Name=GB-AI-Context"))).toBe(true);
    await first.setEnabled(false);
    const remaining = await readdir(autostartDirectory);
    expect(remaining).toHaveLength(1);
    expect(await readFile(join(autostartDirectory, remaining[0]!), "utf8")).toContain("/vault/GB-AI-Context");
    await second.setEnabled(false);
    expect(await readdir(autostartDirectory)).toHaveLength(0);
  });

  it("removes only a plugin-owned legacy shared launcher", async () => {
    const home = await temporaryHome();
    const env = { XDG_CONFIG_HOME: join(home, "config") };
    const autostartDirectory = join(env.XDG_CONFIG_HOME, "autostart");
    const legacyPath = join(autostartDirectory, "run-in-background-obsidian.desktop");
    await mkdir(autostartDirectory, { recursive: true });
    await writeFile(legacyPath, createDesktopEntry(["/bin/sh", LOGIN_MARKER]));
    const manager = new LinuxAutostartManager("/vault/one", "One", { env, executable: "/bin/sh", home });
    await manager.setEnabled(true);
    await expect(readFile(legacyPath, "utf8")).rejects.toThrow();
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
    expect(requests).toEqual([true, false]);
    const entries = await readdir(join(home, ".config", "autostart"));
    expect(entries).toHaveLength(2);
    const contents = await Promise.all(entries.map((file) => readFile(join(home, ".config", "autostart", file), "utf8")));
    expect(contents.some((entry) => entry.includes('"/vault/one"'))).toBe(true);
    expect(contents.some((entry) => entry.includes('"/vault/two"'))).toBe(true);
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
