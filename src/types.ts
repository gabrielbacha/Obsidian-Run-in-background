import type { App as ElectronApp, AutoUpdater, BrowserWindow, IpcMain, Menu, nativeImage, PowerMonitor, Tray, WindowSessionEndEvent } from "electron";

export interface ElectronRemote {
  BrowserWindow: typeof BrowserWindow;
  app: ElectronApp;
  powerMonitor?: PowerMonitor;
  ipcMain?: IpcMain;
  autoUpdater?: AutoUpdater;
  nativeImage: typeof nativeImage;
  Tray: typeof Tray;
  Menu: typeof Menu;
  getCurrentWindow(): BrowserWindow;
  require(module: "vm"): typeof import("node:vm");
}

export interface ElectronExports {
  remote: ElectronRemote;
}

export interface WindowListeners {
  close: () => void;
  closed: () => void;
  maximize: () => void;
  unmaximize: () => void;
  focus?: () => void;
  sessionEnd?: (event: WindowSessionEndEvent) => void;
}

export interface ObsidianSettingsModal {
  open(): void;
  openTabById(id: string): unknown;
}

export interface AppWithSettingModal {
  setting: ObsidianSettingsModal;
}
