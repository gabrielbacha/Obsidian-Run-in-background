import { resolve } from "node:path";

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

/**
 * Obsidian's vault chooser and vault switcher send `vault-open` with a folder path. For a vault that is
 * already running, Obsidian's main process only restores a minimized window and focuses it, which does
 * not show a hidden window. `create` is set when the chooser makes a new vault, which is never this one.
 */
export function isOpenRequestForVault(requestedPath: unknown, create: unknown, vaultPath: string): boolean {
  if (create || typeof requestedPath !== "string" || requestedPath === "" || vaultPath === "") return false;
  return resolve(requestedPath) === resolve(vaultPath);
}

export class QuitLifecycle {
  private currentIntent: ExitIntent = "none";

  beginExit(intent: Exclude<ExitIntent, "none">): void {
    this.currentIntent = intent;
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
