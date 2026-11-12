import type { TraySettings } from "./settings";
export interface TraySettingDefinition {
  key: keyof TraySettings;
  name: string;
  desc: string;
  kind: "toggle" | "dropdown" | "icon" | "badge";
}
/** Both Obsidian UI entry paths render this one definition. */
export function traySettingDefinitions(platform: NodeJS.Platform): TraySettingDefinition[] {
  return [
    { key: "pluginEnabled", name: "Enable Run in Background", desc: "Turn off all background, tray, startup, Dock/taskbar, close and Quit behavior while keeping this settings page available.", kind: "toggle" },
    { key: "launchOnStartup", name: "Launch on startup", desc: "Open Obsidian when you log in. A failed update keeps the previous registration and can be retried.", kind: "toggle" },
    { key: "hideOnLaunchMode", name: "Hide on launch", desc: "Start hidden always, only at device login, or never.", kind: "dropdown" },
    { key: "runInBackground", name: "Run in background", desc: "Hide an ordinary window close instead of closing the vault.", kind: "toggle" },
    { key: "keepRunningAfterQuit", name: "Keep running after Quit command", desc: "Make Cmd+Q or normal Quit hide this vault. System shutdown still exits.", kind: "toggle" },
    { key: "hideTaskbarIcon", name: platform === "darwin" ? "Hide Dock icon" : "Hide taskbar icon", desc: "Hide the app icon only while a usable tray provides a way back. macOS keeps the Dock visible if any active vault needs it.", kind: "toggle" },
    { key: "createTrayIcon", name: "Create tray icon", desc: "Create a vault-specific tray or menu-bar icon.", kind: "toggle" },
    { key: "trayIconImage", name: "Tray icon image", desc: "Choose a preset or a local PNG/SVG up to 256 KiB and 2048×2048 pixels. Uploads are saved as a small 64×64 PNG.", kind: "icon" },
    { key: "vaultBadge", name: "Vault badge", desc: "Up to three letters, numbers, emoji or symbols, with optional spaces. Leave blank for no badge.", kind: "badge" },
  ];
}
