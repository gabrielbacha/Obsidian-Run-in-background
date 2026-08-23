import { normalizePath, Plugin, PluginSettingTab, Setting, type App as ObsidianApp } from "obsidian";
import { composeTrayIcon, TRAY_ICON_PRESETS } from "./icon";
import { QuitLifecycle, type ExitIntent } from "./lifecycle";
import { defaultSettings, migrateSettings, normalizeVaultBadge, reconcileRecoveryPath, type TraySettings } from "./settings";

type BrowserWindow = any;
type ElectronEvent = { preventDefault(): void };
type MenuItemConstructorOptions = any;
type Tray = any;
type Listeners = {
  close: (event: ElectronEvent) => void;
  closed: () => void;
  maximize: () => void;
  unmaximize: () => void;
  focus?: () => void;
  sessionEnd?: () => void;
};

const electron = window.require("electron") as any;
const remote = electron.remote;

export default class RunInBackgroundPlugin extends Plugin {
  override settings: TraySettings = defaultSettings("");
  trayPreviewDataUrl = "";
  private lifecycle = new QuitLifecycle();
  private windows = new Set<BrowserWindow>();
  private maximized = new Set<BrowserWindow>();
  private listeners = new Map<BrowserWindow, Listeners>();
  private tray?: Tray;
  private settingsTab?: TraySettingsTab;
  private rootWindow?: BrowserWindow;
  private cleaned = false;
  private closeInterceptorsReleased = false;
  private runtimeActive = false;
  private commandsRegistered = false;
  private lastSecondInstanceAt = 0;

  private beforeUnload = (event: BeforeUnloadEvent): void => {
    if (!this.lifecycle.shouldInterceptClose(this.settings.runInBackground)) return;
    event.preventDefault();
    (event as unknown as { returnValue: boolean }).returnValue = false;
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
  private secondInstance = (): void => {
    this.lastSecondInstanceAt = Date.now();
    this.appActivated();
  };
  private browserWindowCreated = (_event: unknown, window: BrowserWindow): void => {
    if (!this.lifecycle.shouldSuppressTransientWindow(this.lastSecondInstanceAt, Date.now())) return;
    if (this.windows.has(window)) return;
    const hidePicker = (): void => {
      if (window.isDestroyed()) return;
      window.hide();
      window.setSkipTaskbar(true);
    };
    window.on("ready-to-show", hidePicker);
    window.on("show", hidePicker);
    window.setTimeout(hidePicker, 0);
    window.setTimeout(() => {
      hidePicker();
      this.appActivated();
    }, 150);
  };
  private windowCreated = (_event: unknown, window: BrowserWindow): void => this.track(window);

  override async onload(): Promise<void> {
    await this.loadSettings();
    this.settingsTab = new TraySettingsTab(this.app, this);
    this.addSettingTab(this.settingsTab);
    if (this.settings.pluginEnabled) await this.activateRuntime(true);
    else {
      this.updateLogin();
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
    this.updateLogin();
    this.updateTaskbar();
    if (applyHideOnLaunch && this.settings.hideOnLaunch) {
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
      this.updateLogin();
    }
  }

  override onunload(): void {
    this.beginExit("plugin-unload");
    this.cleanup();
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
    if (trackedWindow.isMaximized()) this.maximized.add(trackedWindow);
    trackedWindow.setSkipTaskbar(this.settings.hideTaskbarIcon);
    const listeners: Listeners = {
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
    if (process.platform === "win32") listeners.sessionEnd = this.systemShutdown;
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
      if (listeners.focus) this.safely(() => trackedWindow.removeListener("focus", listeners.focus));
      if (listeners.sessionEnd) this.safely(() => trackedWindow.removeListener("session-end", listeners.sessionEnd));
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

  updateLogin(): void {
    remote.app.setLoginItemSettings({
      openAtLogin: this.runtimeActive && this.settings.launchOnStartup,
      openAsHidden: this.runtimeActive && this.settings.runInBackground && this.settings.hideOnLaunch,
    });
  }

  updateTaskbar(): void {
    if (!this.runtimeActive) {
      if (process.platform === "darwin") remote.app.dock?.show();
      return;
    }
    for (const trackedWindow of this.windows) trackedWindow.setSkipTaskbar(this.settings.hideTaskbarIcon);
    if (process.platform !== "darwin") return;
    if (this.settings.hideTaskbarIcon) remote.app.dock?.hide();
    else remote.app.dock?.show();
  }

  async createTray(): Promise<void> {
    this.safely(() => this.tray?.destroy());
    this.tray = undefined;
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
    const nativeIcon = remote.nativeImage.createEmpty();
    for (const representation of composed.representations) nativeIcon.addRepresentation(representation);
    const vault = this.app.vault.getName();
    const menu: MenuItemConstructorOptions[] = [
      { label: `Vault: ${vault}`, enabled: false },
      { type: "separator" },
      { label: "Show Vault", click: () => this.showWindows() },
      { label: "Hide Vault", click: () => this.hideWindows() },
      { label: "Open Plugin Settings", click: () => this.openSettings() },
      { type: "separator" },
      { label: "Relaunch Obsidian", click: () => this.relaunch() },
      { label: "Close Vault", click: () => this.closeVault() },
    ];
    this.tray = new remote.Tray(nativeIcon);
    this.tray.setContextMenu(remote.Menu.buildFromTemplate(menu));
    this.tray.setToolTip(`Vault: ${vault}`);
    this.tray.on("click", () => process.platform === "darwin" ? this.tray?.popUpContextMenu() : this.toggleWindows());
  }

  private openSettings(): void {
    this.showWindows();
    const settings = (this.app as unknown as { setting: { open(): void; openTabById(id: string): unknown } }).setting;
    settings.open();
    settings.openTabById(this.manifest.id);
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
    this.cleanup();
    if (remote.BrowserWindow.getAllWindows().length === vaultWindows.length) remote.app.quit();
    else for (const trackedWindow of vaultWindows) trackedWindow.destroy();
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
    if (process.platform === "darwin") this.safely(() => remote.app.dock?.show());
    this.safely(() => this.tray?.destroy());
    this.tray = undefined;
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

  override display(): void {
    this.containerEl.empty();
    new Setting(this.containerEl).setName("Window management").setHeading();
    this.toggle("Launch on startup", "Open Obsidian when you log in.", "launchOnStartup", undefined, () => this.plugin.updateLogin());
    this.toggle("Hide on launch", "Hide after layout loads.", "hideOnLaunch", undefined, () => this.plugin.updateLogin());
    this.toggle("Run in background", "Hide an ordinary window close instead of closing the vault.", "runInBackground", undefined, () => {
      this.plugin.updateLogin();
      this.plugin.showWindows();
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
    this.image();
    this.badge();
    this.masterSwitch();
  }

  private masterSwitch(): void {
    new Setting(this.containerEl)
      .setName("Enable Run in Background")
      .setDesc("Master switch. Turn off all background, tray, launch-at-login, Dock/taskbar, close, and Quit behavior while keeping this settings page available.")
      .addToggle((control) => control
        .setValue(this.plugin.settings.pluginEnabled)
        .onChange((value) => void this.plugin.setPluginEnabled(value)));
  }

  private image(): void {
    const setting = new Setting(this.containerEl)
      .setName("Tray icon image")
      .setDesc("Choose a preset or upload a square PNG/SVG. 64×64 px is ideal; 32×32 px is the practical minimum.");
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

  private badge(): void {
    const setting = new Setting(this.containerEl)
      .setName("Vault badge")
      .setDesc("Up to two letters, numbers, emoji, or symbols, optionally separated by a space. Leave blank for no badge.");
    this.badgePreview = setting.controlEl.createEl("img", {
      attr: { src: this.plugin.trayPreviewDataUrl, alt: "Tray icon with vault badge" },
    });
    this.stylePreview(this.badgePreview, 64);
    setting
      .addText((control) => {
        control.setPlaceholder("G B").setValue(this.plugin.settings.vaultBadge).onChange((value) => {
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
