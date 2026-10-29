import { EventEmitter } from "node:events";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { installCloseGuard, type CloseGuardOptions, type GuardApp, type GuardEvent, type GuardWindow } from "../src/close-guard";

class FakeEvent implements GuardEvent {
  defaultPrevented = false;
  preventDefault(): void {
    this.defaultPrevented = true;
  }
}

class FakeWindow extends EventEmitter implements GuardWindow {
  closing?: boolean;
  hidden = false;
  focused = 0;
  isDestroyed(): boolean {
    return false;
  }
  isFocused(): boolean {
    return false;
  }
  isVisible(): boolean {
    return !this.hidden;
  }
  blur(): void {}
  hide(): void {
    this.hidden = true;
  }
  show(): void {
    this.hidden = false;
  }
  focus(): void {
    this.focused++;
  }
  /** Mirrors Obsidian's main process: its own close listener runs first and marks the window. */
  requestClose(): FakeEvent {
    const event = new FakeEvent();
    this.closing = true;
    this.emit("close", event);
    return event;
  }
}

class FakeApp extends EventEmitter {
  quitting = false;
  relaunches = 0;
  constructor() {
    super();
    this.on("before-quit", () => (this.quitting = true));
    this.on("activate", () => (this.quitting = false));
  }
  relaunch(): void {
    this.relaunches++;
  }
  quit(): FakeEvent {
    const event = new FakeEvent();
    this.emit("before-quit", event);
    return event;
  }
}

const background: CloseGuardOptions = { runInBackground: true, keepRunningAfterQuit: true };

function setup(options = background) {
  const app = new FakeApp();
  const owner = new EventEmitter();
  const powerMonitor = new EventEmitter();
  const guard = installCloseGuard({ app: app as unknown as GuardApp, owner, powerMonitor }, options);
  const window = new FakeWindow();
  guard.track(window);
  return { app, owner, powerMonitor, guard, window };
}

describe("installCloseGuard", () => {
  it("cancels an ordinary close synchronously and clears Obsidian's closing mark", () => {
    const { guard, window } = setup();
    const event = window.requestClose();
    expect(event.defaultPrevented).toBe(true);
    expect(window.hidden).toBe(true);
    expect(window.closing).toBe(false);
    expect(guard.takeLog()).toEqual(["window close turned into hide"]);
  });

  it("allows closes when background mode is off or the vault is exiting", () => {
    const { guard, window } = setup({ runInBackground: false, keepRunningAfterQuit: true });
    expect(window.requestClose().defaultPrevented).toBe(false);
    guard.configure(background);
    guard.exit();
    expect(window.requestClose().defaultPrevented).toBe(false);
  });

  it("turns Quit into hide and clears Obsidian's quitting mark", () => {
    const { app, guard, window } = setup();
    const quit = app.quit();
    expect(quit.defaultPrevented).toBe(true);
    expect(window.hidden).toBe(true);
    expect(app.quitting).toBe(false);
    expect(guard.quitProceeding()).toBe(false);
  });

  it("lets Quit close the windows when keep-running is off", () => {
    const { app, guard, window } = setup({ runInBackground: true, keepRunningAfterQuit: false });
    expect(app.quit().defaultPrevented).toBe(false);
    expect(guard.quitProceeding()).toBe(true);
    expect(window.requestClose().defaultPrevented).toBe(false);
  });

  it("allows Quit after any relaunch request, including Obsidian's own", () => {
    const { app, window } = setup();
    app.relaunch();
    expect(app.relaunches).toBe(1);
    expect(app.quit().defaultPrevented).toBe(false);
    expect(window.requestClose().defaultPrevented).toBe(false);
  });

  it("allows closes after a system shutdown notice", () => {
    const { powerMonitor, window } = setup();
    powerMonitor.emit("shutdown");
    expect(window.requestClose().defaultPrevented).toBe(false);
  });

  it("removes itself with its renderer and keeps a later guard's relaunch wrapper working", () => {
    const { app, owner, window } = setup();
    const laterOwner = new EventEmitter();
    const later = installCloseGuard({ app: app as unknown as GuardApp, owner: laterOwner }, background);
    owner.emit("destroyed");
    expect(app.listenerCount("before-quit")).toBe(2);
    expect(window.requestClose().defaultPrevented).toBe(false);

    app.relaunch();
    expect(app.relaunches).toBe(1);
    expect(app.quit().defaultPrevented).toBe(false);
    later.dispose();
    app.relaunch();
    expect(app.relaunches).toBe(2);
  });

  it("restores Electron's relaunch when it is the last guard", () => {
    const { app, guard } = setup();
    guard.dispose();
    expect(Object.prototype.hasOwnProperty.call(app, "relaunch")).toBe(false);
    expect(app.listenerCount("before-quit")).toBe(1);
  });

  it("runs from its own source text, as the plugin compiles it into the main process", () => {
    const compiled = runInNewContext(`(${installCloseGuard.toString()})`) as typeof installCloseGuard;
    const app = new FakeApp();
    const guard = compiled({ app: app as unknown as GuardApp, owner: new EventEmitter() }, background);
    const window = new FakeWindow();
    guard.track(window);
    expect(window.requestClose().defaultPrevented).toBe(true);
  });

  it("shows a hidden vault when Obsidian focuses it, as for a file opened from Finder", () => {
    const { guard, window } = setup();
    let reveals = 0;
    guard.revealOnFocus(window, () => reveals++);
    window.requestClose();
    expect(window.hidden).toBe(true);
    window.focus();
    expect(window.hidden).toBe(false);
    expect(window.focused).toBe(1);
    expect(reveals).toBe(1);
    window.focus();
    expect(reveals).toBe(1);
    expect(guard.takeLog()).toContain("focus request showed the hidden vault");
  });

  it("removes the focus hook when it is disposed", () => {
    const { guard, window } = setup();
    guard.revealOnFocus(window, () => {
      throw new Error("renderer gone");
    });
    window.hide();
    expect(() => window.focus()).not.toThrow();
    expect(window.hidden).toBe(false);
    guard.dispose();
    expect(Object.prototype.hasOwnProperty.call(window, "focus")).toBe(false);
    window.hide();
    window.focus();
    expect(window.hidden).toBe(true);
  });

  it("closes windows of vaults without Run in Background when it cancels Quit", async () => {
    const app = new FakeApp();
    class PlainWindow extends FakeWindow {
      closed = 0;
      close(): void {
        this.closed++;
      }
    }
    const all: PlainWindow[] = [];
    // Like Electron's BrowserWindow: the guard finds every window through a tracked window's class.
    class AppWindow extends PlainWindow {
      static getAllWindows(): PlainWindow[] {
        return all;
      }
    }
    const kept = new AppWindow();
    const quitting = new AppWindow();
    const plain = new AppWindow();
    all.push(kept, quitting, plain);
    const keeper = installCloseGuard({ app: app as unknown as GuardApp, owner: new EventEmitter() }, background);
    const other = installCloseGuard(
      { app: app as unknown as GuardApp, owner: new EventEmitter() },
      { runInBackground: true, keepRunningAfterQuit: false },
    );
    keeper.track(kept);
    other.track(quitting);
    expect(app.quit().defaultPrevented).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(kept.hidden).toBe(true);
    expect(kept.closed).toBe(0);
    // A vault with the plugin on closes itself, so that its tray icon is removed too.
    expect(quitting.closed).toBe(0);
    expect(plain.closed).toBe(1);
    expect(keeper.takeLog()).toContain("app quit: closing 1 window(s) of vaults that do not run in background");
  });

  it("never throws from a cancelled Quit when it cannot list the app windows", () => {
    const { app, guard } = setup();
    expect(() => app.quit()).not.toThrow();
    expect(guard.takeLog()).toContain("app quit turned into hide");
  });
});
