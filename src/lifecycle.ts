export type ExitIntent =
  | "none"
  | "user-quit"
  | "explicit-quit"
  | "relaunch"
  | "system-shutdown"
  | "plugin-unload";

export type UserQuitDecision = "hide" | "exit";

export interface WindowIdentity {
  owned: boolean;
  destroyed: boolean;
  title: string;
  appName: string;
  url: string;
}

export function isOtherVaultWindow(window: WindowIdentity): boolean {
  if (window.owned || window.destroyed) return false;
  return window.url.startsWith("app://obsidian.md") && window.title.trim() !== "" && window.title !== window.appName;
}

export function backgroundThrottlingFor(runInBackground: boolean, originalValue: boolean): boolean {
  return runInBackground ? false : originalValue;
}

export class QuitLifecycle {
  private currentIntent: ExitIntent = "none";

  requestUserQuit(keepRunningAfterQuit: boolean): UserQuitDecision {
    if (this.currentIntent !== "none") return "exit";
    if (keepRunningAfterQuit) return "hide";
    this.currentIntent = "user-quit";
    return "exit";
  }

  beginExit(intent: Exclude<ExitIntent, "none">): void {
    this.currentIntent = intent;
  }

  shouldInterceptClose(runInBackground: boolean): boolean {
    return runInBackground && this.currentIntent === "none";
  }

  shouldRestoreOnActivation(): boolean {
    return this.currentIntent === "none";
  }

  shouldSuppressTransientWindow(lastSecondInstanceAt: number, now: number): boolean {
    return this.currentIntent === "none" && lastSecondInstanceAt > 0 && now - lastSecondInstanceAt < 4_000;
  }

  get intent(): ExitIntent {
    return this.currentIntent;
  }
}
