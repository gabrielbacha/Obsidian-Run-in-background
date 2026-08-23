import { describe, expect, it } from "vitest";
import { defaultSettings, deriveVaultBadge, migrateSettings, normalizeBadgeColor, normalizeVaultBadge, reconcileRecoveryPath } from "../src/settings";

describe("vault badges", () => {
  it.each([["Gabriel", "G"], ["Daily Notes", "DN"], ["GB-AI-Context", "GA"]])(
    "derives %s as %s", (vault, badge) => expect(deriveVaultBadge(vault)).toBe(badge),
  );

  it("accepts up to three letters, numbers, symbols, or emoji", () => {
    expect(normalizeVaultBadge("gbxy")).toBe("GBX");
    expect(normalizeVaultBadge("g2!x")).toBe("G2!");
    expect(normalizeVaultBadge("★!?x")).toBe("★!?");
    expect(normalizeVaultBadge("🔥2★x")).toBe("🔥2★");
  });

  it("preserves optional internal spaces and trims empty whitespace", () => {
    expect(normalizeVaultBadge(" g   b   c ")).toBe("G B C");
    expect(normalizeVaultBadge("   ")).toBe("");
  });

  it("normalizes badge colors and rejects invalid values", () => {
    expect(normalizeBadgeColor("#A1B2C3")).toBe("#a1b2c3");
    expect(normalizeBadgeColor("purple")).toBe("#141418");
  });
});

describe("settings migration", () => {
  it("uses background-first defaults for fresh installs", () => {
    expect(defaultSettings("Daily Notes")).toMatchObject({
      pluginEnabled: true,
      launchOnStartup: false,
      hideOnLaunch: true,
      runInBackground: true,
      keepRunningAfterQuit: true,
      createTrayIcon: true,
      hideTaskbarIcon: false,
      badgeBackgroundColor: "#141418",
    });
  });

  it("prunes removed shortcut and quick-note fields", () => {
    const migrated = migrateSettings({
      runInBackground: true,
      toggleWindowFocusHotkey: "CmdOrCtrl+Shift+Tab",
      quickNoteLocation: "Notes",
      quickNoteDateFormat: "YYYY-MM-DD",
      quickNoteHotkey: "CmdOrCtrl+Shift+Q",
      trayIconTooltip: "{{vault}} | Obsidian",
    }, "Daily Notes");
    expect(migrated).not.toHaveProperty("toggleWindowFocusHotkey");
    expect(migrated).not.toHaveProperty("quickNoteLocation");
    expect(migrated).not.toHaveProperty("quickNoteDateFormat");
    expect(migrated).not.toHaveProperty("quickNoteHotkey");
    expect(migrated).not.toHaveProperty("trayIconTooltip");
    expect(migrated.vaultBadge).toBe("DN");
    expect(migrated.keepRunningAfterQuit).toBe(true);
  });

  it("preserves compatible icon and window settings", () => {
    const migrated = migrateSettings({ trayIconImage: "data:image/png;base64,abc", hideTaskbarIcon: true }, "Gabriel");
    expect(migrated.trayIconImage).toBe("data:image/png;base64,abc");
    expect(migrated.hideTaskbarIcon).toBe(true);
    expect(migrated.createTrayIcon).toBe(true);
  });

  it("upgrades the legacy low-resolution Obsidian icon", () => {
    const migrated = migrateSettings({
      trayIconImage: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9h-old",
    }, "Gabriel");
    expect(migrated.trayIconImage.startsWith("data:image/svg+xml,")).toBe(true);
  });

  it("upgrades the previous redrawn Obsidian preset", () => {
    const migrated = migrateSettings({
      trayIconImage: "data:image/svg+xml,%3Csvg%3E%3ClinearGradient%20id%3D%22o%22%3Eold",
    }, "Gabriel");
    expect(migrated.trayIconImage).toContain("viewBox%3D%220%200%20512%20512%22");
  });

  it("preserves an intentionally empty badge", () => {
    expect(migrateSettings({ vaultBadge: "" }, "Daily Notes").vaultBadge).toBe("");
  });

  it("preserves a vault-specific badge color", () => {
    expect(migrateSettings({ badgeBackgroundColor: "#FF5500" }, "Daily Notes").badgeBackgroundColor).toBe("#ff5500");
  });

  it("preserves existing safe toggle preferences", () => {
    expect(migrateSettings({ pluginEnabled: false, hideOnLaunch: false, runInBackground: false }, "Gabriel")).toMatchObject({
      pluginEnabled: false,
      hideOnLaunch: false,
      runInBackground: false,
    });
  });

  it("keeps at least one recovery path visible", () => {
    const settings = defaultSettings("Gabriel");
    settings.hideTaskbarIcon = true;
    settings.createTrayIcon = false;
    reconcileRecoveryPath(settings, "hideTaskbarIcon");
    expect(settings.createTrayIcon).toBe(true);
    settings.createTrayIcon = false;
    reconcileRecoveryPath(settings, "createTrayIcon");
    expect(settings.hideTaskbarIcon).toBe(false);
  });
});
