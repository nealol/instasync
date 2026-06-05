import { App, Modal, Notice } from "obsidian";
import { createRoot, type Root } from "react-dom/client";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type InstaSyncPlugin from "../main";
import type { MemberInfo, VaultInfo } from "../auth";

/** Simple yes/no confirmation modal. Resolves true if confirmed. */
export class ConfirmModal extends Modal {
	private title: string;
	private body: string;
	private confirmText: string;
	private resolve!: (ok: boolean) => void;
	private root: Root | null = null;
	private resolved = false;

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
		this.root = createRoot(this.contentEl);
		this.root.render(
			<ConfirmDialog
				title={this.title}
				body={this.body}
				confirmText={this.confirmText}
				onChoose={(ok) => {
					this.resolved = true;
					this.resolve(ok);
					this.close();
				}}
			/>,
		);
	}

	onClose(): void {
		this.root?.unmount();
		this.root = null;
		this.contentEl.empty();
		if (!this.resolved) this.resolve?.(false);
	}
}

function ConfirmDialog({ title, body, confirmText, onChoose }: { title: string; body: string; confirmText: string; onChoose: (ok: boolean) => void }) {
	return (
		<>
			<h3>{title}</h3>
			<p>{body}</p>
			<SettingRow
				control={
					<>
						<button onClick={() => onChoose(false)}>Cancel</button>
						<button className="mod-warning" onClick={() => onChoose(true)}>
							{confirmText}
						</button>
					</>
				}
			/>
		</>
	);
}

/**
 * First-run / "Set up vault" flow: create a vault from the local files, adopt an
 * existing remote vault, or join via an invite.
 */
export class OnboardingModal extends Modal {
	private plugin: InstaSyncPlugin;
	private root: Root | null = null;

	constructor(app: App, plugin: InstaSyncPlugin) {
		super(app);
		this.plugin = plugin;
	}

	onOpen(): void {
		this.root = createRoot(this.contentEl);
		this.root.render(<OnboardingView app={this.app} plugin={this.plugin} close={() => this.close()} />);
	}

	onClose(): void {
		this.root?.unmount();
		this.root = null;
		this.contentEl.empty();
	}
}

function OnboardingView({ app, plugin, close }: { app: App; plugin: InstaSyncPlugin; close: () => void }) {
	const [name, setName] = useState(app.vault.getName());
	const [code, setCode] = useState("");
	const [vaults, setVaults] = useState<VaultInfo[] | null>(null);
	const [error, setError] = useState("");

	useEffect(() => {
		let cancelled = false;
		void (async () => {
			try {
				const listedVaults = await plugin.auth.listVaults();
				if (!cancelled) setVaults(listedVaults);
			} catch (e) {
				if (!cancelled) setError(`Could not load vaults: ${(e as Error).message}`);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [plugin]);

	return (
		<>
			<h2>Set up InstaSync</h2>
			<SettingRow
				name="Create a new vault from this local vault"
				desc="Uploads your current Markdown files as a new shared vault."
				control={
					<>
						<input type="text" value={name} onChange={(event) => setName(event.currentTarget.value.trim())} />
						<button
							className="mod-cta"
							onClick={() => {
								if (!name) return;
								void (async () => {
									try {
										await plugin.createAndActivateVault(name);
										new Notice(`InstaSync: created and syncing "${name}".`);
										close();
									} catch (e) {
										new Notice(`InstaSync: create failed. ${(e as Error).message}`);
									}
								})();
							}}
						>
							Create
						</button>
					</>
				}
			/>
			<h3>Adopt an existing vault (erases local Markdown)</h3>
			{error ? <p className="setting-item-description">{error}</p> : null}
			{!error && vaults === null ? <p className="setting-item-description">Loading...</p> : null}
			{vaults?.length === 0 ? <p className="setting-item-description">No existing vaults.</p> : null}
			{vaults?.map((vault) => (
				<SettingRow
					key={vault.id}
					name={vault.name}
					desc={`Role: ${vault.role}`}
					control={
						<button
							onClick={() => {
								void (async () => {
									try {
										await plugin.adoptVault(vault.id, vault.name);
										close();
									} catch (e) {
										new Notice(`InstaSync: adopt failed. ${(e as Error).message}`);
									}
								})();
							}}
						>
							Adopt
						</button>
					}
				/>
			))}
			<h3>Join with an invite</h3>
			<SettingRow
				name="Invite code"
				control={
					<>
						<input type="text" placeholder="four-word-invite-code" value={code} onChange={(event) => setCode(event.currentTarget.value.trim())} />
						<button
							onClick={() => {
								if (!code) return;
								void (async () => {
									try {
										const { vaultId, name: vaultName } = await plugin.auth.redeemInvite(code);
										await plugin.adoptVault(vaultId, vaultName);
										close();
									} catch (e) {
										new Notice(`InstaSync: redeem failed. ${(e as Error).message}`);
									}
								})();
							}}
						>
							Redeem & adopt
						</button>
					</>
				}
			/>
		</>
	);
}

/** Lists a vault's members and lets an admin promote members to admin. */
export class VaultMembersModal extends Modal {
	private plugin: InstaSyncPlugin;
	private vault: VaultInfo;
	private root: Root | null = null;

	constructor(app: App, plugin: InstaSyncPlugin, vault: VaultInfo) {
		super(app);
		this.plugin = plugin;
		this.vault = vault;
	}

	onOpen(): void {
		this.root = createRoot(this.contentEl);
		this.root.render(<VaultMembersView plugin={this.plugin} vault={this.vault} />);
	}

	onClose(): void {
		this.root?.unmount();
		this.root = null;
		this.contentEl.empty();
	}
}

function VaultMembersView({ plugin, vault }: { plugin: InstaSyncPlugin; vault: VaultInfo }) {
	const [reloadKey, setReloadKey] = useState(0);
	const [members, setMembers] = useState<MemberInfo[] | null>(null);
	const [error, setError] = useState("");

	useEffect(() => {
		let cancelled = false;
		setMembers(null);
		setError("");
		void (async () => {
			try {
				const listedMembers = await plugin.auth.listMembers(vault.id);
				if (!cancelled) setMembers(listedMembers);
			} catch (e) {
				if (!cancelled) setError(`Could not load members: ${(e as Error).message}`);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [plugin, vault.id, reloadKey]);

	return (
		<>
			<h2>Members of {vault.name}</h2>
			{error ? <p>{error}</p> : null}
			{!error && members === null ? <p className="setting-item-description">Loading members...</p> : null}
			{members?.map((member) => (
				<SettingRow
					key={member.userId}
					name={member.displayName || member.email}
					desc={`${member.email} * ${member.role}`}
					control={
						member.role !== "admin" ? (
							<button
								onClick={() => {
									void (async () => {
										try {
											await plugin.auth.promoteMember(vault.id, member.userId);
											new Notice("InstaSync: promoted.");
											setReloadKey((key) => key + 1);
										} catch (e) {
											new Notice(`InstaSync: promote failed. ${(e as Error).message}`);
										}
									})();
								}}
							>
								Promote to admin
							</button>
						) : null
					}
				/>
			))}
		</>
	);
}

function SettingRow({ name, desc, control }: { name?: string; desc?: string; control: ReactNode }) {
	return (
		<div className="setting-item">
			{name || desc ? (
				<div className="setting-item-info">
					{name ? <div className="setting-item-name">{name}</div> : null}
					{desc ? <div className="setting-item-description">{desc}</div> : null}
				</div>
			) : null}
			<div className="setting-item-control">{control}</div>
		</div>
	);
}
