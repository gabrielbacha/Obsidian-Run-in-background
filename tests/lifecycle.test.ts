import { describe, expect, it } from "vitest";
import { QuitLifecycle, type ExitIntent } from "../src/lifecycle";

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
