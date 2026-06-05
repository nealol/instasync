import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type InstaSyncPlugin from "./main";
import { generateClientIdentity } from "./names";
import type { VaultInfo } from "./auth";
import { VaultMembersModal } from "./ui/modals";

export interface InstaSyncSettings {
	/** Base URL of the InstaSync auth server, e.g. http://127.0.0.1:8081 */
	authServerUrl: string;
	/** Opaque session bearer token; empty when logged out. */
	sessionToken: string;
	/** Identity from /api/me, cached for status + awareness defaults. */
	userDisplayName: string;
	userEmail: string;
	/** The server vault UUID currently synced into this local vault; "" if none. */
	activeVaultId: string;
	/** This client's display name (shown on remote cursors). */
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
		authServerUrl: "http://127.0.0.1:8081",
		sessionToken: "",
		userDisplayName: "",
		userEmail: "",
		activeVaultId: "",
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
			text: "Real-time collaborative editing for every Markdown file in this vault. Sign in, then create or join a synced vault.",
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
			.setName("Auth server URL")
			.setDesc("Base URL of your InstaSync auth server. Example: http://127.0.0.1:8081")
			.addText((text) =>
				text
					.setPlaceholder("http://127.0.0.1:8081")
					.setValue(this.plugin.settings.authServerUrl)
					.onChange(async (value) => {
						this.plugin.settings.authServerUrl = value.trim().replace(/\/$/, "");
						await this.plugin.saveSettings();
					}),
			);

		this.renderAccount(containerEl);
		if (this.plugin.auth.isLoggedIn) {
			this.renderVaults(containerEl);
		}
		this.renderCursor(containerEl);
	}

	// --- account ---------------------------------------------------------------

	private renderAccount(containerEl: HTMLElement): void {
		containerEl.createEl("h3", { text: "Account" });

		if (this.plugin.auth.isLoggedIn) {
			const who = this.plugin.settings.userDisplayName || "signed in";
			const email = this.plugin.settings.userEmail;
			new Setting(containerEl)
				.setName(`Signed in as ${who}`)
				.setDesc(email || "")
				.addButton((btn) =>
					btn.setButtonText("Log out").setWarning().onClick(async () => {
						await this.plugin.logout();
						this.display();
					}),
				);
			return;
		}

		new Setting(containerEl)
			.setName("Sign in")
			.setDesc("Opens your browser to authenticate via SSO, then returns to Obsidian.")
			.addButton((btn) =>
				btn.setButtonText("Sign in with SSO").setCta().onClick(async () => {
					try {
						await this.plugin.auth.login();
						new Notice("InstaSync: signed in.");
						await this.plugin.onLoggedIn();
						this.display();
					} catch (e) {
						new Notice(`InstaSync: sign-in failed. ${(e as Error).message}`);
					}
				}),
			);

		let pasted = "";
		new Setting(containerEl)
			.setName("Paste code")
			.setDesc("If the browser didn't return to Obsidian, paste the code shown on the login page.")
			.addText((text) =>
				text.setPlaceholder("session code").onChange((v) => {
					pasted = v.trim();
				}),
			)
			.addButton((btn) =>
				btn.setButtonText("Apply").onClick(async () => {
					if (!pasted) return;
					try {
						await this.plugin.auth.setSession(pasted);
						new Notice("InstaSync: signed in.");
						await this.plugin.onLoggedIn();
						this.display();
					} catch (e) {
						new Notice(`InstaSync: invalid code. ${(e as Error).message}`);
					}
				}),
			);
	}

	// --- vaults ----------------------------------------------------------------

	private renderVaults(containerEl: HTMLElement): void {
		containerEl.createEl("h3", { text: "Vaults" });

		let newVaultName = this.app.vault.getName();
		new Setting(containerEl)
			.setName("Create a synced vault from this local vault")
			.setDesc("Uploads your current Markdown files as a new shared vault.")
			.addText((text) =>
				text.setValue(newVaultName).onChange((v) => {
					newVaultName = v.trim();
				}),
			)
			.addButton((btn) =>
				btn.setButtonText("Create").setCta().onClick(async () => {
					if (!newVaultName) return;
					try {
						await this.plugin.createAndActivateVault(newVaultName);
						new Notice(`InstaSync: created and syncing "${newVaultName}".`);
						this.display();
					} catch (e) {
						new Notice(`InstaSync: create failed. ${(e as Error).message}`);
					}
				}),
			);

		let inviteCode = "";
		new Setting(containerEl)
			.setName("Join a vault with an invite")
			.setDesc("Redeems an invite, then adopts that vault locally (erasing local Markdown).")
			.addText((text) =>
				text.setPlaceholder("four-word-invite-code").onChange((v) => {
					inviteCode = v.trim();
				}),
			)
			.addButton((btn) =>
				btn.setButtonText("Redeem & adopt").onClick(async () => {
					if (!inviteCode) return;
					try {
						const { vaultId, name } = await this.plugin.auth.redeemInvite(inviteCode);
						await this.plugin.adoptVault(vaultId, name);
						this.display();
					} catch (e) {
						new Notice(`InstaSync: redeem failed. ${(e as Error).message}`);
					}
				}),
			);

		const listEl = containerEl.createDiv();
		listEl.createEl("p", { text: "Loading vaults…", cls: "setting-item-description" });
		void this.renderVaultList(listEl);
	}

	private async renderVaultList(listEl: HTMLElement): Promise<void> {
		let vaults: VaultInfo[];
		try {
			vaults = await this.plugin.auth.listVaults();
		} catch (e) {
			listEl.empty();
			listEl.createEl("p", {
				text: `Could not load vaults: ${(e as Error).message}`,
				cls: "setting-item-description",
			});
			return;
		}

		listEl.empty();
		if (vaults.length === 0) {
			listEl.createEl("p", {
				text: "You have no vaults yet. Create one or redeem an invite above.",
				cls: "setting-item-description",
			});
			return;
		}

		for (const vault of vaults) {
			const active = vault.id === this.plugin.settings.activeVaultId;
			const setting = new Setting(listEl)
				.setName(vault.name + (active ? "  ·  active" : ""))
				.setDesc(`Role: ${vault.role}`);

			if (!active) {
				setting.addButton((btn) =>
					btn.setButtonText("Switch (adopt)").onClick(async () => {
						try {
							await this.plugin.adoptVault(vault.id, vault.name);
							this.display();
						} catch (e) {
							new Notice(`InstaSync: switch failed. ${(e as Error).message}`);
						}
					}),
				);
			}

			if (vault.role === "admin") {
				setting.addButton((btn) =>
					btn.setButtonText("Invite").onClick(async () => {
						try {
							const { code } = await this.plugin.auth.createInvite(vault.id);
							void navigator.clipboard?.writeText(code).catch(() => {});
							new Notice(`InstaSync invite (copied):\n${code}`, 15000);
						} catch (e) {
							new Notice(`InstaSync: invite failed. ${(e as Error).message}`);
						}
					}),
				);
				setting.addButton((btn) =>
					btn.setButtonText("Members").onClick(() => {
						new VaultMembersModal(this.app, this.plugin, vault).open();
					}),
				);
			}
		}
	}

	// --- cursor ----------------------------------------------------------------

	private renderCursor(containerEl: HTMLElement): void {
		containerEl.createEl("h3", { text: "Your cursor" });

		new Setting(containerEl)
			.setName("Display name")
			.setDesc("Name shown to other editors on your cursor.")
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
