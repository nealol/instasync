import { App, Modal, Notice, Setting } from "obsidian";
import type InstaSyncPlugin from "../main";
import type { VaultInfo, MemberInfo } from "../auth";

/** Simple yes/no confirmation modal. Resolves true if confirmed. */
export class ConfirmModal extends Modal {
	private title: string;
	private body: string;
	private confirmText: string;
	private resolve!: (ok: boolean) => void;

	constructor(app: App, title: string, body: string, confirmText = "Confirm") {
		super(app);
		this.title = title;
		this.body = body;
		this.confirmText = confirmText;
	}

	ask(): Promise<boolean> {
		this.open();
		return new Promise((resolve) => {
			this.resolve = resolve;
		});
	}

	onOpen(): void {
		this.contentEl.createEl("h3", { text: this.title });
		this.contentEl.createEl("p", { text: this.body });
		new Setting(this.contentEl)
			.addButton((btn) =>
				btn.setButtonText("Cancel").onClick(() => {
					this.resolve(false);
					this.close();
				}),
			)
			.addButton((btn) =>
				btn.setButtonText(this.confirmText).setWarning().onClick(() => {
					this.resolve(true);
					this.close();
				}),
			);
	}

	onClose(): void {
		this.contentEl.empty();
		// If closed without a choice, treat as cancel.
		this.resolve?.(false);
	}
}

/**
 * First-run / "Set up vault" flow: create a vault from the local files, adopt an
 * existing remote vault, or join via an invite.
 */
export class OnboardingModal extends Modal {
	private plugin: InstaSyncPlugin;

	constructor(app: App, plugin: InstaSyncPlugin) {
		super(app);
		this.plugin = plugin;
	}

	onOpen(): void {
		void this.render();
	}

	private async render(): Promise<void> {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: "Set up InstaSync" });

		// 1. Create from local.
		let name = this.app.vault.getName();
		new Setting(contentEl)
			.setName("Create a new vault from this local vault")
			.setDesc("Uploads your current Markdown files as a new shared vault.")
			.addText((t) => t.setValue(name).onChange((v) => (name = v.trim())))
			.addButton((b) =>
				b.setButtonText("Create").setCta().onClick(async () => {
					if (!name) return;
					try {
						await this.plugin.createAndActivateVault(name);
						new Notice(`InstaSync: created and syncing "${name}".`);
						this.close();
					} catch (e) {
						new Notice(`InstaSync: create failed. ${(e as Error).message}`);
					}
				}),
			);

		// 2. Adopt an existing vault.
		contentEl.createEl("h3", { text: "Adopt an existing vault (erases local Markdown)" });
		const listEl = contentEl.createDiv();
		listEl.createEl("p", { text: "Loading…", cls: "setting-item-description" });
		let vaults: VaultInfo[] = [];
		try {
			vaults = await this.plugin.auth.listVaults();
		} catch (e) {
			listEl.empty();
			listEl.createEl("p", {
				text: `Could not load vaults: ${(e as Error).message}`,
				cls: "setting-item-description",
			});
		}
		if (vaults.length) {
			listEl.empty();
			for (const v of vaults) {
				new Setting(listEl)
					.setName(v.name)
					.setDesc(`Role: ${v.role}`)
					.addButton((b) =>
						b.setButtonText("Adopt").onClick(async () => {
							try {
								await this.plugin.adoptVault(v.id, v.name);
								this.close();
							} catch (e) {
								new Notice(`InstaSync: adopt failed. ${(e as Error).message}`);
							}
						}),
					);
			}
		} else if (listEl.querySelector("p")?.textContent === "Loading…") {
			listEl.empty();
			listEl.createEl("p", {
				text: "No existing vaults.",
				cls: "setting-item-description",
			});
		}

		// 3. Join via invite.
		contentEl.createEl("h3", { text: "Join with an invite" });
		let code = "";
		new Setting(contentEl)
			.setName("Invite code")
			.addText((t) => t.setPlaceholder("four-word-invite-code").onChange((v) => (code = v.trim())))
			.addButton((b) =>
				b.setButtonText("Redeem & adopt").onClick(async () => {
					if (!code) return;
					try {
						const { vaultId, name: vname } = await this.plugin.auth.redeemInvite(code);
						await this.plugin.adoptVault(vaultId, vname);
						this.close();
					} catch (e) {
						new Notice(`InstaSync: redeem failed. ${(e as Error).message}`);
					}
				}),
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** Lists a vault's members and lets an admin promote members to admin. */
export class VaultMembersModal extends Modal {
	private plugin: InstaSyncPlugin;
	private vault: VaultInfo;

	constructor(app: App, plugin: InstaSyncPlugin, vault: VaultInfo) {
		super(app);
		this.plugin = plugin;
		this.vault = vault;
	}

	onOpen(): void {
		void this.render();
	}

	private async render(): Promise<void> {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: `Members of ${this.vault.name}` });

		let members: MemberInfo[];
		try {
			members = await this.plugin.auth.listMembers(this.vault.id);
		} catch (e) {
			contentEl.createEl("p", { text: `Could not load members: ${(e as Error).message}` });
			return;
		}

		for (const m of members) {
			const setting = new Setting(contentEl)
				.setName(m.displayName || m.email)
				.setDesc(`${m.email} · ${m.role}`);
			if (m.role !== "admin") {
				setting.addButton((b) =>
					b.setButtonText("Promote to admin").onClick(async () => {
						try {
							await this.plugin.auth.promoteMember(this.vault.id, m.userId);
							new Notice("InstaSync: promoted.");
							void this.render();
						} catch (e) {
							new Notice(`InstaSync: promote failed. ${(e as Error).message}`);
						}
					}),
				);
			}
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
