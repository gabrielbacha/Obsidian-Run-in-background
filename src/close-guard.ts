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

export interface CloseGuardHost {
  app: GuardApp;
  /** Electron's BrowserWindow, to find the windows that no guard owns. */
  windows?: { getAllWindows(): AnyWindow[] };
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
  const { app, owner, powerMonitor, autoUpdater, windows: allWindows } = host;
  let options = { ...initial };
  let exiting = false;
  let relaunching = false;
  let disposed = false;
  let lastQuit: GuardEvent | undefined;
  const log: string[] = [];
  const windows = new Map<GuardWindow, { close: (event: GuardEvent) => void; closed: () => void }>();
  // Every guard in the main process registers its windows here, so a guard that cancels a quit can tell
  // which windows belong to a vault that keeps running.
  const registryKey = Symbol.for("run-in-background.close-guards");
  const shared = app as unknown as Record<symbol, { owned: Set<ReadonlyMap<object, unknown>>; quits: WeakSet<object> } | undefined>;
  const registry = shared[registryKey] ??= { owned: new Set(), quits: new WeakSet() };
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
  const beforeQuit = (event: GuardEvent): void => {
    lastQuit = event;
    if (allowsEverything()) return record("app quit allowed: vault is exiting");
    if (!options.keepRunningAfterQuit) return record("app quit allowed");
    event.preventDefault();
    for (const window of windows.keys()) hide(window);
    closeUnownedWindows(event);
    // Obsidian marks itself quitting on every before-quit and clears the mark only in its own activate
    // listener, registered first at startup. A cancelled quit must clear it, or Obsidian treats the next
    // reload as a quit. Renderer listeners from `remote` are skipped: they would show hidden vaults.
    const [first] = app.listeners("activate");
    if (first && first.name !== "callIntoRenderer") first();
    record("app quit turned into hide");
  };
  // The quit is cancelled for the whole app. Windows of vaults without Run in Background asked to quit,
  // so close them. A vault whose plugin is on closes itself (main.ts), which also removes its tray icon.
  const closeUnownedWindows = (event: GuardEvent): void => {
    if (!allWindows || registry.quits.has(event)) return;
    registry.quits.add(event);
    const owned = (window: AnyWindow): boolean => [...registry.owned].some((map) => map.has(window));
    const unowned = allWindows.getAllWindows().filter((window) => !window.isDestroyed() && !owned(window));
    if (unowned.length === 0) return;
    record(`app quit: closing ${unowned.length} window(s) of vaults that do not run in background`);
    setTimeout(() => {
      for (const window of unowned) {
        if (!window.isDestroyed()) window.close();
      }
    }, 0);
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
    takeLog(): string[] {
      return log.splice(0);
    },
    dispose,
  };
}
