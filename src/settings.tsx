import { App, Notice, PluginSettingTab } from "obsidian";
import { createRoot, type Root } from "react-dom/client";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
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
	private root: Root | null = null;

	constructor(app: App, plugin: InstaSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		this.containerEl.empty();
		this.root?.unmount();
		this.root = createRoot(this.containerEl);
		this.root.render(<SettingsView app={this.app} plugin={this.plugin} refresh={() => this.display()} />);
	}

	hide(): void {
		this.root?.unmount();
		this.root = null;
		this.containerEl.empty();
	}
}

function SettingsView({ app, plugin, refresh }: { app: App; plugin: InstaSyncPlugin; refresh: () => void }) {
	return (
		<>
			<h2>InstaSync</h2>
			<p className="setting-item-description">
				Real-time collaborative editing for every Markdown file in this vault. Sign in, then create or join a synced vault.
			</p>
			<SettingRow
				name="Enable syncing"
				desc="Connect to the server and sync this vault. Toggle off to work offline."
				control={
					<input
						type="checkbox"
						checked={plugin.settings.enabled}
						onChange={(event) => {
							void (async () => {
								plugin.settings.enabled = event.currentTarget.checked;
								await plugin.saveSettings();
								await plugin.reloadSync();
								refresh();
							})();
						}}
					/>
				}
			/>
			<SettingRow
				name="Auth server URL"
				desc="Base URL of your InstaSync auth server. Example: http://127.0.0.1:8081"
				control={
					<input
						type="text"
						placeholder="http://127.0.0.1:8081"
						defaultValue={plugin.settings.authServerUrl}
						onChange={(event) => {
							void (async () => {
								plugin.settings.authServerUrl = event.currentTarget.value.trim().replace(/\/$/, "");
								await plugin.saveSettings();
							})();
						}}
					/>
				}
			/>
			<AccountSection plugin={plugin} refresh={refresh} />
			{plugin.auth.isLoggedIn ? <VaultsSection app={app} plugin={plugin} refresh={refresh} /> : null}
			<CursorSection plugin={plugin} refresh={refresh} />
		</>
	);
}

function AccountSection({ plugin, refresh }: { plugin: InstaSyncPlugin; refresh: () => void }) {
	const [pasted, setPasted] = useState("");

	return (
		<>
			<h3>Account</h3>
			{plugin.auth.isLoggedIn ? (
				<SettingRow
					name={`Signed in as ${plugin.settings.userDisplayName || "signed in"}`}
					desc={plugin.settings.userEmail}
					control={
						<button
							className="mod-warning"
							onClick={() => {
								void (async () => {
									await plugin.logout();
									refresh();
								})();
							}}
						>
							Log out
						</button>
					}
				/>
			) : (
				<>
					<SettingRow
						name="Sign in"
						desc="Opens your browser to authenticate via SSO, then returns to Obsidian."
						control={
							<button
								className="mod-cta"
								onClick={() => {
									void (async () => {
										try {
											await plugin.auth.login();
											new Notice("InstaSync: signed in.");
											await plugin.onLoggedIn();
											refresh();
										} catch (e) {
											new Notice(`InstaSync: sign-in failed. ${(e as Error).message}`);
										}
									})();
								}}
							>
								Sign in with SSO
							</button>
						}
					/>
					<SettingRow
						name="Paste code"
						desc="If the browser didn't return to Obsidian, paste the code shown on the login page."
						control={
							<>
								<input type="text" placeholder="session code" value={pasted} onChange={(event) => setPasted(event.currentTarget.value.trim())} />
								<button
									onClick={() => {
										if (!pasted) return;
										void (async () => {
											try {
												await plugin.auth.setSession(pasted);
												new Notice("InstaSync: signed in.");
												await plugin.onLoggedIn();
												refresh();
											} catch (e) {
												new Notice(`InstaSync: invalid code. ${(e as Error).message}`);
											}
										})();
									}}
								>
									Apply
								</button>
							</>
						}
					/>
				</>
			)}
		</>
	);
}

function VaultsSection({ app, plugin, refresh }: { app: App; plugin: InstaSyncPlugin; refresh: () => void }) {
	const [newVaultName, setNewVaultName] = useState(app.vault.getName());
	const [inviteCode, setInviteCode] = useState("");
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
			<h3>Vaults</h3>
			<SettingRow
				name="Create a synced vault from this local vault"
				desc="Uploads your current Markdown files as a new shared vault."
				control={
					<>
						<input type="text" value={newVaultName} onChange={(event) => setNewVaultName(event.currentTarget.value.trim())} />
						<button
							className="mod-cta"
							onClick={() => {
								if (!newVaultName) return;
								void (async () => {
									try {
										await plugin.createAndActivateVault(newVaultName);
										new Notice(`InstaSync: created and syncing "${newVaultName}".`);
										refresh();
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
			<SettingRow
				name="Join a vault with an invite"
				desc="Redeems an invite, then adopts that vault locally (erasing local Markdown)."
				control={
					<>
						<input type="text" placeholder="four-word-invite-code" value={inviteCode} onChange={(event) => setInviteCode(event.currentTarget.value.trim())} />
						<button
							onClick={() => {
								if (!inviteCode) return;
								void (async () => {
									try {
										const { vaultId, name } = await plugin.auth.redeemInvite(inviteCode);
										await plugin.adoptVault(vaultId, name);
										refresh();
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
			{error ? <p className="setting-item-description">{error}</p> : null}
			{!error && vaults === null ? <p className="setting-item-description">Loading vaults...</p> : null}
			{vaults?.length === 0 ? <p className="setting-item-description">You have no vaults yet. Create one or redeem an invite above.</p> : null}
			{vaults?.map((vault) => (
				<VaultRow key={vault.id} app={app} plugin={plugin} vault={vault} refresh={refresh} />
			))}
		</>
	);
}

function VaultRow({ app, plugin, vault, refresh }: { app: App; plugin: InstaSyncPlugin; vault: VaultInfo; refresh: () => void }) {
	const active = vault.id === plugin.settings.activeVaultId;
	return (
		<SettingRow
			name={vault.name + (active ? "  *  active" : "")}
			desc={`Role: ${vault.role}`}
			control={
				<>
					{!active ? (
						<button
							onClick={() => {
								void (async () => {
									try {
										await plugin.adoptVault(vault.id, vault.name);
										refresh();
									} catch (e) {
										new Notice(`InstaSync: switch failed. ${(e as Error).message}`);
									}
								})();
							}}
						>
							Switch (adopt)
						</button>
					) : null}
					{vault.role === "admin" ? (
						<>
							<button
								onClick={() => {
									void (async () => {
										try {
											const { code } = await plugin.auth.createInvite(vault.id);
											void navigator.clipboard?.writeText(code).catch(() => {});
											new Notice(`InstaSync invite (copied):\n${code}`, 15000);
										} catch (e) {
											new Notice(`InstaSync: invite failed. ${(e as Error).message}`);
										}
									})();
								}}
							>
								Invite
							</button>
							<button onClick={() => new VaultMembersModal(app, plugin, vault).open()}>Members</button>
						</>
					) : null}
				</>
			}
		/>
	);
}

function CursorSection({ plugin, refresh }: { plugin: InstaSyncPlugin; refresh: () => void }) {
	return (
		<>
			<h3>Your cursor</h3>
			<SettingRow
				name="Display name"
				desc="Name shown to other editors on your cursor."
				control={
					<>
						<input
							type="text"
							defaultValue={plugin.settings.clientName}
							onChange={(event) => {
								void (async () => {
									plugin.settings.clientName = event.currentTarget.value;
									await plugin.saveSettings();
									plugin.updateLocalAwareness();
								})();
							}}
						/>
						<button
							aria-label="Generate a new name and color"
							title="Generate a new name and color"
							onClick={() => {
								void (async () => {
									const id = generateClientIdentity();
									plugin.settings.clientName = id.name;
									plugin.settings.clientColor = id.color;
									plugin.settings.clientColorLight = id.colorLight;
									await plugin.saveSettings();
									plugin.updateLocalAwareness();
									refresh();
								})();
							}}
						>
							Randomize
						</button>
					</>
				}
			/>
			<SettingRow
				name="Cursor color"
				desc="The color of your cursor and selection for other editors."
				control={
					<input
						type="color"
						defaultValue={plugin.settings.clientColor}
						onChange={(event) => {
							void (async () => {
								plugin.settings.clientColor = event.currentTarget.value;
								plugin.settings.clientColorLight = event.currentTarget.value + "33";
								await plugin.saveSettings();
								plugin.updateLocalAwareness();
							})();
						}}
					/>
				}
			/>
		</>
	);
}

function SettingRow({ name, desc, control }: { name: string; desc?: string; control: ReactNode }) {
	return (
		<div className="setting-item">
			<div className="setting-item-info">
				<div className="setting-item-name">{name}</div>
				{desc ? <div className="setting-item-description">{desc}</div> : null}
			</div>
			<div className="setting-item-control">{control}</div>
		</div>
	);
}
