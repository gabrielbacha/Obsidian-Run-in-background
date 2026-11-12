import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { Variant, type DefinedInterface, type MessageBus } from "dbus-native";
import { LinuxStatusNotifierTray } from "../src/linux-tray";
class Bus extends EventEmitter {
  name = ":1.25"; signals = new EventEmitter(); connection = new EventEmitter();
  exports = new Map<string, DefinedInterface>(); removed = 0; closed = 0; registered = 0;
  failMenu = false;
  watchGate?: Promise<void>;
  listGate?: Promise<void>;
  async listNames(): Promise<string[]> { await this.listGate; return []; }
  export(path: string, definition: DefinedInterface) {
    if (this.failMenu && path === "/MenuBar") throw new Error("Menu export failed");
    Object.defineProperty(definition.impl, "emit", { value: () => true, configurable: true });
    this.exports.set(path, definition);
    return Promise.resolve({ remove: () => { this.exports.delete(path); this.removed++; return Promise.resolve(); } });
  }
  mangle(): string { return "owner"; }
  async watch() { await this.watchGate; return { remove: () => { this.removed++; return Promise.resolve(); } }; }
  getInterface() { return Promise.resolve({ RegisterStatusNotifierItem: () => { this.registered++; return Promise.resolve(); } }); }
  close(): Promise<void> { this.closed++; return Promise.resolve(); }
}
function setup(bus = new Bus()) {
  const actions = { show: vi.fn(), hide: vi.fn(), toggle: vi.fn(), openSettings: vi.fn(), relaunch: vi.fn(), closeVault: vi.fn() };
  const tray = new LinuxStatusNotifierTray("Synthetic vault", [{ width: 16, height: 16, data: new Uint8Array(1024) }], actions, { busFactory: () => bus as unknown as MessageBus });
  return { bus, tray, actions };
}
// These call the library's real positional adapter, not replacement menu handlers.
interface Menu { GetProperty(id: number, name: string, message?: unknown): Variant; GetGroupProperties(ids: number[], names: string[], message?: unknown): Array<[number, Record<string, Variant>]>; Event(id: number, name: string, data: Variant, timestamp: number, message?: unknown): void; EventGroup(events: Array<[number, string, Variant, number ]>, message?: unknown): number[]; }
describe("Linux exported protocol and recovery", () => {
  it("routes single/grouped events and returns real requested properties and invalid IDs", async () => {
    const { bus, tray, actions } = setup(); await tray.create(); const menu = bus.exports.get("/MenuBar")!.impl as unknown as Menu;
    expect(menu.GetProperty(3, "label", {}).value).toBe("Show Vault");
    expect(menu.GetProperty(0, "enabled", {}).value).toBe(true);
    expect(menu.GetGroupProperties([0], ["visible"], {})[0]![1].visible?.value).toBe(true);
    expect(menu.GetGroupProperties([3, 99], ["label"], {}).map(([id, properties]) => [id, Object.keys(properties)])).toEqual([[3, ["label"]]]);
    expect(() => menu.GetProperty(99, "label", {})).toThrow(); expect(() => menu.GetProperty(3, "missing", {})).toThrow();
    menu.Event(3, "clicked", new Variant("s", ""), 0, {});
    expect(menu.EventGroup([[3, "clicked", new Variant("s", ""), 0], [99, "clicked", new Variant("s", ""), 0]], {})).toEqual([99]);
    expect(actions.show).toHaveBeenCalledTimes(2); tray.destroy(); await Promise.resolve(); await Promise.resolve();
  });
  it("re-registers after watcher replacement and bus reconnect without recreating exported objects", async () => {
    const { bus, tray } = setup(); await tray.create(); expect(tray.isAvailable()).toBe(true);
    bus.signals.emit("owner", ["org.kde.StatusNotifierWatcher", ":1.1", ""]); expect(tray.isAvailable()).toBe(false);
    bus.signals.emit("owner", ["org.kde.StatusNotifierWatcher", "", ":1.2"]);
    await vi.waitFor(() => expect(bus.registered).toBe(2)); expect(tray.isAvailable()).toBe(true);
    bus.connection.emit("end"); expect(tray.isAvailable()).toBe(false); bus.emit("reconnected");
    await vi.waitFor(() => expect(bus.registered).toBe(3)); expect(bus.exports.size).toBe(2);
    tray.updateIcon([{ width: 32, height: 32, data: new Uint8Array(4096) }]); expect(bus.exports.size).toBe(2);
    tray.destroy(); await vi.waitFor(() => expect(bus.closed).toBe(1)); expect(bus.exports.size).toBe(0); expect(bus.listenerCount("reconnected")).toBe(0);
  });
  it("removes the first export and closes the bus after partial creation fails", async () => {
    const bus = new Bus(); bus.failMenu = true; const { tray } = setup(bus);
    await expect(tray.create()).rejects.toThrow("Menu export failed"); expect(bus.exports.size).toBe(0); expect(bus.closed).toBe(1); expect(tray.isAvailable()).toBe(false);
  });
  it.each(["listGate", "watchGate"] as const)("disposes late completion after unload during %s", async gate => {
    const bus = new Bus(); let finish!: () => void; bus[gate] = new Promise<void>(resolve => { finish = resolve; });
    const { tray } = setup(bus); const creating = tray.create(); await Promise.resolve(); await Promise.resolve(); tray.destroy(); finish();
    await expect(creating).rejects.toThrow("cancelled"); expect(bus.exports.size).toBe(0); expect(bus.registered).toBe(0); expect(tray.isAvailable()).toBe(false); expect(bus.listenerCount("reconnected")).toBe(0);
  });
});
