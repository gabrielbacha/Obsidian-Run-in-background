import { FileSystemAdapter, normalizePath, Notice, Plugin, PluginSettingTab, Setting, type App as ObsidianApp, type SettingDefinitionItem } from "obsidian";
import { ABOUT_AND_FEEDBACK, BUG_REPORT_URL, FEATURE_REQUEST_URL, WEBSITE_URL } from "./external-links";
import { spawn } from "node:child_process";
import type { BrowserWindow, Event as ElectronEvent, MenuItemConstructorOptions, Tray, WebContents } from "electron";
import { composeTrayIcon, TRAY_ICON_PRESETS } from "./icon";
import { backgroundThrottlingFor, isOtherVaultWindow, QuitLifecycle, type ExitIntent } from "./lifecycle";
import { isLinuxLoginLaunch, LinuxAutostartManager } from "./linux-autostart";
import { LinuxStatusNotifierTray } from "./linux-tray";
import { defaultSettings, migrateSettings, normalizeVaultBadge, reconcileRecoveryPath, shouldHideOnLaunch, type TraySettings } from "./settings";
import type { AppWithSettingModal, ElectronExports, ElectronRemote, WindowListeners } from "./types";

interface WindowWithElectron extends Window {
  require(module: "electron"): ElectronExports;
}

const electron = (window as unknown as WindowWithElectron).require("electron");
const remote: ElectronRemote = electron.remote;

export default class RunInBackgroundPlugin extends Plugin {
  override settings: TraySettings = defaultSettings("");
  trayPreviewDataUrl = "";
  private lifecycle = new QuitLifecycle();
  private windows = new Set<BrowserWindow>();
  private maximized = new Set<BrowserWindow>();
  private listeners = new Map<BrowserWindow, WindowListeners>();
  private backgroundThrottling = new Map<WebContents, boolean>();
  private tray?: Tray;
  private linuxTray?: LinuxStatusNotifierTray;
  private settingsTab?: TraySettingsTab;
  private rootWindow?: BrowserWindow;
  private cleaned = false;
  private closeInterceptorsReleased = false;
  private runtimeActive = false;
  private commandsRegistered = false;
  private lastSecondInstanceAt = 0;
  private linuxAutostart?: LinuxAutostartManager;

  private beforeUnload = (event: BeforeUnloadEvent): void => {
    if (!this.lifecycle.shouldInterceptClose(this.settings.runInBackground)) return;
    event.preventDefault();
    event.returnValue = "";
    remote.getCurrentWindow().hide();
  };

  private beforeQuit = (event: ElectronEvent): void => {
    if (this.lifecycle.intent !== "none") {
      this.releaseCloseInterceptors();
      this.cleanup();
      return;
    }
    if (this.lifecycle.requestUserQuit(this.settings.keepRunningAfterQuit) === "hide") {
      event.preventDefault();
      this.hideWindows(true);
      return;
    }
    this.releaseCloseInterceptors();
    this.cleanup();
  };

  private systemShutdown = (): void => {
    this.beginExit("system-shutdown");
    this.cleanup();
  };
  private appActivated = (): void => {
    if (this.lifecycle.shouldRestoreOnActivation()) this.showWindows();
  };
  private secondInstance = (_event: ElectronEvent, commandLine: string[]): void => {
    this.lastSecondInstanceAt = Date.now();
    if (process.platform === "linux"
      && isLinuxLoginLaunch(commandLine)
      && this.settings.launchOnStartup
      && shouldHideOnLaunch(this.settings.hideOnLaunchMode, true)) {
      this.hideWindows(true);
      return;
    }
    this.appActivated();
  };
  private browserWindowCreated = (_event: ElectronEvent, createdWindow: BrowserWindow): void => {
    if (!this.lifecycle.shouldSuppressTransientWindow(this.lastSecondInstanceAt, Date.now())) return;
    if (this.windows.has(createdWindow)) return;
    const hidePicker = (): void => {
      if (createdWindow.isDestroyed()) return;
      createdWindow.hide();
      createdWindow.setSkipTaskbar(true);
    };
    createdWindow.on("ready-to-show", hidePicker);
    createdWindow.on("show", hidePicker);
    window.setTimeout(hidePicker, 0);
    window.setTimeout(() => {
      hidePicker();
      this.appActivated();
    }, 150);
  };
  private windowCreated = (createdWindow: BrowserWindow): void => this.track(createdWindow);

  override async onload(): Promise<void> {
    await this.loadSettings();
    this.settingsTab = new TraySettingsTab(this.app, this);
    this.addSettingTab(this.settingsTab);
    if (this.settings.pluginEnabled) await this.activateRuntime(true);
    else {
      await this.updateLogin();
      this.updateTaskbar();
      await this.createTray();
    }
  }

  private async activateRuntime(applyHideOnLaunch: boolean): Promise<void> {
    if (this.runtimeActive) return;
    this.runtimeActive = true;
    this.lifecycle = new QuitLifecycle();
    this.cleaned = false;
    this.closeInterceptorsReleased = false;
    const current = remote.getCurrentWindow();
    this.rootWindow = current;
    this.track(current);
    current.webContents.on("did-create-window", this.windowCreated);
    window.addEventListener("beforeunload", this.beforeUnload);
    remote.app.on("before-quit", this.beforeQuit);
    remote.app.on("activate", this.appActivated);
    remote.app.prependListener("second-instance", this.secondInstance);
    remote.app.on("browser-window-created", this.browserWindowCreated);
    remote.powerMonitor?.on("shutdown", this.systemShutdown);
    await this.createTray();
    await this.updateLogin();
    this.updateTaskbar();
    const wasOpenedAtLogin = process.platform === "linux"
      ? isLinuxLoginLaunch(process.argv)
      : Boolean(remote.app.getLoginItemSettings().wasOpenedAtLogin);
    if (applyHideOnLaunch && shouldHideOnLaunch(this.settings.hideOnLaunchMode, wasOpenedAtLogin)) {
      this.app.workspace.onLayoutReady(() => {
        if (this.runtimeActive && this.settings.pluginEnabled) this.hideWindows();
      });
    }
    this.registerRuntimeCommands();
  }

  private registerRuntimeCommands(): void {
    if (this.commandsRegistered) return;
    this.addCommand({ id: "relaunch-app", name: "Relaunch Obsidian", callback: () => this.relaunch() });
    this.addCommand({ id: "close-vault", name: "Close Vault", callback: () => this.closeVault() });
    this.commandsRegistered = true;
  }

  private unregisterRuntimeCommands(): void {
    if (!this.commandsRegistered) return;
    this.removeCommand("relaunch-app");
    this.removeCommand("close-vault");
    this.commandsRegistered = false;
  }

  async setPluginEnabled(enabled: boolean): Promise<void> {
    if (this.settings.pluginEnabled === enabled && this.runtimeActive === enabled) return;
    this.settings.pluginEnabled = enabled;
    await this.saveSettings();
    if (enabled) await this.activateRuntime(false);
    else {
      this.beginExit("plugin-unload");
      this.cleanup();
      await this.updateLogin();
    }
  }

  override onunload(): void {
    const disabledWhileRunning = this.lifecycle.intent === "none" && !this.cleaned;
    this.beginExit("plugin-unload");
    this.cleanup();
    if (disabledWhileRunning) void this.updateLogin();
  }

  private safely(action: () => void): void {
    try {
      action();
    } catch (error) {
      console.warn("Run in Background: cleanup step failed", error);
    }
  }

  private beginExit(intent: Exclude<ExitIntent, "none">): void {
    this.lifecycle.beginExit(intent);
    this.releaseCloseInterceptors();
  }

  private releaseCloseInterceptors(): void {
    if (this.closeInterceptorsReleased) return;
    this.closeInterceptorsReleased = true;
    this.safely(() => window.removeEventListener("beforeunload", this.beforeUnload));
    for (const [trackedWindow, listeners] of this.listeners) {
      this.safely(() => trackedWindow.removeListener("close", listeners.close));
    }
  }

  private track(trackedWindow: BrowserWindow): void {
    if (this.windows.has(trackedWindow)) return;
    this.windows.add(trackedWindow);
    const contents = trackedWindow.webContents;
    const originalThrottling = this.backgroundThrottling.get(contents) ?? contents.getBackgroundThrottling();
    this.backgroundThrottling.set(contents, originalThrottling);
    contents.setBackgroundThrottling(backgroundThrottlingFor(this.settings.runInBackground, originalThrottling));
    if (trackedWindow.isMaximized()) this.maximized.add(trackedWindow);
    trackedWindow.setSkipTaskbar(this.settings.hideTaskbarIcon);
    const listeners: WindowListeners = {
      close: (event) => {
        if (!this.lifecycle.shouldInterceptClose(this.settings.runInBackground)) return;
        event.preventDefault();
        trackedWindow.hide();
      },
      closed: () => this.untrack(trackedWindow),
      maximize: () => this.maximized.add(trackedWindow),
      unmaximize: () => this.maximized.delete(trackedWindow),
    };
    if (process.platform === "darwin") {
      listeners.focus = () => {
        if (this.settings.hideTaskbarIcon) remote.app.dock?.hide();
      };
    }
    if (process.platform === "win32") {
      listeners.sessionEnd = () => this.systemShutdown();
    }
    trackedWindow.on("close", listeners.close);
    trackedWindow.on("closed", listeners.closed);
    trackedWindow.on("maximize", listeners.maximize);
    trackedWindow.on("unmaximize", listeners.unmaximize);
    if (listeners.focus) trackedWindow.on("focus", listeners.focus);
    if (listeners.sessionEnd) trackedWindow.on("session-end", listeners.sessionEnd);
    this.listeners.set(trackedWindow, listeners);
  }

  private untrack(trackedWindow: BrowserWindow): void {
    const listeners = this.listeners.get(trackedWindow);
    if (listeners) {
      this.safely(() => trackedWindow.removeListener("close", listeners.close));
      this.safely(() => trackedWindow.removeListener("closed", listeners.closed));
      this.safely(() => trackedWindow.removeListener("maximize", listeners.maximize));
      this.safely(() => trackedWindow.removeListener("unmaximize", listeners.unmaximize));
      if (listeners.focus) {
        const focusListener = listeners.focus;
        this.safely(() => trackedWindow.removeListener("focus", focusListener));
      }
      if (listeners.sessionEnd) {
        const sessionEndListener = listeners.sessionEnd;
        this.safely(() => trackedWindow.removeListener("session-end", sessionEndListener));
      }
    }
    this.listeners.delete(trackedWindow);
    this.windows.delete(trackedWindow);
    this.maximized.delete(trackedWindow);
  }

  showWindows(): void {
    for (const trackedWindow of this.windows) {
      trackedWindow.show();
      if (this.maximized.has(trackedWindow)) trackedWindow.maximize();
      trackedWindow.focus();
    }
  }

  hideWindows(forceHide = false): void {
    for (const trackedWindow of this.windows) {
      if (trackedWindow.isFocused()) trackedWindow.blur();
      if (forceHide || this.settings.runInBackground) trackedWindow.hide();
      else trackedWindow.minimize();
    }
  }

  toggleWindows(): void {
    if ([...this.windows].some((trackedWindow) => trackedWindow.isVisible())) this.hideWindows();
    else this.showWindows();
  }

  updateBackgroundMode(): void {
    for (const [contents, originalThrottling] of this.backgroundThrottling) {
      if (!contents.isDestroyed()) {
        contents.setBackgroundThrottling(backgroundThrottlingFor(this.settings.runInBackground, originalThrottling));
      }
    }
  }

  async updateLogin(): Promise<void> {
    const enabled = this.runtimeActive && this.settings.launchOnStartup;
    if (process.platform === "linux") {
      try {
        this.linuxAutostart ??= new LinuxAutostartManager(this.vaultPath(), this.app.vault.getName());
        const activeVaults = await this.linuxAutostart.setEnabled(enabled);
        const primaryVault = activeVaults[0];
        // Electron does not consistently expose main-process launch arguments to
        // Obsidian's renderer on Linux. The shared launcher always opens the
        // deterministic primary vault, so let only that vault coordinate once.
        if (enabled
          && primaryVault?.vaultPath === this.vaultPath()
          && await this.linuxAutostart.claimStartupBootstrap()) {
          for (const command of this.linuxAutostart.startupCommands(activeVaults, this.app.vault.getName())) {
            const child = spawn(command[0]!, command.slice(1), { detached: true, stdio: "ignore" });
            child.once("error", (error) => {
              console.error("Run in Background: unable to open startup vault", error);
            });
            child.unref();
          }
        }
      } catch (error) {
        console.error("Run in Background: unable to update Linux autostart", error);
        if (enabled) {
          this.settings.launchOnStartup = false;
          await this.saveSettings();
          new Notice("Run in Background could not enable launch on startup. Check the console for details.");
        }
      }
      return;
    }
    remote.app.setLoginItemSettings({
      openAtLogin: enabled,
      openAsHidden: this.runtimeActive
        && this.settings.runInBackground
        && this.settings.hideOnLaunchMode !== "never",
    });
  }

  private vaultPath(): string {
    return this.app.vault.adapter instanceof FileSystemAdapter
      ? this.app.vault.adapter.getBasePath()
      : this.app.vault.getName();
  }

  updateTaskbar(): void {
    if (!this.runtimeActive) {
      if (process.platform === "darwin") void remote.app.dock?.show();
      return;
    }
    for (const trackedWindow of this.windows) trackedWindow.setSkipTaskbar(this.settings.hideTaskbarIcon);
    if (process.platform !== "darwin") return;
    if (this.settings.hideTaskbarIcon) remote.app.dock?.hide();
    else void remote.app.dock?.show();
  }

  async createTray(): Promise<void> {
    this.safely(() => this.tray?.destroy());
    this.tray = undefined;
    this.linuxTray?.destroy();
    this.linuxTray = undefined;
    if (!this.settings.trayIconImage) {
      this.settings.trayIconImage = TRAY_ICON_PRESETS[0].dataUrl;
      await this.saveSettings();
    }
    const composed = await composeTrayIcon(
      this.settings.trayIconImage,
      this.settings.vaultBadge,
      this.settings.badgeBackgroundColor,
    );
    this.trayPreviewDataUrl = composed.previewDataUrl;
    this.settingsTab?.updatePreview(composed.previewDataUrl);
    if (!this.runtimeActive || !this.settings.createTrayIcon) return;
    const vault = this.app.vault.getName();
    if (process.platform === "linux") {
      this.linuxTray = new LinuxStatusNotifierTray(vault, composed.pixmaps, {
        show: () => this.showWindows(),
        hide: () => this.hideWindows(),
        toggle: () => this.toggleWindows(),
        openSettings: () => this.openSettings(),
        relaunch: () => this.relaunch(),
        closeVault: () => window.setTimeout(() => this.closeVault(), 0),
      });
      await this.linuxTray.create();
      return;
    }
    const nativeIcon = remote.nativeImage.createEmpty();
    for (const representation of composed.representations) nativeIcon.addRepresentation(representation);
    const menu: MenuItemConstructorOptions[] = [
      { label: `Vault: ${vault}`, enabled: false },
      { type: "separator" },
      { label: "Show Vault", click: () => this.showWindows() },
      { label: "Hide Vault", click: () => this.hideWindows() },
      { label: "Open Plugin Settings", click: () => this.openSettings() },
      { type: "separator" },
      { label: "Relaunch Obsidian", click: () => this.relaunch() },
      { label: "Close Vault", click: () => window.setTimeout(() => this.closeVault(), 0) },
    ];
    this.tray = new remote.Tray(nativeIcon);
    this.tray.setContextMenu(remote.Menu.buildFromTemplate(menu));
    this.tray.setToolTip(`Vault: ${vault}`);
    this.tray.on("click", () => process.platform === "darwin" ? this.tray?.popUpContextMenu() : this.toggleWindows());
  }

  private openSettings(): void {
    this.showWindows();
    const settingsModal = (this.app as unknown as AppWithSettingModal).setting;
    settingsModal.open();
    settingsModal.openTabById(this.manifest.id);
  }

  private relaunch(): void {
    this.beginExit("relaunch");
    this.cleanup();
    remote.app.relaunch();
    remote.app.exit(0);
  }

  private closeVault(): void {
    this.beginExit("explicit-quit");
    const vaultWindows = [...this.windows];
    const owned = new Set(vaultWindows);
    const appName = remote.app.getName();
    const hasOtherVault = remote.BrowserWindow.getAllWindows().some((candidate) => isOtherVaultWindow({
      owned: owned.has(candidate),
      destroyed: candidate.isDestroyed(),
      title: candidate.getTitle(),
      appName,
      url: candidate.webContents.getURL(),
    }));
    this.cleanup();
    // On Linux, Tray.destroy() unregisters the StatusNotifier item asynchronously.
    // Let that IPC leave the menu callback before destroying the vault renderer.
    window.setTimeout(() => {
      for (const trackedWindow of vaultWindows) {
        if (!trackedWindow.isDestroyed()) trackedWindow.close();
      }
      if (!hasOtherVault) remote.app.quit();
    }, 0);
  }

  private cleanup(): void {
    if (this.cleaned) return;
    this.cleaned = true;
    this.runtimeActive = false;
    this.unregisterRuntimeCommands();
    this.releaseCloseInterceptors();
    if (this.rootWindow) {
      this.safely(() => this.rootWindow?.webContents.removeListener("did-create-window", this.windowCreated));
      this.rootWindow = undefined;
    }
    this.safely(() => remote.app.removeListener("before-quit", this.beforeQuit));
    this.safely(() => remote.app.removeListener("activate", this.appActivated));
    this.safely(() => remote.app.removeListener("second-instance", this.secondInstance));
    this.safely(() => remote.app.removeListener("browser-window-created", this.browserWindowCreated));
    this.safely(() => remote.powerMonitor?.removeListener("shutdown", this.systemShutdown));
    for (const trackedWindow of [...this.windows]) {
      this.safely(() => {
        if (!trackedWindow.isDestroyed()) trackedWindow.setSkipTaskbar(false);
      });
      this.untrack(trackedWindow);
    }
    for (const [contents, originalThrottling] of this.backgroundThrottling) {
      this.safely(() => {
        if (!contents.isDestroyed()) contents.setBackgroundThrottling(originalThrottling);
      });
    }
    this.backgroundThrottling.clear();
    if (process.platform === "darwin") this.safely(() => { void remote.app.dock?.show(); });
    this.safely(() => this.tray?.destroy());
    this.tray = undefined;
    this.linuxTray?.destroy();
    this.linuxTray = undefined;
  }

  private async loadSettings(): Promise<void> {
    const own = await this.loadData() as unknown;
    const hasOwn = Boolean(own && typeof own === "object" && Object.keys(own).length);
    const stored = hasOwn ? own : await this.readLegacy();
    this.settings = migrateSettings(stored, this.app.vault.getName());
    if (JSON.stringify(own) !== JSON.stringify(this.settings)) await this.saveSettings();
  }

  private async readLegacy(): Promise<unknown> {
    const path = normalizePath(`${this.app.vault.configDir}/plugins/tray/data.json`);
    if (!await this.app.vault.adapter.exists(path)) return null;
    try {
      return JSON.parse(await this.app.vault.adapter.read(path));
    } catch {
      return null;
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}

class TraySettingsTab extends PluginSettingTab {
  private badgePreview?: HTMLImageElement;

  constructor(app: ObsidianApp, private plugin: RunInBackgroundPlugin) {
    super(app, plugin);
  }

  override getSettingDefinitions(): SettingDefinitionItem[] {
    const isMac = process.platform === "darwin";
    return [
      {
        name: "Enable Run in Background",
        desc: "Master switch. Turn off all background, tray, launch-at-login, Dock/taskbar, close, and Quit behavior while keeping this settings page available.",
        control: {
          type: "toggle",
          key: "pluginEnabled",
        },
      },
      {
        name: ABOUT_AND_FEEDBACK.heading,
        render: (setting: Setting) => { setting.setName(ABOUT_AND_FEEDBACK.heading).setHeading(); },
      },
      {
        name: ABOUT_AND_FEEDBACK.name,
        desc: ABOUT_AND_FEEDBACK.description,
        render: (setting: Setting) => this.aboutAndFeedback(setting),
      },
      {
        type: "group",
        heading: "Window management",
        items: [
          {
            name: "Launch on startup",
            desc: "Open Obsidian when you log in.",
            control: {
              type: "toggle",
              key: "launchOnStartup",
            },
          },
          {
            name: "Hide on launch",
            desc: "Choose whether the vault starts hidden. Login detection distinguishes an automatic device-login launch from opening Obsidian normally.",
            control: {
              type: "dropdown",
              key: "hideOnLaunchMode",
              options: {
                always: "Always",
                login: "Only when opened at login",
                never: "Never",
              },
            },
          },
          {
            name: "Run in background",
            desc: "Hide an ordinary window close instead of closing the vault.",
            control: {
              type: "toggle",
              key: "runInBackground",
            },
          },
          {
            name: "Keep running after Quit command",
            desc: "Make Cmd+Q or the normal Quit command hide this vault. System shutdown still exits.",
            control: {
              type: "toggle",
              key: "keepRunningAfterQuit",
            },
          },
          {
            name: isMac ? "Hide Dock icon" : "Hide taskbar icon",
            desc: "Hide Obsidian from the Dock or taskbar. A tray icon will remain available.",
            control: {
              type: "toggle",
              key: "hideTaskbarIcon",
            },
          },
          {
            name: "Create tray icon",
            desc: "Create a tray or menu-bar icon.",
            control: {
              type: "toggle",
              key: "createTrayIcon",
            },
          },
          {
            name: "Tray icon image",
            desc: "Choose a preset or upload a square PNG/SVG. 64×64 px is ideal; 32×32 px is the practical minimum.",
            render: (setting: Setting) => {
              this.renderTrayImageControl(setting);
            },
          },
          {
            name: "Vault badge",
            desc: "Up to three letters, numbers, emoji, or symbols, optionally separated by spaces. Leave blank for no badge.",
            render: (setting: Setting) => {
              this.renderVaultBadgeControl(setting);
            },
          },
        ],
      },
    ];
  }

  override getControlValue(key: string): unknown {
    if (key in this.plugin.settings) {
      return this.plugin.settings[key as keyof TraySettings];
    }
    return undefined;
  }

  override async setControlValue(key: string, value: unknown): Promise<void> {
    if (key === "pluginEnabled") {
      await this.plugin.setPluginEnabled(Boolean(value));
      return;
    }
    if (key === "launchOnStartup") {
      this.plugin.settings.launchOnStartup = Boolean(value);
      await this.plugin.saveSettings();
      await this.plugin.updateLogin();
      return;
    }
    if (key === "hideOnLaunchMode") {
      if (value === "always" || value === "login" || value === "never") {
        this.plugin.settings.hideOnLaunchMode = value;
        await this.plugin.saveSettings();
        await this.plugin.updateLogin();
      }
      return;
    }
    if (key === "runInBackground") {
      this.plugin.settings.runInBackground = Boolean(value);
      await this.plugin.saveSettings();
      this.plugin.updateBackgroundMode();
      await this.plugin.updateLogin();
      this.plugin.showWindows();
      return;
    }
    if (key === "keepRunningAfterQuit") {
      this.plugin.settings.keepRunningAfterQuit = Boolean(value);
      await this.plugin.saveSettings();
      return;
    }
    if (key === "hideTaskbarIcon") {
      const val = Boolean(value);
      this.plugin.settings.hideTaskbarIcon = val;
      if (val) reconcileRecoveryPath(this.plugin.settings, "hideTaskbarIcon");
      await this.plugin.saveSettings();
      this.plugin.updateTaskbar();
      await this.plugin.createTray();
      return;
    }
    if (key === "createTrayIcon") {
      const val = Boolean(value);
      this.plugin.settings.createTrayIcon = val;
      if (!val) reconcileRecoveryPath(this.plugin.settings, "createTrayIcon");
      await this.plugin.saveSettings();
      this.plugin.updateTaskbar();
      await this.plugin.createTray();
      return;
    }
  }

  override display(): void {
    this.containerEl.empty();
    this.masterSwitch();
    new Setting(this.containerEl).setName(ABOUT_AND_FEEDBACK.heading).setHeading();
    this.aboutAndFeedback(new Setting(this.containerEl));
    new Setting(this.containerEl).setName("Window management").setHeading();
    this.toggle("Launch on startup", "Open Obsidian when you log in.", "launchOnStartup", undefined, () => this.plugin.updateLogin());
    new Setting(this.containerEl)
      .setName("Hide on launch")
      .setDesc("Choose whether the vault starts hidden. Login detection distinguishes an automatic device-login launch from opening Obsidian normally.")
      .addDropdown((control) => control
        .addOption("always", "Always")
        .addOption("login", "Only when opened at login")
        .addOption("never", "Never")
        .setValue(this.plugin.settings.hideOnLaunchMode)
        .onChange((value) => {
          if (value !== "always" && value !== "login" && value !== "never") return;
          this.plugin.settings.hideOnLaunchMode = value;
          void this.commit(() => this.plugin.updateLogin());
        }));
    this.toggle("Run in background", "Hide an ordinary window close instead of closing the vault.", "runInBackground", undefined, () => {
      this.plugin.updateBackgroundMode();
      this.plugin.showWindows();
      return this.plugin.updateLogin();
    });
    this.toggle("Keep running after Quit command", "Make Cmd+Q or the normal Quit command hide this vault. System shutdown still exits.", "keepRunningAfterQuit");
    const taskbarName = process.platform === "darwin" ? "Hide Dock icon" : "Hide taskbar icon";
    this.toggle(taskbarName, "Hide Obsidian from the Dock or taskbar. A tray icon will remain available.", "hideTaskbarIcon", (value) => {
      if (value) reconcileRecoveryPath(this.plugin.settings, "hideTaskbarIcon");
    }, async () => {
      this.plugin.updateTaskbar();
      await this.plugin.createTray();
      this.display();
    });
    this.toggle("Create tray icon", "Create a tray or menu-bar icon.", "createTrayIcon", (value) => {
      if (!value) reconcileRecoveryPath(this.plugin.settings, "createTrayIcon");
    }, async () => {
      this.plugin.updateTaskbar();
      await this.plugin.createTray();
      this.display();
    });
    const imageSetting = new Setting(this.containerEl)
      .setName("Tray icon image")
      .setDesc("Choose a preset or upload a square PNG/SVG. 64×64 px is ideal; 32×32 px is the practical minimum.");
    this.renderTrayImageControl(imageSetting);

    const badgeSetting = new Setting(this.containerEl)
      .setName("Vault badge")
      .setDesc("Up to three letters, numbers, emoji, or symbols, optionally separated by spaces. Leave blank for no badge.");
    this.renderVaultBadgeControl(badgeSetting);
  }

  private aboutAndFeedback(setting: Setting): void {
    setting
      .setName(ABOUT_AND_FEEDBACK.name)
      .setDesc(ABOUT_AND_FEEDBACK.description)
      .addButton((button) => button.setButtonText(ABOUT_AND_FEEDBACK.websiteLabel).setCta().onClick(() => openExternalLink(WEBSITE_URL)))
      .addButton((button) => button.setButtonText(ABOUT_AND_FEEDBACK.featureRequestLabel).onClick(() => openExternalLink(FEATURE_REQUEST_URL)))
      .addButton((button) => button.setButtonText(ABOUT_AND_FEEDBACK.bugReportLabel).onClick(() => openExternalLink(BUG_REPORT_URL)));
  }

  private masterSwitch(): void {
    const setting = new Setting(this.containerEl)
      .setName("Enable Run in Background")
      .setDesc("Master switch. Turn off all background, tray, launch-at-login, Dock/taskbar, close, and Quit behavior while keeping this settings page available.")
      .addToggle((control) => control
        .setValue(this.plugin.settings.pluginEnabled)
        .onChange((value) => void this.plugin.setPluginEnabled(value)));
    setting.settingEl.addClass("run-in-background-master-switch");
  }

  private renderTrayImageControl(setting: Setting): void {
    setting.controlEl.empty();
    setting.controlEl.setCssStyles({ gap: "8px" });
    const presetButtons: HTMLButtonElement[] = [];
    const selectedPreset = (): string | undefined =>
      TRAY_ICON_PRESETS.find((preset) => preset.dataUrl === this.plugin.settings.trayIconImage)?.id;
    const refreshSelection = (): void => {
      const selected = selectedPreset();
      for (const button of presetButtons) {
        const active = button.dataset.preset === selected;
        button.classList.toggle("mod-cta", active);
        button.setAttribute("aria-pressed", String(active));
        button.setCssStyles({ boxShadow: active ? "0 0 0 2px var(--interactive-accent)" : "none" });
      }
    };
    for (const preset of TRAY_ICON_PRESETS) {
      const button = setting.controlEl.createEl("button", { cls: "clickable-icon", attr: { "aria-label": preset.name, title: preset.name } });
      button.dataset.preset = preset.id;
      button.setCssStyles({ width: "40px", height: "40px", borderRadius: "8px" });
      const image = button.createEl("img", { attr: { src: preset.dataUrl, alt: preset.name } });
      image.setCssStyles({ width: "30px", height: "30px", objectFit: "contain" });
      presetButtons.push(button);
      button.addEventListener("click", () => {
        this.plugin.settings.trayIconImage = preset.dataUrl;
        customPreview.setCssStyles({ display: "none" });
        refreshSelection();
        void this.commit(() => this.plugin.createTray());
      });
    }
    const customPreview = setting.controlEl.createEl("img", {
      attr: { src: selectedPreset() ? "" : this.plugin.settings.trayIconImage, alt: "Uploaded custom icon" },
    });
    this.stylePreview(customPreview);
    customPreview.setCssStyles({ display: selectedPreset() ? "none" : "block" });
    setting.addButton((button) => button.setButtonText("Upload your own").onClick(() => {
      const input = createEl("input", { attr: { type: "file", accept: "image/*" } });
      input.onchange = () => {
        const file = input.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          if (typeof reader.result !== "string") return;
          this.plugin.settings.trayIconImage = reader.result;
          customPreview.src = reader.result;
          customPreview.setCssStyles({ display: "block" });
          refreshSelection();
          void this.commit(async () => {
            await this.plugin.createTray();
          });
        };
        reader.readAsDataURL(file);
      };
      input.click();
    }));
    refreshSelection();
  }

  private renderVaultBadgeControl(setting: Setting): void {
    setting.controlEl.empty();
    this.badgePreview = setting.controlEl.createEl("img", {
      attr: { src: this.plugin.trayPreviewDataUrl, alt: "Tray icon with vault badge" },
    });
    this.stylePreview(this.badgePreview, 64);
    setting
      .addText((control) => {
        control.setPlaceholder("G B C").setValue(this.plugin.settings.vaultBadge).onChange((value) => {
          const normalized = normalizeVaultBadge(value);
          control.setValue(normalized);
          this.plugin.settings.vaultBadge = normalized;
          void this.commit(() => this.plugin.createTray());
        });
      })
      .addColorPicker((control) => control
        .setValue(this.plugin.settings.badgeBackgroundColor)
        .onChange((value) => {
          this.plugin.settings.badgeBackgroundColor = value;
          void this.commit(() => this.plugin.createTray());
        }));
  }

  updatePreview(dataUrl: string): void {
    if (this.badgePreview) this.badgePreview.src = dataUrl;
  }

  private stylePreview(preview: HTMLImageElement, size = 32): void {
    preview.setCssStyles({
      width: `${size}px`,
      height: `${size}px`,
      objectFit: "contain",
      imageRendering: "auto",
    });
  }

  private toggle(
    name: string,
    description: string,
    key: keyof TraySettings,
    beforeSave?: (value: boolean) => void,
    after?: () => void | Promise<void>,
  ): void {
    new Setting(this.containerEl).setName(name).setDesc(description).addToggle((control) =>
      control.setValue(Boolean(this.plugin.settings[key])).onChange((value) => {
        (this.plugin.settings[key] as boolean) = value;
        beforeSave?.(value);
        void this.commit(after);
      }));
  }

  private async commit(after?: () => void | Promise<void>): Promise<void> {
    await this.plugin.saveSettings();
    await after?.();
  }
}

function openExternalLink(url: string): void {
  window.open(url, "_blank", "noopener,noreferrer");
}
