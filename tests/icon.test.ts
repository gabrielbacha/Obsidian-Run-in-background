import { describe, expect, it } from "vitest";
import { badgeTextColor, TRAY_ICON_PRESETS, TRAY_PREVIEW_PIXEL_SIZE, TRAY_REPRESENTATIONS } from "../src/icon";

describe("tray icon representations", () => {
  it("provides standard and Retina macOS tray sizes", () => {
    expect(TRAY_REPRESENTATIONS).toEqual([
      { pixelSize: 16, scaleFactor: 1 },
      { pixelSize: 32, scaleFactor: 2 },
    ]);
  });

  it("includes three built-in source icons", () => {
    expect(TRAY_ICON_PRESETS).toHaveLength(3);
    expect(TRAY_ICON_PRESETS.map((preset) => preset.name)).toEqual(["Obsidian", "Night vault", "Window stack"]);
    expect(TRAY_ICON_PRESETS.every((preset) => preset.dataUrl.startsWith("data:image/"))).toBe(true);
    expect(TRAY_ICON_PRESETS[0].dataUrl.startsWith("data:image/svg+xml,")).toBe(true);
    expect(TRAY_ICON_PRESETS[0].dataUrl).toContain("viewBox%3D%220%200%20512%20512%22");
  });

  it("renders a high-density settings preview", () => {
    expect(TRAY_PREVIEW_PIXEL_SIZE).toBe(128);
  });

  it("uses readable badge text for dark and light colors", () => {
    expect(badgeTextColor("#141418")).toBe("#ffffff");
    expect(badgeTextColor("#f5d90a")).toBe("#000000");
  });
});
