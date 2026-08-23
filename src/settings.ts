import { TRAY_ICON_PRESETS } from "./icon";

const LEGACY_OBSIDIAN_ICON_PREFIX = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9h";
const LEGACY_REDRAWN_OBSIDIAN_MARKER = "%3ClinearGradient%20id%3D%22o%22";

export interface TraySettings {
  pluginEnabled: boolean;
  launchOnStartup: boolean;
  hideOnLaunch: boolean;
  runInBackground: boolean;
  keepRunningAfterQuit: boolean;
  hideTaskbarIcon: boolean;
  createTrayIcon: boolean;
  trayIconImage: string;
  vaultBadge: string;
  badgeBackgroundColor: string;
}

export function normalizeVaultBadge(value: string): string {
  const segments = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value.trim())]
    .map(({ segment }) => segment);
  const normalized: string[] = [];
  let visibleCharacters = 0;
  let pendingSpace = false;
  for (const segment of segments) {
    if (/^\s+$/u.test(segment)) {
      if (visibleCharacters > 0 && visibleCharacters < 2) pendingSpace = true;
      continue;
    }
    if (visibleCharacters >= 2) break;
    if (pendingSpace) normalized.push(" ");
    normalized.push(segment.toLocaleUpperCase());
    visibleCharacters += 1;
    pendingSpace = false;
  }
  return normalized.join("");
}

export function normalizeBadgeColor(value: string): string {
  return /^#[0-9a-f]{6}$/iu.test(value) ? value.toLowerCase() : "#141418";
}

export function deriveVaultBadge(vaultName: string): string {
  const words = vaultName.trim().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (words.length === 0) return "V";
  if (words.length === 1) return normalizeVaultBadge(words[0]!.slice(0, 1)) || "V";
  return normalizeVaultBadge(words.slice(0, 2).map((word) => word[0]!).join("")) || "V";
}

export function defaultSettings(vaultName: string): TraySettings {
  return {
    pluginEnabled: true,
    launchOnStartup: false,
    hideOnLaunch: true,
    runInBackground: true,
    keepRunningAfterQuit: true,
    hideTaskbarIcon: false,
    createTrayIcon: true,
    trayIconImage: "",
    vaultBadge: deriveVaultBadge(vaultName),
    badgeBackgroundColor: "#141418",
  };
}

export function reconcileRecoveryPath(
  settings: TraySettings,
  changed: "hideTaskbarIcon" | "createTrayIcon",
): void {
  if (changed === "hideTaskbarIcon" && settings.hideTaskbarIcon) settings.createTrayIcon = true;
  if (changed === "createTrayIcon" && !settings.createTrayIcon) settings.hideTaskbarIcon = false;
}

export function migrateSettings(input: unknown, vaultName: string): TraySettings {
  const source = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const defaults = defaultSettings(vaultName);
  const boolean = (key: keyof TraySettings): boolean =>
    typeof source[key] === "boolean" ? source[key] : defaults[key] as boolean;
  const string = (key: keyof TraySettings): string =>
    typeof source[key] === "string" ? source[key] : defaults[key] as string;
  const storedTrayIcon = string("trayIconImage");
  const settings: TraySettings = {
    pluginEnabled: boolean("pluginEnabled"),
    launchOnStartup: boolean("launchOnStartup"),
    hideOnLaunch: boolean("hideOnLaunch"),
    runInBackground: boolean("runInBackground"),
    keepRunningAfterQuit: boolean("keepRunningAfterQuit"),
    hideTaskbarIcon: boolean("hideTaskbarIcon"),
    createTrayIcon: boolean("createTrayIcon"),
    trayIconImage: storedTrayIcon.startsWith(LEGACY_OBSIDIAN_ICON_PREFIX)
      || storedTrayIcon.includes(LEGACY_REDRAWN_OBSIDIAN_MARKER)
      ? TRAY_ICON_PRESETS[0].dataUrl
      : storedTrayIcon,
    vaultBadge: typeof source.vaultBadge === "string" ? normalizeVaultBadge(source.vaultBadge) : defaults.vaultBadge,
    badgeBackgroundColor: typeof source.badgeBackgroundColor === "string"
      ? normalizeBadgeColor(source.badgeBackgroundColor)
      : defaults.badgeBackgroundColor,
  };
  reconcileRecoveryPath(settings, "hideTaskbarIcon");
  return settings;
}
