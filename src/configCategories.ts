/**
 * Obsidian-Sync-style vault configuration sync categories.
 *
 * Mirrors the "Vault configuration sync" toggle list from Obsidian Sync:
 * every file under the active config folder (`app.vault.configDir`) is
 * classified into exactly one category by its path relative to that folder,
 * and only files whose category is enabled on this device participate in
 * config sync. Toggles are per-device, like Obsidian Sync's.
 *
 * Profile participation also mirrors Obsidian Sync: entries in the shared
 * `configFiles` map are keyed by full vault path (e.g. `.obsidian/app.json`
 * or `.obsidian-mobile/app.json`), and each device only reconciles paths
 * under its *own* active config folder. Devices sharing a config folder name
 * form a settings profile; other profiles' entries are left untouched.
 */

export type ConfigCategoryId =
  | "mainSettings"
  | "appearance"
  | "themesAndSnippets"
  | "hotkeys"
  | "corePluginList"
  | "corePluginSettings"
  | "communityPluginList"
  | "installedCommunityPlugins"
  | "workspace";

export interface ConfigCategory {
  id: ConfigCategoryId;
  /** Toggle label, matching Obsidian Sync's wording where a toggle exists there. */
  name: string;
  desc: string;
  /** Default toggle state, matching Obsidian Sync's defaults. */
  defaultEnabled: boolean;
  /**
   * Whether downloading files in this category usually needs an app reload
   * to take effect (per Obsidian's documented reload behavior).
   */
  requiresReload: boolean;
}

export const CONFIG_CATEGORIES: readonly ConfigCategory[] = [
  {
    id: "mainSettings",
    name: "Main settings",
    desc: "Editor, files & links, and general vault settings (app.json).",
    defaultEnabled: true,
    requiresReload: false,
  },
  {
    id: "appearance",
    name: "Appearance",
    desc: "Base theme, selected theme, enabled snippet list, and typography (appearance.json).",
    defaultEnabled: true,
    requiresReload: false,
  },
  {
    id: "themesAndSnippets",
    name: "Themes and snippets",
    desc: "Downloaded theme files and CSS snippet files (themes/, snippets/).",
    defaultEnabled: true,
    requiresReload: true,
  },
  {
    id: "hotkeys",
    name: "Hotkeys",
    desc: "Custom hotkeys (hotkeys.json).",
    defaultEnabled: true,
    requiresReload: false,
  },
  {
    id: "corePluginList",
    name: "Active core plugin list",
    desc: "Which core plugins are enabled (core-plugins.json).",
    defaultEnabled: true,
    requiresReload: true,
  },
  {
    id: "corePluginSettings",
    name: "Core plugin settings",
    desc: "Settings of core plugins, e.g. daily-notes.json, templates.json, graph.json.",
    defaultEnabled: true,
    requiresReload: false,
  },
  {
    id: "communityPluginList",
    name: "Active community plugin list",
    desc: "Which community plugins are enabled (community-plugins.json). Off by default, matching Obsidian Sync.",
    defaultEnabled: false,
    requiresReload: true,
  },
  {
    id: "installedCommunityPlugins",
    name: "Installed community plugin list",
    desc: "Community plugin code, settings, and data (plugins/). Off by default, matching Obsidian Sync. The Realtime plugin's own folder is always excluded.",
    defaultEnabled: false,
    requiresReload: true,
  },
  {
    id: "workspace",
    name: "Workspace layout",
    desc: "Open tabs and pane layout (workspace.json and friends). Obsidian Sync syncs these implicitly; here it is optional because they change on almost every interaction.",
    defaultEnabled: false,
    requiresReload: false,
  },
] as const;

export type ConfigSyncCategories = Record<ConfigCategoryId, boolean>;

export function defaultConfigSyncCategories(): ConfigSyncCategories {
  const out = {} as ConfigSyncCategories;
  for (const category of CONFIG_CATEGORIES) out[category.id] = category.defaultEnabled;
  return out;
}

/** Sanitize a persisted categories value against the known category list. */
export function sanitizeConfigSyncCategories(value: unknown): ConfigSyncCategories {
  const out = defaultConfigSyncCategories();
  if (typeof value !== "object" || value === null) return out;
  const record = value as Record<string, unknown>;
  for (const category of CONFIG_CATEGORIES) {
    if (typeof record[category.id] === "boolean") {
      out[category.id] = record[category.id] as boolean;
    }
  }
  return out;
}

export function enabledConfigCategories(categories: ConfigSyncCategories): Set<ConfigCategoryId> {
  const out = new Set<ConfigCategoryId>();
  for (const category of CONFIG_CATEGORIES) {
    if (categories[category.id]) out.add(category.id);
  }
  return out;
}

const RELOAD_CATEGORY_IDS: ReadonlySet<ConfigCategoryId> = new Set(
  CONFIG_CATEGORIES.filter((c) => c.requiresReload).map((c) => c.id),
);

export function categoryRequiresReload(id: ConfigCategoryId): boolean {
  return RELOAD_CATEGORY_IDS.has(id);
}

/**
 * Classify a path *relative to the config folder* into a sync category, or
 * `null` for files Obsidian Sync would not sync at all (unknown folders,
 * non-JSON top-level files, caches, etc.).
 */
export function categoryForConfigPath(relPath: string): ConfigCategoryId | null {
  if (!relPath || relPath.startsWith("/") || relPath.includes("\\")) return null;

  if (relPath.startsWith("themes/") || relPath.startsWith("snippets/")) {
    return "themesAndSnippets";
  }
  if (relPath.startsWith("plugins/")) return "installedCommunityPlugins";

  // Everything else Obsidian Sync manages lives at the config folder root.
  if (relPath.includes("/")) return null;

  switch (relPath) {
    case "app.json":
      return "mainSettings";
    case "appearance.json":
      return "appearance";
    case "hotkeys.json":
      return "hotkeys";
    case "core-plugins.json":
    case "core-plugins-migration.json":
      return "corePluginList";
    case "community-plugins.json":
      return "communityPluginList";
  }

  if (/^workspaces?(-mobile)?\.json$/.test(relPath)) return "workspace";

  // Remaining top-level JSON files are core plugin settings (daily-notes.json,
  // templates.json, graph.json, canvas.json, backlink.json, types.json, ...).
  if (relPath.endsWith(".json")) return "corePluginSettings";

  return null;
}

/**
 * Classify a full vault path against the active config folder. Returns the
 * category, or `null` when the path is outside this device's config folder
 * (e.g. another profile's folder) or is a file config sync never touches.
 */
export function categoryForVaultPath(path: string, configDir: string): ConfigCategoryId | null {
  const prefix = `${configDir}/`;
  if (!path.startsWith(prefix)) return null;
  return categoryForConfigPath(path.slice(prefix.length));
}
