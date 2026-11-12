interface CoordinatorOwner {
  on(event: string, listener: () => void): unknown;
  removeListener(event: string, listener: () => void): unknown;
}
interface CoordinatorApp { dock?: { hide(): void; show(): void | Promise<void> } }
export interface AppCoordinator {
  updateDock(hide: boolean, recoveryTray: boolean): Promise<void>;
  facts(): { pid: number; sessionId: string };
  release(): void;
}

/** Compiled in the main process. It must use only its arguments and function body. */
export function installAppCoordinator(app: CoordinatorApp, owner: CoordinatorOwner): AppCoordinator {
  const key = Symbol.for("run-in-background.app-coordinator.v1");
  interface State {
    requests: Map<CoordinatorOwner, { hide: boolean; recoveryTray: boolean }>;
    revision: number;
    appliedHide?: boolean;
    queue: Promise<void>;
    facts: { pid: number; sessionId: string };
  }
  const shared = app as unknown as Record<symbol, State | undefined>;
  const state: State = shared[key] ??= {
    requests: new Map(), revision: 0, queue: Promise.resolve(),
    facts: { pid: process.pid, sessionId: `${process.pid}:${Date.now()}` },
  };
  let released = false;
  const reconcile = (): Promise<void> => {
    state.queue = state.queue.then(async () => {
      while (true) {
        const revision = state.revision;
        const hide = state.requests.size > 0 && [...state.requests.values()].every((request) => request.hide && request.recoveryTray);
        if (hide !== state.appliedHide) {
          if (hide) app.dock?.hide();
          else await app.dock?.show();
          state.appliedHide = hide;
        }
        if (state.revision === revision) return;
      }
    }).catch((error: unknown) => { console.warn("Run in Background: Dock recovery update failed", error); });
    return state.queue;
  };
  const release = (): void => {
    if (released) return;
    released = true;
    state.requests.delete(owner);
    state.revision++;
    owner.removeListener("destroyed", release);
    owner.removeListener("render-process-gone", release);
    void reconcile();
  };
  owner.on("destroyed", release);
  owner.on("render-process-gone", release);
  return {
    updateDock(hide, recoveryTray): Promise<void> {
      if (released) return Promise.resolve();
      state.requests.set(owner, { hide, recoveryTray }); state.revision++;
      return reconcile();
    },
    facts: () => ({ ...state.facts }),
    release,
  };
}
