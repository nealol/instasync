import { App, PluginSettingTab, Setting } from "obsidian";
import type InstaSyncPlugin from "./main";
import { generateClientIdentity } from "./names";

export interface InstaSyncSettings {
	/** Base URL of the y-sweet server, e.g. http://127.0.0.1:8080 */
	serverUrl: string;
	/** Document id used for the shared vault file-index. One vault per server. */
	vaultId: string;
	/** This client's display name (two words), shown on remote cursors. */
	clientName: string;
	/** This client's cursor color. */
	clientColor: string;
	clientColorLight: string;
	/** Whether syncing is enabled. */
	enabled: boolean;
}

export function defaultSettings(): InstaSyncSettings {
	const identity = generateClientIdentity();
	return {
		serverUrl: "http://127.0.0.1:8080",
		vaultId: "instasync-vault",
		clientName: identity.name,
		clientColor: identity.color,
		clientColorLight: identity.colorLight,
		enabled: true,
	};
}

export class InstaSyncSettingTab extends PluginSettingTab {
	plugin: InstaSyncPlugin;

	constructor(app: App, plugin: InstaSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "InstaSync" });
		containerEl.createEl("p", {
			text: "Real-time collaborative editing for every Markdown file in this vault. Point all collaborators at the same y-sweet server URL.",
			cls: "setting-item-description",
		});

		new Setting(containerEl)
			.setName("Enable syncing")
			.setDesc("Connect to the server and sync this vault. Toggle off to work offline.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.enabled).onChange(async (value) => {
					this.plugin.settings.enabled = value;
					await this.plugin.saveSettings();
					await this.plugin.reloadSync();
				}),
			);

		new Setting(containerEl)
			.setName("Server URL")
			.setDesc("Base URL of your y-sweet server (no trailing path). Example: http://127.0.0.1:8080")
			.addText((text) =>
				text
					.setPlaceholder("http://127.0.0.1:8080")
					.setValue(this.plugin.settings.serverUrl)
					.onChange(async (value) => {
						this.plugin.settings.serverUrl = value.trim().replace(/\/$/, "");
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Vault id")
			.setDesc("Identifier for this shared vault on the server. All collaborators must use the same id. One vault per server is recommended.")
			.addText((text) =>
				text
					.setValue(this.plugin.settings.vaultId)
					.onChange(async (value) => {
						this.plugin.settings.vaultId = value.trim() || "instasync-vault";
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Reconnect")
			.setDesc("Apply the server URL / vault id changes by reconnecting.")
			.addButton((btn) =>
				btn.setButtonText("Reconnect").setCta().onClick(async () => {
					await this.plugin.reloadSync();
				}),
			);

		containerEl.createEl("h3", { text: "Your cursor" });

		new Setting(containerEl)
			.setName("Display name")
			.setDesc("Two-word name shown to other editors on your cursor.")
			.addText((text) =>
				text.setValue(this.plugin.settings.clientName).onChange(async (value) => {
					this.plugin.settings.clientName = value;
					await this.plugin.saveSettings();
					this.plugin.updateLocalAwareness();
				}),
			)
			.addExtraButton((btn) =>
				btn
					.setIcon("dice")
					.setTooltip("Generate a new name & color")
					.onClick(async () => {
						const id = generateClientIdentity();
						this.plugin.settings.clientName = id.name;
						this.plugin.settings.clientColor = id.color;
						this.plugin.settings.clientColorLight = id.colorLight;
						await this.plugin.saveSettings();
						this.plugin.updateLocalAwareness();
						this.display();
					}),
			);

		const colorSetting = new Setting(containerEl)
			.setName("Cursor color")
			.setDesc("The color of your cursor and selection for other editors.");
		colorSetting.addColorPicker((picker) =>
			picker.setValue(this.plugin.settings.clientColor).onChange(async (value) => {
				this.plugin.settings.clientColor = value;
				this.plugin.settings.clientColorLight = value + "33";
				await this.plugin.saveSettings();
				this.plugin.updateLocalAwareness();
			}),
		);
	}
}
