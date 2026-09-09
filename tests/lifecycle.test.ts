import { describe, expect, it } from "vitest";
import { backgroundThrottlingFor, isOtherVaultWindow, QuitLifecycle, type ExitIntent } from "../src/lifecycle";

describe("QuitLifecycle", () => {
  it("intercepts only ordinary closes in background mode", () => {
    const lifecycle = new QuitLifecycle();
    expect(lifecycle.shouldInterceptClose(true)).toBe(true);
    expect(lifecycle.shouldInterceptClose(false)).toBe(false);
  });

  it("cancels user Quit without entering an exit state when configured to stay running", () => {
    const lifecycle = new QuitLifecycle();
    expect(lifecycle.requestUserQuit(true)).toBe("hide");
    expect(lifecycle.intent).toBe("none");
    expect(lifecycle.shouldInterceptClose(true)).toBe(true);
  });

  it("allows user Quit when the toggle is disabled", () => {
    const lifecycle = new QuitLifecycle();
    expect(lifecycle.requestUserQuit(false)).toBe("exit");
    expect(lifecycle.intent).toBe("user-quit");
    expect(lifecycle.shouldInterceptClose(true)).toBe(false);
  });

  it.each<Exclude<ExitIntent, "none">>([
    "user-quit", "explicit-quit", "relaunch", "system-shutdown", "plugin-unload",
  ])("allows close for %s", (intent) => {
    const lifecycle = new QuitLifecycle();
    lifecycle.beginExit(intent);
    expect(lifecycle.shouldInterceptClose(true)).toBe(false);
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
