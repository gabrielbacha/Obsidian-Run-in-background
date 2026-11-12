import { abortable } from "./async-work";
import { installAppCoordinator, type AppCoordinator } from "./app-coordinator";
import { traySettingDefinitions, type TraySettingDefinition } from "./settings-schema";
import { trayMenuRows, type TrayMenuAction } from "./tray-menu";
import { FileSystemAdapter, normalizePath, Notice, Plugin, PluginSettingTab, Setting, type App as ObsidianApp, type SettingDefinitionItem } from "obsidian";
import { ABOUT_AND_FEEDBACK, BUG_REPORT_URL, FEATURE_REQUEST_URL, MORE_PLUGINS_URL, WEBSITE_URL } from "./external-links";
import { spawn } from "node:child_process";
import { join } from "node:path";
import type { BrowserWindow, Event as ElectronEvent, MenuItemConstructorOptions, Tray, WebContents } from "electron";
import { composeTrayIcon, normalizeCustomIcon, MAX_ICON_BYTES, TRAY_ICON_PRESETS } from "./icon";
import { backgroundThrottlingFor, isLoginLaunch, isOtherVaultWindow, isPlainRelaunch, LOGIN_MARKER, QuitLifecycle, SECOND_INSTANCE_SUPPRESSION_MS, wasLaunchedAtLogin, type ExitIntent } from "./lifecycle";
import { LinuxAutostartManager } from "./linux-autostart";
import { LinuxStatusNotifierTray } from "./linux-tray";
import { LoginVaultRegistry } from "./login-vaults";
import { defaultSettings, migrateSettings, normalizeVaultBadge, reconcileRecoveryPath, shouldHideOnLaunch, type TraySettings } from "./settings";
import type { AppWithSettingModal, ElectronExports, ElectronRemote, WindowListeners } from "./types";
import { installCloseGuard, type CloseGuard, type CloseGuardHost } from "./close-guard";
import { resolveNativeHost, compileNativeFunction } from './native-host';
import { launchDiagnostic } from './lifecycle';

interface WindowWithElectron extends Window {
  require(module: "electron"): ElectronExports;
}

const nativeHost = resolveNativeHost(name => (window as unknown as WindowWithElectron).require(name as 'electron'));
const remote = nativeHost.remote as ElectronRemote;

const SETTINGS_QUEUE = Symbol.for("run-in-background.settings-queue");
const LOGIN_QUEUE = Symbol.for("run-in-background.login-queue");

/** Close and quit decisions; read them with the Obsidian CLI `dev:console` or the DevTools console. */
const trace = (message: string, details?: Record<string, unknown>): void => {
  console.info(`Run in Background: ${message}`, details ?? "");
};

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
  private loaded = false;
  private runtimeGeneration = 0;
  private trayVersion = 0;
  private trayAbort?: AbortController;
  private activating?: Promise<void>;
  private appCoordinator?: AppCoordinator;
  private pendingLinuxTrays = new Set<LinuxStatusNotifierTray>();
  private windowContents = new Map<BrowserWindow, WebContents>();
  private requestRevision = 0;
  private desiredSettings: TraySettings = this.settings;
  private debounceRelease?: () => void;
  private iconInputRevision = 0;
  operationError = "";
  settingsPending = false;
  startupError = "";

  private commandsRegistered = false;
  private lastSecondInstanceAt = 0;
  /** Windows hidden after a second launch, with the function that releases each one. */
  private suppressedWindows = new Map<BrowserWindow, () => void>();
  private linuxAutostart?: LinuxAutostartManager;
  private loginVaults?: LoginVaultRegistry;

  private guard?: CloseGuard;

  /** Runs after the main-process guard has decided; only the follow-up work happens here. */
  private beforeQuit = (): void => {
    this.traceGuard();
    if (this.lifecycle.intent === "none" && this.guard && !this.guard.quitProceeding()) {
      // Another vault kept the app running. This vault does not keep running after Quit, so close it,
      // but only when the quit was for this vault.
      if (!this.settings.keepRunningAfterQuit && this.guard.quitTargetsThisVault()) {
        trace("another vault cancelled Quit: closing this vault");
        this.closeVault();
      }
      return;
    }
    if (this.lifecycle.intent === "none") this.lifecycle.beginExit("user-quit");
    this.cleanup();
  };
  private windowClosing = (): void => this.traceGuard();
  /** A reload never reaches onunload, so the Electron listeners of this page are released here. */
  private pageHidden = (): void => { this.loaded = false; this.iconInputRevision++; this.debounceRelease?.(); this.cleanup(); };

  private systemShutdown = (): void => {
    this.beginExit("system-shutdown");
    this.cleanup();
  };
  private appActivated = (): void => {
    if (this.lifecycle.shouldRestoreOnActivation()) this.showWindows();
  };
  private secondInstance = (_event: ElectronEvent, commandLine: string[]): void => {
    if (process.platform === "linux"
      && isLoginLaunch(commandLine)
      && this.settings.launchOnStartup
      && shouldHideOnLaunch(this.settings.hideOnLaunchMode, true)) {
      this.lastSecondInstanceAt = Date.now();
      this.hideWindows(true);
      return;
    }
    if (!isPlainRelaunch(commandLine)) {
      trace("second launch with arguments left hidden vaults hidden", launchDiagnostic(commandLine));
      return;
    }
    this.lastSecondInstanceAt = Date.now();
    this.appActivated();
  };
  /** The guard showed the main window because Obsidian focused it; show the other vault windows too. */
  private focusRevealed = (): void => {
    this.traceGuard();
    this.appActivated();
  };
  private browserWindowCreated = (_event: ElectronEvent, createdWindow: BrowserWindow): void => {
    const now = Date.now(), generation = this.runtimeGeneration;
    if (!this.runtimeActive || !this.lifecycle.shouldSuppressTransientWindow(this.lastSecondInstanceAt, now) || this.windows.has(createdWindow) || this.suppressedWindows.has(createdWindow)) return;
    let released = false, priorVisible = false, suppressed = false;
    const timers = new Set<number>();
    const release = (): void => {
      if (released) return;
      released = true; this.suppressedWindows.delete(createdWindow);
      for (const timer of timers) window.clearTimeout(timer);
      this.safely(() => createdWindow.removeListener("closed", release));
      this.safely(() => createdWindow.removeListener("ready-to-show", probe));
      this.safely(() => createdWindow.removeListener("show", probe));
      this.safely(() => createdWindow.webContents.removeListener("did-finish-load", probe));
      this.safely(() => createdWindow.webContents.removeListener("did-start-navigation", navigation));
      // The target's taskbar setting was never changed. Cleanup restores only its prior visibility.
      if (suppressed && priorVisible && this.runtimeGeneration !== generation) this.safely(() => { if (!createdWindow.isDestroyed()) createdWindow.show(); });
    };
    const navigation = (): void => { if (suppressed && priorVisible) this.safely(() => { if (!createdWindow.isDestroyed()) createdWindow.show(); }); release(); };
    const probe = (): void => {
      if (released || this.runtimeGeneration !== generation || !this.runtimeActive || !this.lifecycle.shouldRestoreOnActivation() || this.windows.has(createdWindow) || createdWindow.isDestroyed()) return release();
      if (createdWindow.webContents.getURL() !== "app://obsidian.md/starter.html") return;
      void createdWindow.webContents.executeJavaScript("document.body.classList.contains('starter') && Boolean(document.querySelector('.starter-screen'))").then((chooser: unknown) => {
        if (chooser !== true || released || this.runtimeGeneration !== generation || !this.runtimeActive || !this.lifecycle.shouldRestoreOnActivation() || createdWindow.isDestroyed()) return;
        if (!suppressed) {
          priorVisible = createdWindow.isVisible(); suppressed = true;
          createdWindow.webContents.on("did-start-navigation", navigation);
        }
        createdWindow.hide();
      }).catch(() => { /* Identity is unknown; leave the window visible. */ });
    };
    this.suppressedWindows.set(createdWindow, release);
    createdWindow.on("closed", release); createdWindow.on("ready-to-show", probe); createdWindow.on("show", probe);
    createdWindow.webContents.on("did-finish-load", probe);
    timers.add(window.setTimeout(probe, 0)); timers.add(window.setTimeout(probe, 150));
    timers.add(window.setTimeout(release, Math.max(0, this.lastSecondInstanceAt + SECOND_INSTANCE_SUPPRESSION_MS - now)));
  };
  private windowCreated = (createdWindow: BrowserWindow): void => this.track(createdWindow);

  override async onload(): Promise<void> {
    if (!nativeHost.remote) { this.startupError = nativeHost.error ?? 'Desktop host unavailable.'; new Notice(this.startupError); return; }
    this.loaded = true;
    let saved = true;
    try { await this.loadSettings(); } catch (error) { saved = false; this.reportError(error); }
    this.settingsTab = new TraySettingsTab(this.app, this); this.addSettingTab(this.settingsTab);
    if (saved && this.settings.pluginEnabled) {
      try { await this.activateRuntime(true); } catch (error) { this.reportError(error); }
    } else { await this.createTray().catch((error: unknown) => this.reportError(error)); }
  }

  private activateRuntime(applyHideOnLaunch: boolean): Promise<void> {
    if (this.runtimeActive) return Promise.resolve();
    if (this.activating) return this.activating.catch(() => {}).then(() => this.runtimeActive ? undefined : this.activateRuntime(applyHideOnLaunch));
    const activation = this.doActivateRuntime(applyHideOnLaunch);
    this.activating = activation;
    return activation.finally(() => { if (this.activating === activation) this.activating = undefined; });
  }

  private async doActivateRuntime(applyHideOnLaunch: boolean): Promise<void> {
    this.lifecycle = new QuitLifecycle(); this.cleaned = false; this.closeInterceptorsReleased = false;
    const current = remote.getCurrentWindow(); this.rootWindow = current;
    try {
      const install = compileNativeFunction(remote, installAppCoordinator);
      this.appCoordinator = install(remote.app, current.webContents);
      await this.appCoordinator.updateDock(false, false);
      await this.createTray(true);
      if (!this.loaded || current.isDestroyed()) throw new Error("Activation was cancelled");
      this.guard = this.installGuard(current.webContents);
      if (!this.guard) throw new Error("The close/quit adapter is unavailable. The vault remains visible.");
      this.track(current); this.guard.revealOnFocus(current, this.focusRevealed);
      current.webContents.on("did-create-window", this.windowCreated);
      window.addEventListener("pagehide", this.pageHidden);
      remote.app.on("before-quit", this.beforeQuit); remote.app.on("activate", this.appActivated);
      remote.app.prependListener("second-instance", this.secondInstance);
      remote.app.on("browser-window-created", this.browserWindowCreated);
      remote.powerMonitor?.on("shutdown", this.systemShutdown);
      this.runtimeActive = true;
      await this.updateTaskbar();
      if (applyHideOnLaunch) await this.updateLogin(true).catch((error: unknown) => this.reportError(error));
      else await this.updateLogin();
      if (applyHideOnLaunch && shouldHideOnLaunch(this.settings.hideOnLaunchMode, this.wasOpenedAtLogin())) this.app.workspace.onLayoutReady(() => { if (this.runtimeActive && this.settings.pluginEnabled) this.hideWindows(); });
      this.registerRuntimeCommands();
    } catch (error) { this.safely(() => current.show()); this.cleanup(); throw error; }
  }

  /**
   * `wasOpenedAtLogin` exists only on macOS. Windows and Linux mark the login launch with an argument
   * of the main process, which the renderer's own `process.argv` does not always contain.
   */
  private wasOpenedAtLogin(): boolean {
    const main = this.mainProcessFacts();
    return wasLaunchedAtLogin({
      platform: process.platform,
      macOpenedAtLogin: process.platform === "darwin" && Boolean(remote.app.getLoginItemSettings().wasOpenedAtLogin),
      argv: [...main.argv, ...process.argv],
      uptimeSeconds: main.uptimeSeconds,
    });
  }

  private mainProcessFacts(): { argv: string[]; uptimeSeconds: number } {
    try {
      const facts = remote.require("vm").runInThisContext("({ argv: process.argv.slice(), uptimeSeconds: process.uptime() })") as { argv: unknown; uptimeSeconds: unknown };
      return {
        argv: Array.isArray(facts.argv) ? facts.argv.filter((argument): argument is string => typeof argument === "string") : [],
        uptimeSeconds: typeof facts.uptimeSeconds === "number" ? facts.uptimeSeconds : 0,
      };
    } catch (error) {
      console.warn("Run in Background: unable to read the launch arguments", error);
      return { argv: [], uptimeSeconds: 0 };
    }
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

  async setPluginEnabled(enabled: boolean): Promise<void> { await this.requestSetting("pluginEnabled", enabled); }

  override onunload(): void {
    const disabledWhileRunning = this.lifecycle.intent === "none" && !this.cleaned;
    this.loaded = false; this.iconInputRevision++; this.debounceRelease?.();
    this.beginExit("plugin-unload"); this.cleanup();
    if (disabledWhileRunning) void this.updateLogin().catch((error: unknown) => console.warn("Run in Background: startup withdrawal failed", error));
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
    trace("close interceptors released", { intent: this.lifecycle.intent });
    this.safely(() => this.guard?.exit());
  }

  /** Compiles the guard into the main process, where its listeners run before Obsidian's unload hook. */
  private installGuard(owner: WebContents): CloseGuard | undefined {
    try {
      const install = compileNativeFunction(remote, installCloseGuard);
      const host = {
        app: remote.app,
        owner,
        powerMonitor: remote.powerMonitor,
        autoUpdater: remote.autoUpdater,
      } as unknown as CloseGuardHost;
      return install(host, this.closeOptions());
    } catch (error) {
      console.error("Run in Background: unable to install the close guard; windows close normally", error);
      new Notice("Run in Background could not take over window closing. Check the console for details.");
      return undefined;
    }
  }

  private closeOptions(): { runInBackground: boolean; keepRunningAfterQuit: boolean } {
    return { runInBackground: this.settings.runInBackground, keepRunningAfterQuit: this.settings.keepRunningAfterQuit };
  }

  private traceGuard(): void {
    for (const line of this.guard?.takeLog() ?? []) trace(line);
  }

  private track(trackedWindow: BrowserWindow): void {
    if (this.windows.has(trackedWindow)) return;
    this.windows.add(trackedWindow);
    const contents = trackedWindow.webContents;
    const originalThrottling = this.backgroundThrottling.get(contents) ?? contents.getBackgroundThrottling();
    this.backgroundThrottling.set(contents, originalThrottling);
    this.windowContents.set(trackedWindow, contents);
    contents.setBackgroundThrottling(backgroundThrottlingFor(this.settings.runInBackground, originalThrottling));
    if (trackedWindow.isMaximized()) this.maximized.add(trackedWindow);
    trackedWindow.setSkipTaskbar(this.settings.hideTaskbarIcon && this.hasRecoveryTray());
    this.safely(() => this.guard?.track(trackedWindow));
    const listeners: WindowListeners = {
      close: this.windowClosing,
      closed: () => this.untrack(trackedWindow),
      maximize: () => this.maximized.add(trackedWindow),
      unmaximize: () => this.maximized.delete(trackedWindow),
    };
    if (process.platform === "darwin") {
      listeners.focus = () => {
        void this.updateTaskbar();
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
    const contents = this.windowContents.get(trackedWindow);
    this.windowContents.delete(trackedWindow);
    if (contents) {
      const original = this.backgroundThrottling.get(contents);
      this.backgroundThrottling.delete(contents);
      if (original !== undefined) this.safely(() => { if (!contents.isDestroyed()) contents.setBackgroundThrottling(original); });
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

  /**
   * The unloading and the reloaded copy of this plugin share the window, so their login updates run in
   * order; otherwise a reload could withdraw this vault's launch-at-login after the new copy set it.
   */
  updateLogin(loginBootstrap = false): Promise<void> {
    const host = window as unknown as Record<symbol, Promise<void> | undefined>;
    const next = (host[LOGIN_QUEUE] ?? Promise.resolve()).then(() => this.applyLogin(loginBootstrap));
    host[LOGIN_QUEUE] = next.catch(() => {});
    return next;
  }

  private async applyLogin(loginBootstrap: boolean): Promise<void> {
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
          && loginBootstrap && this.wasOpenedAtLogin() && this.runtimeActive
          && await this.linuxAutostart.claimStartupBootstrap({ ...this.appCoordinator!.facts(), loginLaunch: true })) {
          for (const command of this.linuxAutostart.startupCommands(activeVaults, this.vaultPath())) {
            const child = spawn(command[0]!, command.slice(1), { detached: true, stdio: "ignore" });
            child.once("error", (error) => {
              console.error("Run in Background: unable to open startup vault", error);
            });
            child.unref();
          }
        }
        this.startupError = "";
      } catch (error) { this.startupError = "Startup registration failed. Check Update status and retry."; throw error; }
      return;
    }
    try {
      this.loginVaults ??= new LoginVaultRegistry(
        join(remote.app.getPath("userData"), "run-in-background", "login-vaults"),
        { vaultPath: this.vaultPath(), vaultName: this.app.vault.getName() },
      );
      await this.loginVaults.reconcile(enabled, this.runtimeActive && this.settings.runInBackground && this.settings.hideOnLaunchMode !== "never", (wanted) => {
        const prior = remote.app.getLoginItemSettings();
        try {
          remote.app.setLoginItemSettings({ openAtLogin: wanted.length > 0, openAsHidden: wanted.some((record) => record.openAsHidden), ...(process.platform === "win32" ? { args: [LOGIN_MARKER] } : {}) });
        } catch (error) {
          remote.app.setLoginItemSettings({ openAtLogin: prior.openAtLogin, openAsHidden: prior.openAsHidden });
          throw error;
        }
        return Promise.resolve();
      });
      this.startupError = "";
    } catch (error) {
      this.startupError = "Startup registration failed. Check Update status and retry."; throw error;
    }
  }

  private vaultPath(): string {
    return this.app.vault.adapter instanceof FileSystemAdapter
      ? this.app.vault.adapter.getBasePath()
      : this.app.vault.getName();
  }

  hasRecoveryTray(): boolean { return process.platform === "linux" ? Boolean(this.linuxTray?.isAvailable()) : Boolean(this.tray && !this.tray.isDestroyed()); }

  updateTaskbar(): Promise<void> {
    const hide = this.runtimeActive && this.settings.hideTaskbarIcon && this.hasRecoveryTray();
    for (const trackedWindow of this.windows) trackedWindow.setSkipTaskbar(hide);
    if (this.runtimeActive && this.settings.hideTaskbarIcon && !this.hasRecoveryTray() && ![...this.windows].some((trackedWindow) => trackedWindow.isVisible())) this.showWindows();
    return this.appCoordinator?.updateDock(hide, this.hasRecoveryTray()) ?? Promise.resolve();
  }

  async createTray(forceActive = false): Promise<void> {
    this.trayAbort?.abort(); const controller = new AbortController(); this.trayAbort = controller;
    const version = ++this.trayVersion, generation = this.runtimeGeneration;
    const source = this.settings.trayIconImage || TRAY_ICON_PRESETS[0].dataUrl;
    const composed = await abortable(composeTrayIcon(source, this.settings.vaultBadge, this.settings.badgeBackgroundColor), controller.signal);
    if (!this.loaded || version !== this.trayVersion || generation !== this.runtimeGeneration) return;
    const wantsTray = (forceActive || this.runtimeActive) && this.settings.createTrayIcon;
    if (!wantsTray) {
      this.safely(() => this.tray?.destroy()); this.tray = undefined;
      this.linuxTray?.destroy(); this.linuxTray = undefined;
    } else if (process.platform === "linux") {
      if (this.linuxTray) this.linuxTray.updateIcon(composed.pixmaps);
      else {
        const candidate = new LinuxStatusNotifierTray(this.app.vault.getName(), composed.pixmaps, {
          show: () => this.showWindows(), hide: () => this.hideWindows(), toggle: () => this.toggleWindows(),
          openSettings: () => this.openSettings(), relaunch: () => this.relaunch(), closeVault: () => { window.setTimeout(() => this.closeVault(), 0); },
        }, { availability: () => { if (this.linuxTray === candidate) { void this.updateTaskbar(); this.settingsTab?.refreshStatus(); } } });
        this.pendingLinuxTrays.add(candidate);
        try {
          await abortable(candidate.create(), controller.signal);
          if (!this.loaded || version !== this.trayVersion || generation !== this.runtimeGeneration) { candidate.destroy(); return; }
          this.linuxTray = candidate;
        } catch (error) { candidate.destroy(); throw error; }
        finally { this.pendingLinuxTrays.delete(candidate); }
      }
    } else {
      const nativeIcon = remote.nativeImage.createEmpty();
      for (const representation of composed.representations) nativeIcon.addRepresentation(representation);
      if (nativeIcon.isEmpty()) throw new Error("The native tray image could not be decoded.");
      if (this.tray && !this.tray.isDestroyed()) this.tray.setImage(nativeIcon);
      else {
        const candidate = new remote.Tray(nativeIcon);
        try {
          const actions: Record<TrayMenuAction, () => void> = { show: () => this.showWindows(), hide: () => this.hideWindows(), openSettings: () => this.openSettings(), relaunch: () => this.relaunch(), closeVault: () => { window.setTimeout(() => this.closeVault(), 0); } };
          const menu: MenuItemConstructorOptions[] = trayMenuRows(this.app.vault.getName()).map((row) => row.separator ? { type: "separator" } : { label: row.label, enabled: row.enabled, ...(row.action ? { click: actions[row.action] } : {}) });
          candidate.setContextMenu(remote.Menu.buildFromTemplate(menu)); candidate.setToolTip(`Vault: ${this.app.vault.getName()}`);
          candidate.on("click", () => process.platform === "darwin" ? candidate.popUpContextMenu() : this.toggleWindows());
          if (!this.loaded || version !== this.trayVersion || generation !== this.runtimeGeneration) { candidate.destroy(); return; }
          this.tray = candidate;
        } catch (error) { candidate.destroy(); throw error; }
      }
    }
    this.trayPreviewDataUrl = composed.previewDataUrl; this.settingsTab?.updatePreview(composed.previewDataUrl);
    await this.updateTaskbar();
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
    // relaunch() lets every vault's guard allow the quit; quit() (unlike exit) lets Obsidian save first.
    remote.app.relaunch();
    remote.app.quit();
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
    if (this.lifecycle.intent !== "none") this.loaded = false;
    this.runtimeGeneration++; this.trayVersion++; this.trayAbort?.abort();
    for (const candidate of this.pendingLinuxTrays) candidate.destroy();
    this.pendingLinuxTrays.clear();
    if (this.lifecycle.intent === "plugin-unload") this.safely(() => this.showWindows());
    this.runtimeActive = false;
    this.unregisterRuntimeCommands();
    this.releaseCloseInterceptors();
    this.traceGuard();
    this.safely(() => this.guard?.dispose());
    this.guard = undefined;
    window.removeEventListener("pagehide", this.pageHidden);
    if (this.rootWindow) {
      this.safely(() => this.rootWindow?.webContents.removeListener("did-create-window", this.windowCreated));
      this.rootWindow = undefined;
    }
    this.safely(() => remote.app.removeListener("before-quit", this.beforeQuit));
    this.safely(() => remote.app.removeListener("activate", this.appActivated));
    this.safely(() => remote.app.removeListener("second-instance", this.secondInstance));
    this.safely(() => remote.app.removeListener("browser-window-created", this.browserWindowCreated));
    for (const release of [...this.suppressedWindows.values()]) release();
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
    this.safely(() => this.appCoordinator?.release()); this.appCoordinator = undefined;
    this.safely(() => this.tray?.destroy());
    this.tray = undefined;
    this.linuxTray?.destroy();
    this.linuxTray = undefined;
  }

  private async loadSettings(): Promise<void> {
    await (window as unknown as Record<symbol, Promise<void> | undefined>)[SETTINGS_QUEUE]?.catch(() => {});
    const own = await this.loadData() as unknown;
    const hasOwn = Boolean(own && typeof own === "object" && Object.keys(own).length);
    const stored = hasOwn ? own : await this.readLegacy();
    this.settings = migrateSettings(stored, this.app.vault.getName()); this.desiredSettings = this.settings;
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

  async saveSettings(): Promise<void> { await this.saveData(this.settings); this.guard?.configure(this.closeOptions()); }
  getDesiredSetting(key: keyof TraySettings): TraySettings[keyof TraySettings] { return this.desiredSettings[key]; }
  getSettingsState() { return { pending: this.settingsPending, error: this.operationError || this.startupError, recovery: this.hasRecoveryTray(), preview: this.trayPreviewDataUrl }; }
  beginIconInput(): number { return ++this.iconInputRevision; }
  async setTrayImage(source: string, revision = this.beginIconInput()): Promise<void> {
    const normalized = TRAY_ICON_PRESETS.some((preset) => preset.dataUrl === source) ? source : await normalizeCustomIcon(source);
    if (revision !== this.iconInputRevision || !this.loaded) return;
    await this.queueSetting("trayIconImage", normalized, false);
  }
  requestSetting(key: keyof TraySettings, value: unknown): Promise<void> {
    if (key === "trayIconImage") return typeof value === "string" ? this.setTrayImage(value) : Promise.reject(new Error("Choose a local PNG/SVG image."));
    return this.queueSetting(key, value, key === "vaultBadge" || key === "badgeBackgroundColor");
  }
  retrySettings(): Promise<void> { return this.queueSetting(undefined, undefined, false); }
  reportError(error: unknown): void { this.operationError = error && typeof error === "object" && "message" in error && typeof error.message === "string" ? error.message : "The update failed. Retry the request."; this.settingsTab?.refreshStatus(); new Notice(`Run in Background: ${this.operationError}`); }

  private queueSetting(key: keyof TraySettings | undefined, value: unknown, deferred: boolean): Promise<void> {
    const candidate = { ...this.desiredSettings };
    if (key) {
      if (typeof candidate[key] !== typeof value) return Promise.reject(new Error("Invalid setting value"));
      (candidate as unknown as Record<string, unknown>)[key] = value;
      if (key === "hideTaskbarIcon" || key === "createTrayIcon") reconcileRecoveryPath(candidate, key);
    }
    this.desiredSettings = migrateSettings(candidate, this.app.vault.getName());
    const revision = ++this.requestRevision;
    this.settingsPending = true; this.operationError = ""; this.settingsTab?.refreshStatus();
    if (deferred) {
      const desired = this.desiredSettings;
      void composeTrayIcon(desired.trayIconImage || TRAY_ICON_PRESETS[0].dataUrl, desired.vaultBadge, desired.badgeBackgroundColor).then(composed => {
        if (this.loaded && revision === this.requestRevision) this.settingsTab?.updatePreview(composed.previewDataUrl);
      }).catch(() => {});
    }
    if (!key || ["pluginEnabled", "trayIconImage", "vaultBadge", "badgeBackgroundColor", "createTrayIcon"].includes(key)) this.trayAbort?.abort();
    this.debounceRelease?.();
    let timer: number | undefined;
    const delay = deferred ? new Promise<void>((resolve) => { this.debounceRelease = () => { if (timer) window.clearTimeout(timer); resolve(); }; timer = window.setTimeout(resolve, 150); }) : Promise.resolve();
    const host = window as unknown as Record<symbol, Promise<void> | undefined>;
    const next = (host[SETTINGS_QUEUE] ?? Promise.resolve()).catch(() => {}).then(async () => {
      await delay;
      if (revision !== this.requestRevision) return;
      const prior = { ...this.settings }, wanted = { ...this.desiredSettings };
      let saved = false;
      try {
        await this.saveData(wanted); saved = true;
        if (revision !== this.requestRevision) { await this.saveData(prior); return; }
        this.settings = wanted;
        if (this.loaded) await this.applySettings(prior);
        this.operationError = "";
      } catch (error) {
        if (revision !== this.requestRevision) return;
        this.settings = prior;
        if (saved) { try { await this.saveData(prior); } catch (rollbackError) { this.reportError(new Error(`The update failed and the saved settings could not be restored: ${String(rollbackError)}`)); throw rollbackError; } if (this.loaded) await this.applySettings(wanted, true).catch(() => {}); }
        this.reportError(error); throw error;
      } finally { if (revision === this.requestRevision) { this.settingsPending = false; this.settingsTab?.refreshStatus(); } }
    });
    host[SETTINGS_QUEUE] = next.catch(() => {});
    return next;
  }

  private async applySettings(prior: TraySettings, skipStartup = false): Promise<void> {
    if (this.settings.pluginEnabled && !this.runtimeActive) { await this.activateRuntime(false); return; }
    if (!this.settings.pluginEnabled && this.runtimeActive) { this.showWindows(); this.cleanup(); }
    this.guard?.configure(this.closeOptions());
    if (this.settings.runInBackground !== prior.runInBackground) { this.updateBackgroundMode(); if (this.runtimeActive) this.showWindows(); }
    if (this.settings.trayIconImage !== prior.trayIconImage || this.settings.vaultBadge !== prior.vaultBadge || this.settings.badgeBackgroundColor !== prior.badgeBackgroundColor || this.settings.createTrayIcon !== prior.createTrayIcon) await this.createTray();
    await this.updateTaskbar();
    if (!skipStartup && (this.startupError || this.settings.launchOnStartup !== prior.launchOnStartup || this.settings.hideOnLaunchMode !== prior.hideOnLaunchMode || this.settings.runInBackground !== prior.runInBackground || this.settings.pluginEnabled !== prior.pluginEnabled)) await this.updateLogin();
  }
}

class TraySettingsTab extends PluginSettingTab {
  private badgePreview?: HTMLImageElement;
  private statusEl?: HTMLElement;
  private retryButton?: HTMLButtonElement;
  private syncControls: (() => void)[] = [];
  private syncingControls = false;
  private pendingRequests = 0;
  private localError = "";
  constructor(app: ObsidianApp, private plugin: RunInBackgroundPlugin) { super(app, plugin); }

  override getSettingDefinitions(): SettingDefinitionItem[] {
    const definitions = traySettingDefinitions(process.platform);
    const entry = (definition: TraySettingDefinition) => {
      if (definition.kind === "toggle") return { name: definition.name, desc: definition.desc, control: { type: "toggle" as const, key: definition.key } };
      if (definition.kind === "dropdown") return { name: definition.name, desc: definition.desc, control: { type: "dropdown" as const, key: definition.key, options: { always: "Always", login: "Only when opened at login", never: "Never" } } };
      return { name: definition.name, desc: definition.desc, render: (setting: Setting) => this.renderControl(setting, definition) };
    };
    return [entry(definitions[0]!), { name: ABOUT_AND_FEEDBACK.heading, render: (setting: Setting) => { setting.setName(ABOUT_AND_FEEDBACK.heading).setHeading(); } },
      { name: ABOUT_AND_FEEDBACK.name, desc: ABOUT_AND_FEEDBACK.description, render: (setting: Setting) => this.aboutAndFeedback(setting) },
      { name: "Update status", render: (setting: Setting) => this.renderStatus(setting) },
      { type: "group", heading: "Window management", items: definitions.slice(1).map(entry) }];
  }
  override getControlValue(key: string): unknown { return key in this.plugin.settings ? this.plugin.getDesiredSetting(key as keyof TraySettings) : undefined; }
  override async setControlValue(key: string, value: unknown): Promise<void> { if (key in this.plugin.settings) { try { await this.plugin.requestSetting(key as keyof TraySettings, value); } catch { /* The pipeline exposes the failure and retry request. */ } finally { this.refreshStatus(); } } }
  override display(): void {
    this.containerEl.empty(); this.syncControls = [];
    const definitions = traySettingDefinitions(process.platform);
    this.renderControl(new Setting(this.containerEl), definitions[0]!);
    new Setting(this.containerEl).setName(ABOUT_AND_FEEDBACK.heading).setHeading(); this.aboutAndFeedback(new Setting(this.containerEl));
    this.renderStatus(new Setting(this.containerEl));
    new Setting(this.containerEl).setName("Window management").setHeading();
    for (const definition of definitions.slice(1)) this.renderControl(new Setting(this.containerEl), definition);
  }
  private change(key: keyof TraySettings, value: unknown): void { if (!this.syncingControls) this.commit(() => this.plugin.requestSetting(key, value)); }
  private commit(action: () => Promise<void>): void {
    this.pendingRequests++; this.localError = ""; this.refreshStatus();
    void Promise.resolve().then(action).then(() => { this.updatePreview(this.plugin.getSettingsState().preview); }).catch((error: unknown) => { this.localError = error && typeof error === "object" && "message" in error && typeof error.message === "string" ? error.message : "The update failed. Retry the request."; }).finally(() => { this.pendingRequests--; this.refreshStatus(); });
  }
  private renderControl(setting: Setting, definition: TraySettingDefinition): void {
    setting.setName(definition.name).setDesc(definition.desc);
    if (definition.kind === "toggle") setting.addToggle(control => {
      const sync = (): void => { control.setValue(Boolean(this.plugin.getDesiredSetting(definition.key))); }; sync(); this.syncControls.push(sync);
      control.onChange(value => this.change(definition.key, value));
    });
    else if (definition.kind === "dropdown") setting.addDropdown(control => {
      control.addOption("always", "Always").addOption("login", "Only when opened at login").addOption("never", "Never");
      const sync = (): void => { control.setValue(String(this.plugin.getDesiredSetting(definition.key))); }; sync(); this.syncControls.push(sync);
      control.onChange(value => this.change(definition.key, value));
    });
    else if (definition.kind === "icon") this.renderTrayImageControl(setting);
    else this.renderVaultBadgeControl(setting);
  }
  private renderStatus(setting: Setting): void {
    setting.setName("Update status"); this.statusEl = setting.descEl; this.statusEl.setAttribute("role", "status"); this.statusEl.setAttribute("aria-live", "polite");
    setting.addButton(button => { this.retryButton = button.buttonEl; button.setButtonText("Retry").onClick(() => { this.commit(() => this.plugin.retrySettings()); }); });
    this.refreshStatus();
  }
  refreshStatus(): void {
    const state = this.plugin.getSettingsState(), pending = state.pending || this.pendingRequests > 0, error = this.localError || state.error;
    if (this.statusEl) this.statusEl.textContent = pending ? "Saving and applying changes…" : error || `Settings saved. Recovery tray: ${state.recovery ? "available" : "unavailable; Dock/taskbar stays visible"}.`;
    if (this.retryButton) { this.retryButton.hidden = !error; this.retryButton.style.setProperty("display", error ? "" : "none", "important"); this.retryButton.disabled = pending; }
    this.syncingControls = true;
    try { for (const sync of this.syncControls) sync(); } finally { this.syncingControls = false; }
  }
  private aboutAndFeedback(setting: Setting): void {
    setting
      .setName(ABOUT_AND_FEEDBACK.name)
      .setDesc(ABOUT_AND_FEEDBACK.description)
      .addButton((button) => button.setButtonText(ABOUT_AND_FEEDBACK.websiteLabel).setCta().onClick(() => openExternalLink(WEBSITE_URL)))
      .addButton((button) => button.setButtonText(ABOUT_AND_FEEDBACK.morePluginsLabel).onClick(() => openExternalLink(MORE_PLUGINS_URL)))
      .addButton((button) => button.setButtonText(ABOUT_AND_FEEDBACK.featureRequestLabel).onClick(() => openExternalLink(FEATURE_REQUEST_URL)))
      .addButton((button) => button.setButtonText(ABOUT_AND_FEEDBACK.bugReportLabel).onClick(() => openExternalLink(BUG_REPORT_URL)));
  }

  private renderTrayImageControl(setting: Setting): void {
    setting.controlEl.setCssStyles({ gap: "8px", flexWrap: "wrap" });
    const buttons: HTMLButtonElement[] = [];
    for (const preset of TRAY_ICON_PRESETS) {
      const button = setting.controlEl.createEl("button", { cls: "clickable-icon", attr: { "aria-label": preset.name, title: preset.name } }); buttons.push(button);
      button.dataset.preset = preset.id; button.setCssStyles({ width: "40px", height: "40px", minWidth: "40px", minHeight: "40px", flexShrink: "0", padding: "4px", borderRadius: "8px" });
      button.createEl("img", { attr: { src: preset.dataUrl, alt: "" } }).setCssStyles({ width: "30px", height: "30px", objectFit: "contain" });
      button.addEventListener("click", () => this.change("trayIconImage", preset.dataUrl));
    }
    const preview = setting.controlEl.createEl("img", { attr: { alt: "Uploaded custom icon" } }); this.stylePreview(preview);
    const sync = (): void => {
      const source = String(this.plugin.getDesiredSetting("trayIconImage")); const selected = TRAY_ICON_PRESETS.find(preset => preset.dataUrl === source)?.id;
      for (const button of buttons) { const active = button.dataset.preset === selected; button.classList.toggle("mod-cta", active); button.setAttribute("aria-pressed", String(active)); }
      preview.hidden = Boolean(selected); if (!selected) preview.src = source;
    }; sync(); this.syncControls.push(sync);
    setting.addButton(button => button.setButtonText("Upload your own").onClick(() => {
      const input = createEl("input", { attr: { type: "file", accept: "image/png,image/svg+xml,.png,.svg" } });
      input.onchange = () => {
        const file = input.files?.[0]; if (!file) return;
        const revision = this.plugin.beginIconInput();
        if (file.size > MAX_ICON_BYTES || !/\.(png|svg)$/iu.test(file.name)) { this.plugin.reportError(new Error("Choose a PNG/SVG file up to 256 KiB.")); return; }
        const reader = new FileReader(); reader.onerror = () => this.plugin.reportError(new Error("The image could not be read."));
        reader.onload = () => { const source = reader.result; if (typeof source === "string") this.commit(() => this.plugin.setTrayImage(source, revision)); };
        reader.readAsDataURL(file);
      }; input.click();
    }));
  }
  private renderVaultBadgeControl(setting: Setting): void {
    this.badgePreview = setting.controlEl.createEl("img", { attr: { src: this.plugin.trayPreviewDataUrl, alt: "Tray icon with vault badge" } }); this.stylePreview(this.badgePreview, 64);
    setting.addText(control => {
      control.setPlaceholder("G B C").setValue(String(this.plugin.getDesiredSetting("vaultBadge")));
      this.syncControls.push(() => { const value = String(this.plugin.getDesiredSetting("vaultBadge")); if (control.getValue() !== value) control.setValue(value); });
      control.onChange(value => { const normalized = normalizeVaultBadge(value); if (value !== normalized) { const caret = control.inputEl.selectionStart; control.setValue(normalized); if (caret !== null) control.inputEl.setSelectionRange(Math.min(caret, normalized.length), Math.min(caret, normalized.length)); } this.change("vaultBadge", normalized); });
    }).addColorPicker(control => {
      control.setValue(String(this.plugin.getDesiredSetting("badgeBackgroundColor"))).onChange(value => this.change("badgeBackgroundColor", value));
      this.syncControls.push(() => { control.setValue(String(this.plugin.getDesiredSetting("badgeBackgroundColor"))); });
    });
  }
  updatePreview(dataUrl: string): void { if (this.badgePreview) this.badgePreview.src = dataUrl; }
  private stylePreview(preview: HTMLImageElement, size = 32): void { preview.setCssStyles({ width: `${size}px`, height: `${size}px`, objectFit: "contain", imageRendering: "auto" }); }
}

function openExternalLink(url: string): void {
  window.open(url, "_blank", "noopener,noreferrer");
}
