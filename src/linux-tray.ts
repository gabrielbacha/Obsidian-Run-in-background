import {
  defineInterface,
  sessionBus,
  Variant,
  type ExportRegistration,
  type MessageBus,
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

function menuProperties(label?: string, enabled = true, type?: string): Record<string, Variant> {
  const properties: Record<string, Variant> = {};
  if (label !== undefined) properties.label = new Variant("s", label);
  if (!enabled) properties.enabled = new Variant("b", false);
  if (type) properties.type = new Variant("s", type);
  return properties;
}

export function linuxTrayMenuLayout(vault: string): MenuLayout {
  const item = (id: number, properties: Record<string, Variant>): Variant => new Variant(
    "(ia{sv}av)",
    [id, properties, []],
  );
  return [0, {}, [
    item(1, menuProperties(`Vault: ${vault}`, false)),
    item(2, menuProperties(undefined, true, "separator")),
    item(3, menuProperties("Show Vault")),
    item(4, menuProperties("Hide Vault")),
    item(5, menuProperties("Open Plugin Settings")),
    item(6, menuProperties(undefined, true, "separator")),
    item(7, menuProperties("Relaunch Obsidian")),
    item(8, menuProperties("Close Vault")),
  ]];
}

export class LinuxStatusNotifierTray {
  private bus?: MessageBus;
  private registrations: ExportRegistration[] = [];

  constructor(
    private readonly vault: string,
    private readonly pixmaps: ReadonlyArray<LinuxTrayPixmap>,
    private readonly actions: LinuxTrayActions,
  ) {}

  async create(): Promise<void> {
    const bus = sessionBus();
    this.bus = bus;
    await bus.listNames();
    const iconPixmaps = this.pixmaps.map(({ width, height, data }) => [width, height, data]);
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
        IconPixmap: { type: "a(iiay)", access: "read", value: iconPixmaps },
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
          handler: () => ({ revision: 1, layout: linuxTrayMenuLayout(this.vault) }),
        },
        GetGroupProperties: {
          in: { ids: "ai", propertyNames: "as" },
          out: { properties: "a(ia{sv})" },
          handler: () => [],
        },
        GetProperty: {
          in: { id: "i", name: "s" },
          out: { value: "v" },
          handler: () => new Variant("s", ""),
        },
        Event: {
          in: { id: "i", eventId: "s", data: "v", timestamp: "u" },
          handler: ({ id, eventId }: { id: number; eventId: string }) => {
            if (eventId !== "clicked") return;
            const action = new Map<number, () => void>([
              [3, () => this.actions.show()],
              [4, () => this.actions.hide()],
              [5, () => this.actions.openSettings()],
              [7, () => this.actions.relaunch()],
              [8, () => this.actions.closeVault()],
            ]).get(id);
            action?.();
          },
        },
        EventGroup: {
          in: { events: "a(isvu)" },
          out: { idErrors: "ai" },
          handler: () => [],
        },
        AboutToShow: {
          in: { id: "i" },
          out: { needUpdate: "b" },
          handler: () => false,
        },
        AboutToShowGroup: {
          in: { ids: "ai" },
          out: { updatesNeeded: "ai", idErrors: "ai" },
          handler: () => ({ updatesNeeded: [], idErrors: [] }),
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
    this.registrations = [await bus.export(ITEM_PATH, item), await bus.export(MENU_PATH, menu)];
    const watcher = await bus.getInterface<StatusNotifierWatcher>(
      "org.kde.StatusNotifierWatcher",
      "/StatusNotifierWatcher",
      "org.kde.StatusNotifierWatcher",
    );
    if (!bus.name) throw new Error("The session bus did not assign a unique name");
    await watcher.RegisterStatusNotifierItem(bus.name);
  }

  destroy(): void {
    const bus = this.bus;
    this.bus = undefined;
    this.registrations = [];
    if (bus) void bus.close();
  }
}
