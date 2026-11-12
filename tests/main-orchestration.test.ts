import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { defaultSettings, migrateSettings, type TraySettings } from "../src/settings";
class Contents extends EventEmitter {
  throttling = true; chooser = false; url = "app://obsidian.md"; probeGate?: Promise<boolean>;
  getBackgroundThrottling(): boolean { return this.throttling; }
  setBackgroundThrottling(value: boolean): void { this.throttling = value; }
  isDestroyed(): boolean { return false; }
  getURL(): string { return this.url; }
  executeJavaScript(): Promise<boolean> { return this.probeGate ?? Promise.resolve(this.chooser); }
}
class VaultWindow extends EventEmitter {
  webContents = new Contents(); hidden = false; skip = false; destroyed = false; focusCount = 0;
  isDestroyed(): boolean { return this.destroyed; } isVisible(): boolean { return !this.hidden; } isFocused(): boolean { return false; } isMaximized(): boolean { return false; }
  setSkipTaskbar(value: boolean): void { this.skip = value; } getTitle(): string { return "Synthetic"; }
  show(): void { this.hidden = false; } hide(): void { this.hidden = true; } blur(): void {} focus(): void { this.focusCount++; }
  close(): void { this.destroyed = true; this.emit("closed"); }
}
interface TestPlugin {
  settings: TraySettings; desiredSettings: TraySettings; loaded: boolean; runtimeActive: boolean; cleaned: boolean;
  operationError: string; settingsPending: boolean; trayPreviewDataUrl: string; lastSecondInstanceAt: number;
  backgroundThrottling: Map<unknown, unknown>; windowContents: Map<unknown, unknown>;
  onload(): Promise<void>; onunload(): void; requestSetting(key: keyof TraySettings, value: unknown): Promise<void>; retrySettings(): Promise<void>; createTray(): Promise<void>; hasRecoveryTray(): boolean;
  browserWindowCreated(event: unknown, window: VaultWindow): void; track(window: VaultWindow): void;
}
let bundle = ""; const roots: string[] = [];
beforeAll(async () => { const result = await build({ entryPoints: ["src/main.ts"], bundle: true, external: ["obsidian", "electron", "@codemirror/state", "@codemirror/view"], platform: "node", format: "cjs", target: "es2022", minify: true, write: false }); bundle = result.outputFiles[0]!.text; });
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function setup(enabled = false) {
  const root = await mkdtemp(join(tmpdir(), "rib-shipped-")); roots.push(root);
  const window = new VaultWindow(), appEvents = new EventEmitter(); let stored = migrateSettings({ ...defaultSettings("Synthetic"), pluginEnabled: enabled }, "Synthetic");
  let saveGate: Promise<void> | undefined, failSave = false, failTray = false, decodeGate: Promise<void> | undefined;
  let saves = 0, trayCreates = 0, trayDestroyed = 0, trayUpdates = 0;
  const tabs: unknown[] = [];
  class Plugin {
    constructor(readonly app: unknown) {} settings = stored; manifest = { id: "run-in-background" };
    loadData(): Promise<TraySettings> { return Promise.resolve(stored); }
    async saveData(value: TraySettings): Promise<void> { saves++; await saveGate; if (failSave) throw new Error("Disk full"); stored = { ...value }; }
    addSettingTab(tab: unknown): void { tabs.push(tab); } addCommand(): void {} removeCommand(): void {}
  }
  class Tab { constructor(readonly app: unknown, readonly plugin: unknown) {} }
  class Tray extends EventEmitter {
    destroyed = false;
    constructor() { super(); if (failTray) throw new Error("Native tray unavailable"); trayCreates++; }
    destroy(): void { if (!this.destroyed) trayDestroyed++; this.destroyed = true; }
    isDestroyed(): boolean { return this.destroyed; } setImage(): void { trayUpdates++; }
    setContextMenu(): void {} setToolTip(): void {} popUpContextMenu(): void {}
  }
  const nativeApp = Object.assign(appEvents, { dock: { hide: vi.fn(), show: vi.fn() }, getPath: () => root, getLoginItemSettings: () => ({ openAtLogin: false, openAsHidden: false }), setLoginItemSettings: vi.fn(), getName: () => "Obsidian", relaunch: vi.fn(), quit: vi.fn() });
  const remote = { app: nativeApp, getCurrentWindow: () => window, BrowserWindow: { getAllWindows: () => [window] }, Tray, Menu: { buildFromTemplate: (items: unknown) => items }, nativeImage: { createEmpty: () => ({ addRepresentation: () => {}, isEmpty: () => false }) }, require: () => ({ runInThisContext: (code: string) => runInNewContext(code, { process, console, setTimeout }) as unknown }) };
  class Image {
    naturalWidth = 32; naturalHeight = 32; onload?: () => void; onerror?: () => void;
    set src(_value: string) { void (decodeGate ?? Promise.resolve()).then(() => this.onload?.()); }
  }
  const context = { drawImage: () => {}, getImageData: (_x: number, _y: number, width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4) }), beginPath: () => {}, roundRect: () => {}, fill: () => {}, scale: () => {}, fillText: () => {} };
  const require = createRequire(join(process.cwd(), "package.json")); const module = { exports: {} };
  const host = Object.assign(new EventEmitter(), { require: () => ({ remote }), setTimeout, clearTimeout, addEventListener: () => {}, removeEventListener: () => {}, open: () => {} });
  runInNewContext(bundle, { module, exports: module.exports, require: (id: string) => id === "obsidian" ? { Plugin, PluginSettingTab: Tab, Setting: class {}, Notice: class {}, FileSystemAdapter: class {}, normalizePath: (path: string) => path } : require(id) as unknown, window: host, process, Buffer, console, setTimeout, clearTimeout, setImmediate, clearImmediate, AbortController, TextEncoder, atob, Image, createEl: () => ({ width: 0, height: 0, getContext: () => context, toDataURL: () => "data:image/png;base64,iVBORw0KGgo=" }) });
  const Constructor = (module.exports as { default: new (app: unknown) => TestPlugin }).default;
  const plugin = new Constructor({ vault: { getName: () => "Synthetic", configDir: ".obsidian", adapter: { exists: () => Promise.resolve(false) } }, workspace: { onLayoutReady: (callback: () => void) => callback() } });
  // The adapter remains deliberately non-filesystem: no real vault can enter these tests.
  await plugin.onload();
  return { plugin, window, tabs, nativeApp, setSaveGate: (value?: Promise<void>) => { saveGate = value; }, setDecodeGate: (value?: Promise<void>) => { decodeGate = value; }, setFailSave: (value: boolean) => { failSave = value; }, setFailTray: (value: boolean) => { failTray = value; }, counts: () => ({ saves, trayCreates, trayDestroyed, trayUpdates }), stored: () => stored };
}
describe("production-bundled coordinator", () => {
  it("does not change runtime or saved values before durable success, then supports retry", async () => {
    const fixture = await setup(); fixture.setFailSave(true);
    await expect(fixture.plugin.requestSetting("runInBackground", false)).rejects.toThrow("Disk full");
    expect(fixture.plugin.settings.runInBackground).toBe(true); expect(fixture.stored().runInBackground).toBe(true); expect(fixture.plugin.operationError).toContain("Disk full");
    fixture.setFailSave(false); await fixture.plugin.retrySettings(); expect(fixture.stored().runInBackground).toBe(false); expect(fixture.plugin.settings.runInBackground).toBe(false); fixture.plugin.onunload();
  });
  it("settles pending writes in order without stale runtime effects", async () => {
    const fixture = await setup(); let finish!: () => void; fixture.setSaveGate(new Promise<void>(resolve => { finish = resolve; }));
    const older = fixture.plugin.requestSetting("runInBackground", false); await Promise.resolve(); await Promise.resolve();
    const newer = fixture.plugin.requestSetting("keepRunningAfterQuit", false); fixture.setSaveGate(); finish(); await older;
    await newer; expect(fixture.stored().runInBackground).toBe(false); expect(fixture.stored().keepRunningAfterQuit).toBe(false);
    fixture.plugin.onunload();
  });
  it("rolls back failed native activation without partial app listeners or guards", async () => {
    const fixture = await setup(); fixture.setFailTray(true);
    await expect(fixture.plugin.requestSetting("pluginEnabled", true)).rejects.toThrow("Native tray unavailable");
    expect(fixture.plugin.runtimeActive).toBe(false); expect(fixture.stored().pluginEnabled).toBe(false); expect(fixture.window.hidden).toBe(false);
    expect(fixture.nativeApp.listenerCount("before-quit")).toBe(0); expect(fixture.nativeApp.listenerCount("browser-window-created")).toBe(0); fixture.plugin.onunload();
  });
  it("coalesces ten rapid badge edits to one save and one existing tray update", async () => {
    const fixture = await setup(true); const before = fixture.counts();
    await Promise.all(Array.from({ length: 10 }, (_, index) => fixture.plugin.requestSetting("vaultBadge", String(index))));
    const after = fixture.counts(); expect(after.saves - before.saves).toBe(1); expect(after.trayCreates).toBe(1); expect(after.trayUpdates - before.trayUpdates).toBe(1); expect(fixture.stored().vaultBadge).toBe("9"); fixture.plugin.onunload();
  });
  it("ignores late image completion after unload and preserves the old tray on invalid upload", async () => {
    const fixture = await setup(true); await expect(fixture.plugin.requestSetting("trayIconImage", "https://example.test/icon.png")).rejects.toThrow("local PNG"); expect(fixture.plugin.hasRecoveryTray()).toBe(true);
    let finish!: () => void; fixture.setDecodeGate(new Promise<void>(resolve => { finish = resolve; })); fixture.plugin.settings.trayIconImage = "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2216%22%20height%3D%2216%22%2F%3E";
    const pending = fixture.plugin.createTray(); fixture.plugin.onunload(); finish(); await expect(pending).rejects.toThrow("superseded"); await Promise.resolve(); expect(fixture.counts().trayCreates).toBe(1); expect(fixture.counts().trayDestroyed).toBe(1);
  });
  it("keeps unknown windows visible and cancels chooser probes on unload", async () => {
    const fixture = await setup(true), unknown = new VaultWindow(); fixture.plugin.lastSecondInstanceAt = Date.now(); fixture.plugin.browserWindowCreated({}, unknown);
    await new Promise(resolve => setTimeout(resolve, 20)); expect(unknown.hidden).toBe(false); expect(unknown.skip).toBe(false);
    const chooser = new VaultWindow(); chooser.webContents.url = "app://obsidian.md/starter.html"; let finish!: (value: boolean) => void; chooser.webContents.probeGate = new Promise<boolean>(resolve => { finish = resolve; }); fixture.plugin.browserWindowCreated({}, chooser);
    await new Promise(resolve => setTimeout(resolve, 10)); fixture.plugin.onunload(); finish(true); await Promise.resolve(); await Promise.resolve();
    expect(chooser.hidden).toBe(false); expect(chooser.listenerCount("show")).toBe(0); expect(chooser.webContents.listenerCount("did-finish-load")).toBe(0);
  });
  it("does not echo programmatic toggle synchronization into extra setting writes", async () => {
    const fixture = await setup(), before = fixture.counts().saves;
    let changed: ((value: boolean) => void) | undefined;
    const control = { value: false, setValue(value: boolean) { if (this.value !== value) { this.value = value; changed?.(value); } return this; }, onChange(handler: (value: boolean) => void) { changed = handler; return this; } };
    const setting = { setName() { return this; }, setDesc() { return this; }, addToggle(render: (input: typeof control) => void) { render(control); return this; } };
    const tab = fixture.tabs[0] as { renderControl(setting: unknown, definition: unknown): void };
    tab.renderControl(setting, { name: "Enable Run in Background", desc: "", key: "pluginEnabled", kind: "toggle" }); control.setValue(true);
    await vi.waitFor(() => expect(fixture.plugin.runtimeActive).toBe(true));
    expect(control.value).toBe(true); expect(fixture.counts().saves - before).toBe(1); fixture.plugin.onunload();
  });
  it("can disable and enable again without losing its settings page", async () => {
    const fixture = await setup(true); await fixture.plugin.requestSetting("pluginEnabled", false); expect(fixture.plugin.runtimeActive).toBe(false); expect(fixture.plugin.loaded).toBe(true);
    await fixture.plugin.requestSetting("pluginEnabled", true); expect(fixture.plugin.runtimeActive).toBe(true); expect(fixture.plugin.hasRecoveryTray()).toBe(true); fixture.plugin.onunload();
  });
  it("suppresses only a proved chooser and restores it before navigation", async () => {
    const fixture = await setup(true), chooser = new VaultWindow(); chooser.webContents.url = "app://obsidian.md/starter.html"; chooser.webContents.chooser = true;
    fixture.plugin.lastSecondInstanceAt = Date.now(); fixture.plugin.browserWindowCreated({}, chooser); await new Promise(resolve => setTimeout(resolve, 20));
    expect(chooser.hidden).toBe(true); expect(chooser.skip).toBe(false); chooser.webContents.emit("did-start-navigation"); expect(chooser.hidden).toBe(false); expect(chooser.listenerCount("show")).toBe(0); fixture.plugin.onunload();
  });
  it("returns retained popout maps to their starting size after 100 closes", async () => {
    const fixture = await setup(true), initial = fixture.plugin.backgroundThrottling.size;
    for (let index = 0; index < 100; index++) { const popout = new VaultWindow(); fixture.plugin.track(popout); popout.close(); expect(fixture.plugin.backgroundThrottling.size).toBe(initial); expect(fixture.plugin.windowContents.size).toBe(initial); }
    fixture.plugin.onunload(); expect(fixture.plugin.backgroundThrottling.size).toBe(0);
  });
});
