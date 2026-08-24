import type { App as ElectronApp, BrowserWindow, Menu, nativeImage, PowerMonitor, Tray, Event as ElectronEvent, WindowSessionEndEvent } from "electron";

export interface ElectronRemote {
  BrowserWindow: typeof BrowserWindow;
  app: ElectronApp;
  powerMonitor?: PowerMonitor;
  nativeImage: typeof nativeImage;
  Tray: typeof Tray;
  Menu: typeof Menu;
  getCurrentWindow(): BrowserWindow;
}

export interface ElectronExports {
  remote: ElectronRemote;
}

export interface WindowListeners {
  close: (event: ElectronEvent) => void;
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
