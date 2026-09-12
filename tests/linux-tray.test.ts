import { describe, expect, it } from "vitest";
import { linuxTrayMenuLayout } from "../src/linux-tray";

describe("Linux status notifier tray", () => {
  it("exposes a complete per-vault menu layout", () => {
    const [rootId, properties, children] = linuxTrayMenuLayout("GB-AI-Context");
    expect(rootId).toBe(0);
    expect(properties).toEqual({});
    expect(children).toHaveLength(8);
    const ids = children.map((child) => Number((child.value as unknown[])[0]));
    expect(ids).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});
