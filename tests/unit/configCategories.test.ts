import { describe, expect, it } from "vitest";
import {
  CONFIG_CATEGORIES,
  categoryForConfigPath,
  categoryForVaultPath,
  defaultConfigSyncCategories,
  enabledConfigCategories,
  sanitizeConfigSyncCategories,
} from "../../src/configCategories";

describe("categoryForConfigPath", () => {
  it("classifies the Obsidian Sync category file map", () => {
    expect(categoryForConfigPath("app.json")).toBe("mainSettings");
    expect(categoryForConfigPath("appearance.json")).toBe("appearance");
    expect(categoryForConfigPath("hotkeys.json")).toBe("hotkeys");
    expect(categoryForConfigPath("core-plugins.json")).toBe("corePluginList");
    expect(categoryForConfigPath("community-plugins.json")).toBe("communityPluginList");
    expect(categoryForConfigPath("themes/Minimal/theme.css")).toBe("themesAndSnippets");
    expect(categoryForConfigPath("snippets/wide.css")).toBe("themesAndSnippets");
    expect(categoryForConfigPath("plugins/dataview/main.js")).toBe("installedCommunityPlugins");
    expect(categoryForConfigPath("plugins/dataview/data.json")).toBe("installedCommunityPlugins");
  });

  it("routes remaining top-level json to core plugin settings", () => {
    expect(categoryForConfigPath("daily-notes.json")).toBe("corePluginSettings");
    expect(categoryForConfigPath("templates.json")).toBe("corePluginSettings");
    expect(categoryForConfigPath("graph.json")).toBe("corePluginSettings");
    expect(categoryForConfigPath("types.json")).toBe("corePluginSettings");
  });

  it("classifies workspace files separately", () => {
    expect(categoryForConfigPath("workspace.json")).toBe("workspace");
    expect(categoryForConfigPath("workspace-mobile.json")).toBe("workspace");
    expect(categoryForConfigPath("workspaces.json")).toBe("workspace");
  });

  it("refuses files Obsidian Sync would not sync", () => {
    expect(categoryForConfigPath("cache")).toBeNull();
    expect(categoryForConfigPath("some.log")).toBeNull();
    expect(categoryForConfigPath("unknown-folder/x.json")).toBeNull();
    expect(categoryForConfigPath("")).toBeNull();
  });
});

describe("categoryForVaultPath", () => {
  it("scopes matching to the device's active config folder (profiles)", () => {
    expect(categoryForVaultPath(".obsidian/app.json", ".obsidian")).toBe("mainSettings");
    expect(categoryForVaultPath(".obsidian-mobile/app.json", ".obsidian-mobile")).toBe(
      "mainSettings",
    );
    // Another profile's folder is not this device's business.
    expect(categoryForVaultPath(".obsidian-mobile/app.json", ".obsidian")).toBeNull();
    expect(categoryForVaultPath(".obsidian/app.json", ".obsidian-mobile")).toBeNull();
    // Prefix must be an exact folder match.
    expect(categoryForVaultPath(".obsidianX/app.json", ".obsidian")).toBeNull();
    expect(categoryForVaultPath("notes/a.md", ".obsidian")).toBeNull();
  });
});

describe("category defaults and sanitizing", () => {
  it("mirrors Obsidian Sync defaults (community plugin sync off)", () => {
    const defaults = defaultConfigSyncCategories();
    expect(defaults.mainSettings).toBe(true);
    expect(defaults.appearance).toBe(true);
    expect(defaults.themesAndSnippets).toBe(true);
    expect(defaults.hotkeys).toBe(true);
    expect(defaults.corePluginList).toBe(true);
    expect(defaults.corePluginSettings).toBe(true);
    expect(defaults.communityPluginList).toBe(false);
    expect(defaults.installedCommunityPlugins).toBe(false);
    expect(defaults.workspace).toBe(false);
  });

  it("sanitizes persisted values, keeping only known boolean keys", () => {
    const out = sanitizeConfigSyncCategories({
      communityPluginList: true,
      hotkeys: "yes",
      bogus: true,
    });
    expect(out.communityPluginList).toBe(true);
    expect(out.hotkeys).toBe(true); // non-boolean falls back to default
    expect("bogus" in out).toBe(false);
    expect(sanitizeConfigSyncCategories(null)).toEqual(defaultConfigSyncCategories());
  });

  it("collects enabled category ids", () => {
    const enabled = enabledConfigCategories(defaultConfigSyncCategories());
    expect(enabled.has("mainSettings")).toBe(true);
    expect(enabled.has("communityPluginList")).toBe(false);
    expect(enabled.size).toBe(CONFIG_CATEGORIES.filter((c) => c.defaultEnabled).length);
  });
});
