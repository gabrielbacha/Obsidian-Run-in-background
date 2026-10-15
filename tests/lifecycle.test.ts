import { describe, expect, it } from "vitest";
import { backgroundThrottlingFor, isOtherVaultWindow, isPlainRelaunch, QuitLifecycle, type ExitIntent } from "../src/lifecycle";

describe("QuitLifecycle", () => {
  it.each<Exclude<ExitIntent, "none">>([
    "user-quit", "explicit-quit", "relaunch", "system-shutdown", "plugin-unload",
  ])("stops restoring windows for %s", (intent) => {
    const lifecycle = new QuitLifecycle();
    expect(lifecycle.shouldRestoreOnActivation()).toBe(true);
    lifecycle.beginExit(intent);
    expect(lifecycle.intent).toBe(intent);
    expect(lifecycle.shouldRestoreOnActivation()).toBe(false);
  });

  it("suppresses a vault picker created immediately after a second launch", () => {
    const lifecycle = new QuitLifecycle();
    expect(lifecycle.shouldSuppressTransientWindow(10_000, 13_999)).toBe(true);
    expect(lifecycle.shouldSuppressTransientWindow(10_000, 14_000)).toBe(false);
  });

  it("never suppresses windows once quitting has begun", () => {
    const lifecycle = new QuitLifecycle();
    lifecycle.beginExit("system-shutdown");
    expect(lifecycle.shouldSuppressTransientWindow(10_000, 10_001)).toBe(false);
  });
});

describe("second-launch classification", () => {
  const app = "/Applications/Obsidian.app/Contents/MacOS/Obsidian";

  it("treats a launch without arguments as a relaunch", () => {
    expect(isPlainRelaunch([app])).toBe(true);
    expect(isPlainRelaunch([app, "--allow-file-access-from-files", "-psn_0_12345"])).toBe(true);
    expect(isPlainRelaunch([])).toBe(true);
  });

  it("does not treat Obsidian CLI calls as a relaunch", () => {
    expect(isPlainRelaunch([app, "vault=GB-AI-Context", "eval", "code=1"])).toBe(false);
    expect(isPlainRelaunch([app, "help"])).toBe(false);
    expect(isPlainRelaunch(["C:\\Obsidian\\Obsidian.exe", "session=abc", "tty", "search", "--json"])).toBe(false);
  });

  it("does not treat links or files as a relaunch", () => {
    expect(isPlainRelaunch([app, "obsidian://open?vault=Work"])).toBe(false);
    expect(isPlainRelaunch([app, "/Users/me/Notes/today.md"])).toBe(false);
  });

  it("skips the app path of a development Electron binary", () => {
    expect(isPlainRelaunch(["/usr/lib/electron/electron", "/opt/obsidian/app.asar"])).toBe(true);
    expect(isPlainRelaunch(["/usr/lib/electron/electron", "/opt/obsidian/app.asar", "help"])).toBe(false);
  });
});

describe("vault window identification", () => {
  const base = { owned: false, destroyed: false, title: "Daily Notes - Obsidian", appName: "Obsidian", url: "app://obsidian.md/index.html" };

  it("recognizes another vault window", () => {
    expect(isOtherVaultWindow(base)).toBe(true);
  });

  it("ignores owned, destroyed, picker, and unrelated windows", () => {
    expect(isOtherVaultWindow({ ...base, owned: true })).toBe(false);
    expect(isOtherVaultWindow({ ...base, destroyed: true })).toBe(false);
    expect(isOtherVaultWindow({ ...base, title: "Obsidian" })).toBe(false);
    expect(isOtherVaultWindow({ ...base, url: "devtools://devtools" })).toBe(false);
  });
});

describe("background throttling", () => {
  it("disables throttling in background mode", () => {
    expect(backgroundThrottlingFor(true, true)).toBe(false);
    expect(backgroundThrottlingFor(true, false)).toBe(false);
  });

  it("restores the original value outside background mode", () => {
    expect(backgroundThrottlingFor(false, true)).toBe(true);
    expect(backgroundThrottlingFor(false, false)).toBe(false);
  });
});
