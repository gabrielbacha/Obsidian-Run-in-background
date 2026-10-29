export interface CloseGuardOptions {
  runInBackground: boolean;
  keepRunningAfterQuit: boolean;
}

export interface GuardEvent {
  readonly defaultPrevented: boolean;
  preventDefault(): void;
}

interface GuardEmitter {
  on(event: string, listener: () => void): unknown;
  removeListener(event: string, listener: () => void): unknown;
}

/** An emitter whose `Name` event carries a cancellable Electron event. */
interface CancellableEmitter<Name extends string> {
  on(event: Name, listener: (event: GuardEvent) => void): unknown;
  on(event: string, listener: () => void): unknown;
  removeListener(event: Name, listener: (event: GuardEvent) => void): unknown;
  removeListener(event: string, listener: () => void): unknown;
}

export interface GuardWindow extends CancellableEmitter<"close"> {
  closing?: boolean;
  isDestroyed(): boolean;
  isFocused(): boolean;
  isVisible(): boolean;
  blur(): void;
  hide(): void;
  show(): void;
  focus: (...args: unknown[]) => void;
}

export interface GuardApp extends CancellableEmitter<"before-quit"> {
  relaunch: (...args: unknown[]) => void;
  listeners(event: string): ((...args: unknown[]) => unknown)[];
}

/** Any app window, also of a vault where Run in Background is off. */
export interface AnyWindow {
  isDestroyed(): boolean;
  close(): void;
}

/** The window that was focused when an app quit started, and the guard window map that owns it. */
interface QuitScope {
  focused?: AnyWindow;
  owner?: ReadonlyMap<object, unknown>;
}

export interface CloseGuardHost {
  app: GuardApp;
  /** The vault renderer; the guard removes itself when it is gone. */
  owner: GuardEmitter;
  powerMonitor?: GuardEmitter;
  autoUpdater?: GuardEmitter;
}

export interface CloseGuard {
  configure(options: CloseGuardOptions): void;
  track(window: GuardWindow): void;
  /**
   * Obsidian brings a vault forward with `focus()` (Finder "Open with", the vault chooser and switcher),
   * and Electron ignores `focus()` on a hidden window. Show the window first, then call `onReveal`.
   */
  revealOnFocus(window: GuardWindow, onReveal: () => void): void;
  /** Allow every close and quit from now on. */
  exit(): void;
  /** True while the latest app quit was not cancelled by any listener. */
  quitProceeding(): boolean;
  /** True when the latest app quit was for this vault: its window was focused, or no window was. */
  quitTargetsThisVault(): boolean;
  takeLog(): string[];
  dispose(): void;
}

/**
 * The main-process half of Run in Background. Electron decides a window close or an app quit when its
 * main-process event returns, and renderer listeners attached through `remote` run only afterwards, so
 * only a listener installed here can cancel a close before Obsidian's unload hook starts its quit
 * sequence. main.ts compiles this function's source into the main process: it must not use anything
 * outside its parameters and body.
 */
export function installCloseGuard(host: CloseGuardHost, initial: CloseGuardOptions): CloseGuard {
  const { app, owner, powerMonitor, autoUpdater } = host;
  let options = { ...initial };
  let exiting = false;
  let relaunching = false;
  let disposed = false;
  let lastQuit: GuardEvent | undefined;
  let lastScope: QuitScope = {};
  const log: string[] = [];
  const windows = new Map<GuardWindow, { close: (event: GuardEvent) => void; closed: () => void }>();
  // Every guard in the main process registers its windows here, so all guards agree which vault an app
  // quit is for and which windows belong to no Run in Background vault.
  const registryKey = Symbol.for("run-in-background.close-guards.v2");
  const shared = app as unknown as Record<symbol, {
    owned: Set<ReadonlyMap<object, unknown>>;
    quits: WeakMap<object, QuitScope>;
    closedUnowned: WeakSet<object>;
  } | undefined>;
  const registry = shared[registryKey] ??= { owned: new Set(), quits: new WeakMap(), closedUnowned: new WeakSet() };
  registry.owned.add(windows);
  const focusHooks = new Map<GuardWindow, { wrapped: GuardWindow["focus"]; original: GuardWindow["focus"]; owned: boolean }>();

  const record = (line: string): void => {
    log.push(line);
    if (log.length > 50) log.shift();
  };
  const allowsEverything = (): boolean => exiting || relaunching || disposed;
  const quitProceeding = (): boolean => lastQuit !== undefined && !lastQuit.defaultPrevented;
  const hide = (window: GuardWindow): void => {
    if (window.isDestroyed()) return;
    if (window.isFocused()) window.blur();
    window.hide();
  };

  const untrack = (window: GuardWindow): void => {
    const listeners = windows.get(window);
    if (!listeners) return;
    windows.delete(window);
    window.removeListener("close", listeners.close);
    window.removeListener("closed", listeners.closed);
    window.removeListener("session-end", stop);
  };
  const track = (window: GuardWindow): void => {
    if (disposed || windows.has(window)) return;
    const listeners = {
      close: (event: GuardEvent): void => {
        if (allowsEverything() || !options.runInBackground || quitProceeding()) return;
        event.preventDefault();
        // Obsidian marks the window closing for its unload hook. The close is cancelled, and a stale
        // mark would make Obsidian treat the next reload as a close.
        window.closing = false;
        hide(window);
        record("window close turned into hide");
      },
      closed: (): void => untrack(window),
    };
    windows.set(window, listeners);
    window.on("close", listeners.close);
    window.on("closed", listeners.closed);
    window.on("session-end", stop);
  };

  const revealOnFocus = (window: GuardWindow, onReveal: () => void): void => {
    if (disposed || focusHooks.has(window)) return;
    const owned = Object.prototype.hasOwnProperty.call(window, "focus");
    const original = window.focus;
    const wrapped = function (this: unknown, ...args: unknown[]): void {
      if (!allowsEverything() && !window.isDestroyed() && !window.isVisible()) {
        window.show();
        record("focus request showed the hidden vault");
        try {
          onReveal();
        } catch {
          // The renderer is gone; the window is shown already.
        }
      }
      original.apply(this, args);
    };
    window.focus = wrapped;
    focusHooks.set(window, { wrapped, original, owned });
  };
  const releaseFocusHooks = (): void => {
    for (const [window, hook] of focusHooks) {
      if (window.focus !== hook.wrapped) continue;
      if (hook.owned) window.focus = hook.original;
      else delete (window as Partial<GuardWindow>).focus;
    }
    focusHooks.clear();
  };

  const stop = (): void => {
    if (!exiting) record("system shutdown: closes allowed");
    exiting = true;
  };
  // `remote` does not pass Electron's BrowserWindow class through intact, so take it from a tracked
  // window: those are real main-process windows, and their constructor is BrowserWindow.
  const windowClass = (): { getAllWindows(): AnyWindow[]; getFocusedWindow(): AnyWindow | null } | undefined => {
    for (const map of registry.owned) {
      for (const window of map.keys()) {
        const type = (window as { constructor?: { getAllWindows?: unknown; getFocusedWindow?: unknown } }).constructor;
        if (typeof type?.getAllWindows === "function" && typeof type.getFocusedWindow === "function") {
          return type as { getAllWindows(): AnyWindow[]; getFocusedWindow(): AnyWindow | null };
        }
      }
    }
    return undefined;
  };
  const ownerOf = (window: AnyWindow): ReadonlyMap<object, unknown> | undefined =>
    [...registry.owned].find((map) => map.has(window));
  /** Decided once per quit, by the first guard that sees it, so every guard acts on the same vault. */
  const scopeOf = (event: GuardEvent): QuitScope => {
    const known = registry.quits.get(event);
    if (known) return known;
    let scope: QuitScope = {};
    try {
      const focused = windowClass()?.getFocusedWindow() ?? undefined;
      if (focused && !focused.isDestroyed()) scope = { focused, owner: ownerOf(focused) };
    } catch (error) {
      record(`app quit: unable to find the focused window: ${String(error)}`);
    }
    registry.quits.set(event, scope);
    return scope;
  };
  const targetsThisVault = (scope: QuitScope): boolean => !scope.focused || scope.owner === windows;

  const beforeQuit = (event: GuardEvent): void => {
    lastQuit = event;
    lastScope = scopeOf(event);
    if (allowsEverything()) return record("app quit allowed: vault is exiting");
    if (!options.keepRunningAfterQuit) return record("app quit allowed");
    // A vault that keeps running must survive every user quit, so the app quit is always cancelled.
    // Only the vault the quit was for reacts; the other vaults stay as they are.
    event.preventDefault();
    if (targetsThisVault(lastScope)) {
      for (const window of windows.keys()) hide(window);
      record("app quit turned into hide");
    } else {
      record("app quit was for another vault: this vault left as it is");
    }
    closeUnownedWindows(event, lastScope);
    // Obsidian marks itself quitting on every before-quit and clears the mark only in its own activate
    // listener, registered first at startup. A cancelled quit must clear it, or Obsidian treats the next
    // reload as a quit. Renderer listeners from `remote` are skipped: they would show hidden vaults.
    const [first] = app.listeners("activate");
    if (first && first.name !== "callIntoRenderer") first();
  };
  // Windows of vaults without Run in Background asked to quit, but the app quit is cancelled, so close
  // them: only the focused one, or all of them when no window was focused (Quit from the Dock).
  // A vault whose plugin is on closes itself (main.ts), which also removes its tray icon.
  const closeUnownedWindows = (event: GuardEvent, scope: QuitScope): void => {
    if (registry.closedUnowned.has(event)) return;
    registry.closedUnowned.add(event);
    try {
      const candidates = scope.focused ? [scope.focused] : windowClass()?.getAllWindows() ?? [];
      const unowned = candidates.filter((window) => !window.isDestroyed() && !ownerOf(window));
      if (unowned.length === 0) return;
      record(`app quit: closing ${unowned.length} window(s) of vaults that do not run in background`);
      setTimeout(() => {
        for (const window of unowned) {
          try {
            if (!window.isDestroyed()) window.close();
          } catch (error) {
            record(`app quit: a window did not close: ${String(error)}`);
          }
        }
      }, 0);
    } catch (error) {
      // An error here must never reach Electron's main-process error dialog.
      record(`app quit: unable to close other vault windows: ${String(error)}`);
    }
  };
  const beforeUpdate = (): void => {
    relaunching = true;
    record("update install: quit allowed");
  };

  const ownsRelaunch = Object.prototype.hasOwnProperty.call(app, "relaunch");
  const relaunch = app.relaunch;
  const wrappedRelaunch = function (this: unknown, ...args: unknown[]): void {
    if (!disposed) {
      relaunching = true;
      record("relaunch: quit allowed");
    }
    relaunch.apply(this, args);
  };
  app.relaunch = wrappedRelaunch;

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    for (const window of [...windows.keys()]) untrack(window);
    releaseFocusHooks();
    registry.owned.delete(windows);
    app.removeListener("before-quit", beforeQuit);
    powerMonitor?.removeListener("shutdown", stop);
    autoUpdater?.removeListener("before-quit-for-update", beforeUpdate);
    owner.removeListener("destroyed", dispose);
    owner.removeListener("render-process-gone", dispose);
    // Another guard may have wrapped this one; a disposed wrapper only forwards the call.
    if (app.relaunch === wrappedRelaunch) {
      if (ownsRelaunch) app.relaunch = relaunch;
      else delete (app as Partial<GuardApp>).relaunch;
    }
  };

  app.on("before-quit", beforeQuit);
  powerMonitor?.on("shutdown", stop);
  autoUpdater?.on("before-quit-for-update", beforeUpdate);
  owner.on("destroyed", dispose);
  owner.on("render-process-gone", dispose);

  return {
    configure(next: CloseGuardOptions): void {
      options = { ...next };
    },
    track,
    revealOnFocus,
    exit(): void {
      exiting = true;
    },
    quitProceeding,
    quitTargetsThisVault: () => targetsThisVault(lastScope),
    takeLog(): string[] {
      return log.splice(0);
    },
    dispose,
  };
}
