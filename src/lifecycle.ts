export type ExitIntent =
  | "none"
  | "user-quit"
  | "explicit-quit"
  | "relaunch"
  | "system-shutdown"
  | "plugin-unload";

export type UserQuitDecision = "hide" | "exit";

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
