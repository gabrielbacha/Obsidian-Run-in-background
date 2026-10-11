import { describe, expect, it } from "vitest";
import { backgroundThrottlingFor, isOtherVaultWindow, QuitLifecycle, type ExitIntent } from "../src/lifecycle";

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
