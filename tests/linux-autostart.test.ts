import { mkdtemp, readFile, rm } from "node:fs/promises";
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
  it("keeps app startup enabled while another vault requests it", async () => {
    const home = await temporaryHome();
    const env = { XDG_CONFIG_HOME: join(home, "config") };
    const first = new LinuxAutostartManager("/vault/one", { env, executable: "/bin/sh", home });
    const second = new LinuxAutostartManager("/vault/two", { env, executable: "/bin/sh", home });
    const desktopPath = join(env.XDG_CONFIG_HOME, "autostart", "run-in-background-obsidian.desktop");
    await first.setEnabled(true);
    await second.setEnabled(true);
    await first.setEnabled(false);
    expect(await readFile(desktopPath, "utf8")).toContain(LOGIN_MARKER);
    await second.setEnabled(false);
    await expect(readFile(desktopPath, "utf8")).rejects.toThrow();
  });

  it("uses the portal for sandboxed packages", async () => {
    const home = await temporaryHome();
    const requests: Array<{ enabled: boolean; command: string[] }> = [];
    const manager = new LinuxAutostartManager("/vault/flatpak", {
      env: { FLATPAK_ID: "md.obsidian.Obsidian" },
      executable: "/app/obsidian",
      home,
      requestPortal: (enabled, command) => {
        requests.push({ enabled, command });
        return Promise.resolve(true);
      },
    });
    await manager.setEnabled(true);
    expect(requests).toEqual([{ enabled: true, command: ["/app/obsidian", LOGIN_MARKER] }]);
  });

  it("does not bypass a denied portal permission", async () => {
    const home = await temporaryHome();
    const manager = new LinuxAutostartManager("/vault/denied", {
      env: { FLATPAK_ID: "md.obsidian.Obsidian" },
      executable: "/app/obsidian",
      home,
      requestPortal: () => Promise.resolve(false),
    });
    await expect(manager.setEnabled(true)).rejects.toBeInstanceOf(PortalPermissionDeniedError);
    await expect(readFile(join(home, ".config", "autostart", "run-in-background-obsidian.desktop"), "utf8"))
      .rejects.toThrow();
  });

  it("removes its marker when both portal and fallback fail", async () => {
    const home = await temporaryHome();
    const manager = new LinuxAutostartManager("/vault/broken", {
      env: { APPIMAGE: "/missing/Obsidian.AppImage" },
      executable: "/missing/mount",
      home,
    });
    await expect(manager.setEnabled(true)).rejects.toThrow();
    const markers = join(home, ".config", "run-in-background", "autostart-vaults");
    const retry = new LinuxAutostartManager("/vault/working", { env: {}, executable: "/bin/sh", home });
    await retry.setEnabled(true);
    expect(await readFile(join(home, ".config", "autostart", "run-in-background-obsidian.desktop"), "utf8"))
      .toContain("/bin/sh");
    await rm(markers, { recursive: true, force: true });
  });
});
