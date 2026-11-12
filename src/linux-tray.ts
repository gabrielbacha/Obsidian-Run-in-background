import { trayMenuRows } from "./tray-menu";
import {
  DBusError,
  defineInterface,
  sessionBus,
  Variant,
  type ExportRegistration,
  type MessageBus,
  type Subscription,
  type DefinedInterface,
} from "dbus-native";

const ITEM_PATH = "/StatusNotifierItem";
const MENU_PATH = "/MenuBar";
const ITEM_INTERFACE = "org.kde.StatusNotifierItem";
const MENU_INTERFACE = "com.canonical.dbusmenu";

export interface LinuxTrayPixmap {
  width: number;
  height: number;
  data: Uint8Array;
}

export interface LinuxTrayActions {
  show(): void;
  hide(): void;
  toggle(): void;
  openSettings(): void;
  relaunch(): void;
  closeVault(): void;
}

interface StatusNotifierWatcher {
  RegisterStatusNotifierItem(service: string): PromiseLike<void>;
}

type MenuLayout = [number, Record<string, Variant>, Variant[]];

function menuProperties(label = "", enabled = true, separator = false): Record<string, Variant> {
  return { label: new Variant("s", label), enabled: new Variant("b", enabled), visible: new Variant("b", true), type: new Variant("s", separator ? "separator" : "standard") };
}
function filterProperties(properties: Record<string, Variant>, requested: string[]): Record<string, Variant> {
  return requested.length ? Object.fromEntries(Object.entries(properties).filter(([name]) => requested.includes(name))) : { ...properties };
}
export function linuxTrayMenuLayout(vault: string, parentId = 0, depth = -1, requested: string[] = []): MenuLayout {
  if (parentId === 0) return [0, {}, depth === 0 ? [] : trayMenuRows(vault).map((row) => new Variant("(ia{sv}av)", [row.id, filterProperties(menuProperties(row.label, row.enabled, row.separator), requested), []]))];
  const row = trayMenuRows(vault).find((item) => item.id === parentId);
  if (!row) { const error = new DBusError("Unknown menu item"); error.dbusName = "org.freedesktop.DBus.Error.InvalidArgs"; throw error; }
  return [row.id, filterProperties(menuProperties(row.label, row.enabled, row.separator), requested), []];
}

export class LinuxStatusNotifierTray {
  private bus?: MessageBus;
  private registrations: ExportRegistration[] = [];
  private subscription?: Subscription;
  private itemInterface?: DefinedInterface;
  private ownerSignal?: string;
  private disposed = true;
  private registrationEpoch = 0;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private available = false;
  private registrationTail: Promise<void> = Promise.resolve();


  constructor(
    private readonly vault: string,
    private pixmaps: ReadonlyArray<LinuxTrayPixmap>,
    private readonly actions: LinuxTrayActions,
    private readonly options: { busFactory?: () => MessageBus; availability?: (available: boolean) => void } = {},
  ) {}

  isAvailable(): boolean { return this.available && !this.disposed; }
  updateIcon(pixmaps: ReadonlyArray<LinuxTrayPixmap>): void {
    this.pixmaps = pixmaps;
    if (this.isAvailable()) this.itemInterface?.emit.NewIcon?.();
  }
  private availability(value: boolean): void {
    if (this.available === value) return;
    this.available = value; this.options.availability?.(value);
  }
  private ownerChanged = (body: unknown[]): void => {
    if (body[0] !== "org.kde.StatusNotifierWatcher" || this.disposed) return;
    this.registrationEpoch++; this.availability(false);
    if (body[2]) this.recoverRegistration();
  };
  private disconnected = (): void => { this.registrationEpoch++; this.availability(false); };
  private reconnected = (): void => this.recoverRegistration();
  private recoverRegistration(): void {
    if (this.disposed || !this.bus) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    const bus = this.bus;
    this.registrationTail = this.registrationTail.catch(() => {}).then(() => this.registerWatcher(bus)).catch(() => {
      if (!this.disposed) this.retryTimer = setTimeout(() => this.recoverRegistration(), 500);
    });
  }
  private async registerWatcher(bus: MessageBus): Promise<void> {
    const epoch = ++this.registrationEpoch;
    const watcher = await bus.getInterface<StatusNotifierWatcher>("org.kde.StatusNotifierWatcher", "/StatusNotifierWatcher", "org.kde.StatusNotifierWatcher");
    if (!bus.name) throw new Error("The session bus did not assign a unique name");
    await watcher.RegisterStatusNotifierItem(bus.name);
    if (!this.disposed && this.bus === bus && this.registrationEpoch === epoch) this.availability(true);
  }
  private menuEvent(id: number, eventId: string): boolean {
    const row = trayMenuRows(this.vault).find((item) => item.id === id);
    if (!row) return false;
    if (eventId !== "clicked") return true;
    if (!row.enabled || !row.action) return false;
    this.actions[row.action](); return true;
  }


  async create(): Promise<void> {
    this.disposed = false;
    const bus = this.options.busFactory?.() ?? sessionBus({ timeout: 5000, reconnect: true });
    this.bus = bus;
    try {
    await bus.listNames();
    if (this.disposed || this.bus !== bus) throw new Error("Tray creation was cancelled");
    const item = defineInterface({
      name: ITEM_INTERFACE,
      methods: {
        Activate: { in: { x: "i", y: "i" }, handler: () => this.actions.toggle() },
        SecondaryActivate: { in: { x: "i", y: "i" }, handler: () => this.actions.toggle() },
        ContextMenu: { in: { x: "i", y: "i" }, handler: () => undefined },
        Scroll: { in: { delta: "i", orientation: "s" }, handler: () => undefined },
      },
      properties: {
        Category: { type: "s", access: "read", value: "ApplicationStatus" },
        Id: { type: "s", access: "read", value: `obsidian-run-in-background-${this.vault}` },
        Title: { type: "s", access: "read", value: `Vault: ${this.vault}` },
        Status: { type: "s", access: "read", value: "Active" },
        WindowId: { type: "u", access: "read", value: 0 },
        IconName: { type: "s", access: "read", value: "" },
        IconPixmap: { type: "a(iiay)", access: "read", get: () => this.pixmaps.map(({ width, height, data }) => [width, height, data]) },
        OverlayIconName: { type: "s", access: "read", value: "" },
        OverlayIconPixmap: { type: "a(iiay)", access: "read", value: [] },
        AttentionIconName: { type: "s", access: "read", value: "" },
        AttentionIconPixmap: { type: "a(iiay)", access: "read", value: [] },
        AttentionMovieName: { type: "s", access: "read", value: "" },
        ToolTip: { type: "(sa(iiay)ss)", access: "read", value: ["", [], `Vault: ${this.vault}`, ""] },
        ItemIsMenu: { type: "b", access: "read", value: false },
        Menu: { type: "o", access: "read", value: MENU_PATH },
      },
      signals: {
        NewTitle: {},
        NewIcon: {},
        NewAttentionIcon: {},
        NewOverlayIcon: {},
        NewToolTip: {},
        NewStatus: { args: { status: "s" } },
      },
    });
    const menu = defineInterface({
      name: MENU_INTERFACE,
      methods: {
        GetLayout: {
          in: { parentId: "i", recursionDepth: "i", propertyNames: "as" },
          out: { revision: "u", layout: "(ia{sv}av)" },
          handler: ({ parentId, recursionDepth, propertyNames }: { parentId: number; recursionDepth: number; propertyNames: string[] }) => ({ revision: 1, layout: linuxTrayMenuLayout(this.vault, parentId, recursionDepth, propertyNames) }),
        },
        GetGroupProperties: {
          in: { ids: "ai", propertyNames: "as" },
          out: { properties: "a(ia{sv})" },
          handler: ({ ids, propertyNames }: { ids: number[]; propertyNames: string[] }) => ids.filter((id) => id === 0 || trayMenuRows(this.vault).some((row) => row.id === id)).map((id) => { const layout = linuxTrayMenuLayout(this.vault, id, 0, propertyNames); return [id, id === 0 ? filterProperties(menuProperties(), propertyNames) : layout[1]]; }),
        },
        GetProperty: {
          in: { id: "i", name: "s" },
          out: { value: "v" },
          handler: ({ id, name }: { id: number; name: string }) => { const value = (id === 0 ? menuProperties() : linuxTrayMenuLayout(this.vault, id, 0)[1])[name]; if (!value) { const error = new DBusError("Unknown menu property"); error.dbusName = "org.freedesktop.DBus.Error.InvalidArgs"; throw error; } return value; },
        },
        Event: {
          in: { id: "i", eventId: "s", data: "v", timestamp: "u" },
          handler: ({ id, eventId }: { id: number; eventId: string }) => { if (!this.menuEvent(id, eventId)) { const error = new DBusError("Invalid menu event"); error.dbusName = "org.freedesktop.DBus.Error.InvalidArgs"; throw error; } },
        },
        EventGroup: {
          in: { events: "a(isvu)" },
          out: { idErrors: "ai" },
          handler: ({ events }: { events: Array<[number, string, Variant, number]> }) => { const errors: number[] = []; for (const [id, eventId] of events) if (!this.menuEvent(id, eventId)) errors.push(id); return errors; },
        },
        AboutToShow: {
          in: { id: "i" },
          out: { needUpdate: "b" },
          handler: ({ id }: { id: number }) => { linuxTrayMenuLayout(this.vault, id, 0); return false; },
        },
        AboutToShowGroup: {
          in: { ids: "ai" },
          out: { updatesNeeded: "ai", idErrors: "ai" },
          handler: ({ ids }: { ids: number[] }) => ({ updatesNeeded: [], idErrors: ids.filter((id) => id !== 0 && !trayMenuRows(this.vault).some((row) => row.id === id)) }),
        },
      },
      properties: {
        Version: { type: "u", access: "read", value: 3 },
        TextDirection: { type: "s", access: "read", value: "ltr" },
        Status: { type: "s", access: "read", value: "normal" },
        IconThemePath: { type: "as", access: "read", value: [] },
      },
      signals: {
        ItemsPropertiesUpdated: { args: { updatedProps: "a(ia{sv})", removedProps: "a(ias)" } },
        LayoutUpdated: { args: { revision: "u", parent: "i" } },
        ItemActivationRequested: { args: { id: "i", timestamp: "u" } },
      },
    });
    this.itemInterface = item;
    this.registrations.push(await bus.export(ITEM_PATH, item));
    if (this.disposed || this.bus !== bus) throw new Error("Tray creation was cancelled");
    this.registrations.push(await bus.export(MENU_PATH, menu));
    if (this.disposed || this.bus !== bus) throw new Error("Tray creation was cancelled");
    this.ownerSignal = bus.mangle("/org/freedesktop/DBus", "org.freedesktop.DBus", "NameOwnerChanged");
    this.subscription = await bus.watch("type='signal',sender='org.freedesktop.DBus',interface='org.freedesktop.DBus',member='NameOwnerChanged',arg0='org.kde.StatusNotifierWatcher'");
    if (this.disposed || this.bus !== bus) throw new Error("Tray creation was cancelled");
    bus.signals.on(this.ownerSignal, this.ownerChanged);
    bus.connection.on("end", this.disconnected);
    bus.on("reconnected", this.reconnected);
    bus.on("reconnectError", this.reconnected);
    bus.on("error", this.disconnected);
    await this.registerWatcher(bus);
    if (this.disposed || this.bus !== bus) throw new Error("Tray creation was cancelled");
    } catch (error) { await this.dispose(); throw error; }
  }

  private async dispose(): Promise<void> {
    this.disposed = true; this.registrationEpoch++;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.availability(false);
    const bus = this.bus; this.bus = undefined;
    if (bus) {
      if (this.ownerSignal) bus.signals.removeListener(this.ownerSignal, this.ownerChanged);
      bus.connection.removeListener("end", this.disconnected);
      bus.removeListener("reconnected", this.reconnected);
      bus.removeListener("reconnectError", this.reconnected);
      bus.removeListener("error", this.disconnected);
    }
    await this.subscription?.remove().catch(() => {});
    this.subscription = undefined;
    this.itemInterface = undefined;
    for (const registration of this.registrations.splice(0)) await registration.remove().catch(() => {});
    await bus?.close().catch(() => {});
  }

  destroy(): void { void this.dispose(); }
}
