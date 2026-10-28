export type ExitIntent =
  | "none"
  | "user-quit"
  | "explicit-quit"
  | "relaunch"
  | "system-shutdown"
  | "plugin-unload";

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

/**
 * A second launch restores hidden vaults only when the user starts Obsidian again. The Obsidian CLI
 * also starts the app binary, and Electron reports that as a second instance with the CLI arguments
 * (`vault=...`, `help`, `eval`), so any argument other than a Chromium switch means "not a relaunch".
 * The same is true for an `obsidian://` link or a file path, which Obsidian routes to one vault itself.
 */
export function isPlainRelaunch(commandLine: readonly string[]): boolean {
  const [executable = "", ...rest] = commandLine;
  const args = executable.toLowerCase().includes("electron") ? rest.slice(1) : rest;
  return args.every((argument) => argument.startsWith("-"));
}

/** Added to the launch command of the Windows login item and the Linux autostart entry. */
export const LOGIN_MARKER = "--run-in-background-login";

export function isLoginLaunch(argv: readonly string[]): boolean {
  return argv.includes(LOGIN_MARKER);
}

/** A process opened at login stays "opened at login" all day; only vaults that load soon after count. */
export const LOGIN_LAUNCH_WINDOW_SECONDS = 120;

export interface LaunchFacts {
  platform: NodeJS.Platform;
  /** macOS: `app.getLoginItemSettings().wasOpenedAtLogin`. */
  macOpenedAtLogin: boolean;
  /** Launch arguments of the Obsidian process. */
  argv: readonly string[];
  /** Seconds since the Obsidian main process started. */
  uptimeSeconds: number;
}

export function wasLaunchedAtLogin(facts: LaunchFacts): boolean {
  if (facts.uptimeSeconds > LOGIN_LAUNCH_WINDOW_SECONDS) return false;
  return facts.platform === "darwin" ? facts.macOpenedAtLogin : isLoginLaunch(facts.argv);
}

/** How long after a second launch a new window counts as the vault chooser that the launch opened. */
export const SECOND_INSTANCE_SUPPRESSION_MS = 4_000;

export class QuitLifecycle {
  private currentIntent: ExitIntent = "none";

  beginExit(intent: Exclude<ExitIntent, "none">): void {
    this.currentIntent = intent;
  }

  shouldRestoreOnActivation(): boolean {
    return this.currentIntent === "none";
  }

  shouldSuppressTransientWindow(lastSecondInstanceAt: number, now: number): boolean {
    return this.currentIntent === "none" && lastSecondInstanceAt > 0 && now - lastSecondInstanceAt < SECOND_INSTANCE_SUPPRESSION_MS;
  }

  get intent(): ExitIntent {
    return this.currentIntent;
  }
}
