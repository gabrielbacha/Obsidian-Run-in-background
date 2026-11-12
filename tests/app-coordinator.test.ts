import { EventEmitter } from "node:events";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { installAppCoordinator } from "../src/app-coordinator";

describe("shared application policy", () => {
  it.each([true, false])("keeps another vault's recovery request after either unload order (%s)", async first => {
    const dock = { hide: vi.fn(), show: vi.fn() };
    const app = { dock }, one = new EventEmitter(), two = new EventEmitter();
    const a = installAppCoordinator(app, one), b = installAppCoordinator(app, two);
    expect(a.facts()).toEqual(b.facts());
    await a.updateDock(true, true); await b.updateDock(false, true);
    expect(dock.show).toHaveBeenCalledTimes(1);
    await b.updateDock(true, true); expect(dock.hide).toHaveBeenCalledTimes(2);
    (first ? a : b).release(); await (first ? b : a).updateDock(true, true);
    expect(dock.show).toHaveBeenCalledTimes(1);
    (first ? b : a).release(); await Promise.resolve(); await Promise.resolve();
    expect(dock.show).toHaveBeenCalledTimes(2);
  });
  it("cannot hide while another owner has no usable tray, including a pending Dock show", async () => {
    let finish!: () => void;
    const dock = { hide: vi.fn(), show: vi.fn(() => new Promise<void>(resolve => { finish = resolve; })) };
    const app = { dock }, a = installAppCoordinator(app, new EventEmitter()), b = installAppCoordinator(app, new EventEmitter());
    const showing = a.updateDock(false, true); await Promise.resolve();
    const hiding = a.updateDock(true, true); const missing = b.updateDock(true, false);
    finish(); await Promise.all([showing, hiding, missing]); expect(dock.hide).not.toHaveBeenCalled();
    await b.updateDock(true, true); expect(dock.hide).toHaveBeenCalledOnce();
  });
  it("runs its actual function body without renderer scope and cleans a destroyed owner", async () => {
    const install = runInNewContext(`(${installAppCoordinator.toString()})`, { process: { pid: 125 }, console }) as typeof installAppCoordinator;
    const dock = { hide: vi.fn(), show: vi.fn() }, app = { dock }, owner = new EventEmitter();
    const coordinator = install(app, owner); await coordinator.updateDock(true, true);
    owner.emit("destroyed"); await Promise.resolve(); await Promise.resolve();
    expect(dock.show).toHaveBeenCalledOnce(); expect(owner.listenerCount("destroyed")).toBe(0);
    await coordinator.updateDock(true, true); expect(dock.hide).toHaveBeenCalledOnce();
  });
});
