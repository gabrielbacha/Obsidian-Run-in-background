export type TrayMenuAction = "show" | "hide" | "openSettings" | "relaunch" | "closeVault";
export interface TrayMenuRow { id: number; label?: string; enabled: boolean; separator?: boolean; action?: TrayMenuAction }
export function trayMenuRows(vault: string): TrayMenuRow[] {
  return [
    { id: 1, label: `Vault: ${vault}`, enabled: false },
    { id: 2, enabled: false, separator: true },
    { id: 3, label: "Show Vault", enabled: true, action: "show" },
    { id: 4, label: "Hide Vault", enabled: true, action: "hide" },
    { id: 5, label: "Open Plugin Settings", enabled: true, action: "openSettings" },
    { id: 6, enabled: false, separator: true },
    { id: 7, label: "Relaunch Obsidian", enabled: true, action: "relaunch" },
    { id: 8, label: "Close Vault", enabled: true, action: "closeVault" },
  ];
}
