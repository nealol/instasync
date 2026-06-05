import { App, Modal, Notice, PluginSettingTab } from "obsidian";
import { createRoot, type Root } from "react-dom/client";
import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type InstaSyncPlugin from "./main";
import { normalizeServerUrl, type MemberInfo, type VaultInfo } from "./auth";
import { generateClientIdentity } from "./names";

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
	const fullyConfigured = plugin.auth.isLoggedIn && !!plugin.settings.activeVaultId;
	return fullyConfigured ? <FullSettings app={app} plugin={plugin} refresh={refresh} /> : <SetupView app={app} plugin={plugin} refresh={refresh} />;
}

type SetupStep = "server" | "choose" | "create" | "existing" | "invite";

function SetupView({ app, plugin, refresh }: { app: App; plugin: InstaSyncPlugin; refresh: () => void }) {
	const [step, setStep] = useState<SetupStep>(plugin.auth.isLoggedIn ? "choose" : "server");
	const [serverUrl, setServerUrl] = useState(plugin.settings.authServerUrl);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");

	return (
		<div className="instasync-setup-wrap">
			<div className="instasync-setup-card">
				<h2>Set up InstaSync</h2>
				{step === "server" ? (
					<form
						onSubmit={(event) => {
							event.preventDefault();
							void (async () => {
								setBusy(true);
								setError("");
								try {
									await plugin.auth.loginToServer(serverUrl);
									await plugin.onLoggedIn();
									setStep("choose");
								} catch (e) {
									setError((e as Error).message);
								} finally {
									setBusy(false);
								}
							})();
						}}
					>
						<p className="setting-item-description">Enter your InstaSync server URL to start syncing this vault.</p>
						<input className="instasync-w-full" type="text" placeholder="https://instasync.example.com" value={serverUrl} onChange={(event) => setServerUrl(event.currentTarget.value)} />
						{error ? <p className="instasync-error">{error}</p> : null}
						<button className="mod-cta instasync-wide-button" type="submit" disabled={busy}>{busy ? "Waiting for SSO..." : "Get Started"}</button>
					</form>
				) : null}
				{step === "choose" ? <SetupChoices onCreate={() => setStep("create")} onExisting={() => setStep("existing")} onInvite={() => setStep("invite")} /> : null}
				{step === "create" ? <CreateVaultStep app={app} plugin={plugin} refresh={refresh} onBack={() => setStep("choose")} /> : null}
				{step === "existing" ? <ExistingVaultStep plugin={plugin} refresh={refresh} onBack={() => setStep("choose")} /> : null}
				{step === "invite" ? <InviteVaultStep plugin={plugin} refresh={refresh} onBack={() => setStep("choose")} /> : null}
			</div>
		</div>
	);
}

function SetupChoices({ onCreate, onExisting, onInvite }: { onCreate: () => void; onExisting: () => void; onInvite: () => void }) {
	return (
		<div className="instasync-choice-list">
			<p className="setting-item-description">Choose how this local vault should connect to a remote vault.</p>
			<button className="instasync-choice" onClick={onCreate}><strong>Create a new Remote Vault</strong><span>Use the Markdown files already in this local vault.</span></button>
			<button className="instasync-choice" onClick={onExisting}><strong>Initialize an existing Remote Vault</strong><span>Choose a vault you own or belong to, then erase local Markdown and pull it down.</span></button>
			<button className="instasync-choice" onClick={onInvite}><strong>Join a new Remote Vault</strong><span>Redeem an invite code, then decide whether to adopt that vault locally.</span></button>
		</div>
	);
}

function CreateVaultStep({ app, plugin, refresh, onBack }: { app: App; plugin: InstaSyncPlugin; refresh: () => void; onBack: () => void }) {
	const [name, setName] = useState(app.vault.getName());
	const [busy, setBusy] = useState(false);
	return (
		<>
			<h3>Create Remote Vault</h3>
			<p className="setting-item-description">Name the remote vault that will be created from this local vault.</p>
			<input className="instasync-wide-input" value={name} onChange={(event) => setName(event.currentTarget.value)} />
			<div className="instasync-actions"><button onClick={onBack}>Back</button><button className="mod-cta" disabled={busy || !name.trim()} onClick={() => void runNotice(setBusy, async () => { await plugin.createAndActivateVault(name.trim()); new Notice(`InstaSync: created and syncing "${name.trim()}".`); refresh(); })}>Create & Sync</button></div>
		</>
	);
}

function ExistingVaultStep({ plugin, refresh, onBack }: { plugin: InstaSyncPlugin; refresh: () => void; onBack: () => void }) {
	const { vaults, error, reload } = useVaults(plugin);
	const [confirm, setConfirm] = useState<VaultInfo | null>(null);
	return (
		<>
			<h3>Initialize Existing Remote Vault</h3>
			{confirm ? <EraseConfirm vault={confirm} onCancel={() => setConfirm(null)} onConfirm={() => void runNotice(undefined, async () => { await plugin.adoptVault(confirm.id, confirm.name); new Notice(`InstaSync: adopting "${confirm.name}"...`); refresh(); })} /> : null}
			{!confirm ? <>
				<p className="setting-item-description">Choose a remote vault. You will confirm before local Markdown is erased.</p>
				{error ? <p className="instasync-error">{error}</p> : null}
				{!error && vaults === null ? <p className="setting-item-description">Loading vaults...</p> : null}
				{vaults?.length === 0 ? <p className="setting-item-description">No remote vaults found.</p> : null}
				{vaults?.map((vault) => <button key={vault.id} className="instasync-choice" onClick={() => setConfirm(vault)}><strong>{vault.name}</strong><span>Role: {vault.role}{vault.owner ? " * owner" : ""}</span></button>)}
				<div className="instasync-actions"><button onClick={onBack}>Back</button><button onClick={reload}>Refresh</button></div>
			</> : null}
		</>
	);
}

function InviteVaultStep({ plugin, refresh, onBack }: { plugin: InstaSyncPlugin; refresh: () => void; onBack: () => void }) {
	const [code, setCode] = useState("");
	const [joined, setJoined] = useState<{ vaultId: string; name: string } | null>(null);
	const [busy, setBusy] = useState(false);
	return (
		<>
			<h3>Join Remote Vault</h3>
			{joined ? <EraseConfirm vault={{ id: joined.vaultId, name: joined.name }} onCancel={onBack} onConfirm={() => void runNotice(undefined, async () => { await plugin.adoptVault(joined.vaultId, joined.name); new Notice(`InstaSync: adopting "${joined.name}"...`); refresh(); })} /> : <>
				<p className="setting-item-description">Enter an invite code. Redeeming it adds you as a member before you decide whether to adopt it locally.</p>
				<input className="instasync-wide-input" placeholder="four-word-invite-code" value={code} onChange={(event) => setCode(event.currentTarget.value.trim())} />
				<div className="instasync-actions"><button onClick={onBack}>Back</button><button className="mod-cta" disabled={busy || !code} onClick={() => void runNotice(setBusy, async () => { setJoined(await plugin.auth.redeemInvite(code)); })}>Redeem Invite</button></div>
			</>}
		</>
	);
}

function EraseConfirm({ vault, onConfirm, onCancel }: { vault: Pick<VaultInfo, "id" | "name">; onConfirm: () => void; onCancel: () => void }) {
	return (
		<div className="instasync-warning-box">
			<strong>Erase local Markdown and sync "{vault.name}"?</strong>
			<p>This deletes all non-conflict-copy Markdown files in this local Obsidian vault and replaces them with the remote vault.</p>
			<div className="instasync-actions"><button onClick={onCancel}>Cancel</button><button className="mod-warning" onClick={onConfirm}>Erase & Sync</button></div>
		</div>
	);
}

function FullSettings({ app, plugin, refresh }: { app: App; plugin: InstaSyncPlugin; refresh: () => void }) {
	return (
		<>
			<h2>InstaSync</h2>
			<AccountSection plugin={plugin} refresh={refresh} />
			<PauseSection plugin={plugin} refresh={refresh} />
			<DeviceSection plugin={plugin} refresh={refresh} />
			<VaultDetails app={app} plugin={plugin} />
			<AdvancedSettings app={app} plugin={plugin} refresh={refresh} />
		</>
	);
}

function AccountSection({ plugin, refresh }: { plugin: InstaSyncPlugin; refresh: () => void }) {
	return <><h3>Account</h3><SettingRow name={plugin.settings.userDisplayName || "Signed in"} desc={plugin.settings.userEmail} control={<button className="mod-warning" onClick={() => void runNotice(undefined, async () => { await plugin.logout(); refresh(); })}>Log out</button>} /></>;
}

function PauseSection({ plugin, refresh }: { plugin: InstaSyncPlugin; refresh: () => void }) {
	return <SettingRow name="Pause syncing" desc="When enabled, InstaSync stays signed in but stops online sync for this vault." control={<input type="checkbox" checked={!plugin.settings.enabled} onChange={(event) => void runNotice(undefined, async () => { plugin.settings.enabled = !event.currentTarget.checked; await plugin.saveSettings(); await plugin.reloadSync(); refresh(); })} />} />;
}

function DeviceSection({ plugin, refresh }: { plugin: InstaSyncPlugin; refresh: () => void }) {
	return (
		<>
			<h3>Your Device</h3>
			<SettingRow name="Display name" desc="Name shown to other editors on your cursor." control={<><input type="text" defaultValue={plugin.settings.clientName} onChange={(event) => void runNotice(undefined, async () => { plugin.settings.clientName = event.currentTarget.value; await plugin.saveSettings(); plugin.updateLocalAwareness(); })} /><button aria-label="Randomize display name" title="Randomize display name" onClick={() => void runNotice(undefined, async () => { plugin.settings.clientName = generateClientIdentity().name; await plugin.saveSettings(); plugin.updateLocalAwareness(); refresh(); })}>🎲</button></>} />
			<SettingRow name="Cursor color" desc="The color of your cursor and selection for other editors." control={<><input type="color" value={plugin.settings.clientColor} onChange={(event) => void runNotice(undefined, async () => { plugin.settings.clientColor = event.currentTarget.value; plugin.settings.clientColorLight = event.currentTarget.value + "33"; await plugin.saveSettings(); plugin.updateLocalAwareness(); refresh(); })} /><button aria-label="Randomize cursor color" title="Randomize cursor color" onClick={() => void runNotice(undefined, async () => { const id = generateClientIdentity(); plugin.settings.clientColor = id.color; plugin.settings.clientColorLight = id.colorLight; await plugin.saveSettings(); plugin.updateLocalAwareness(); refresh(); })}>🎲</button></>} />
		</>
	);
}

function VaultDetails({ plugin }: { app: App; plugin: InstaSyncPlugin }) {
	const { vaults, error: vaultError, reload: reloadVaults } = useVaults(plugin);
	const activeVault = useMemo(() => vaults?.find((vault) => vault.id === plugin.settings.activeVaultId) ?? null, [plugin.settings.activeVaultId, vaults]);
	const { members, error: membersError, reload: reloadMembers } = useMembers(plugin, activeVault?.id ?? "");
	const reloadAll = () => { reloadVaults(); reloadMembers(); };
	return (
		<>
			<h3>Vault Details</h3>
			{vaultError ? <p className="instasync-error">{vaultError}</p> : null}
			{activeVault ? <p className="setting-item-description">Syncing <strong>{activeVault.name}</strong>. Your role: {activeVault.role}{activeVault.owner ? " * owner" : ""}.</p> : <p className="setting-item-description">Loading vault details...</p>}
			{membersError ? <p className="instasync-error">{membersError}</p> : null}
			{members === null ? <p className="setting-item-description">Loading members...</p> : null}
			{activeVault && members?.map((member) => <MemberRow key={member.userId} plugin={plugin} vault={activeVault} member={member} reload={reloadAll} />)}
			{activeVault?.role === "admin" ? <InviteGenerator plugin={plugin} vault={activeVault} /> : null}
		</>
	);
}

function MemberRow({ plugin, vault, member, reload }: { plugin: InstaSyncPlugin; vault: VaultInfo; member: MemberInfo; reload: () => void }) {
	const isSelf = member.email === plugin.settings.userEmail;
	const canPromote = vault.role === "admin" && member.role !== "admin";
	const canRemove = !member.owner && !isSelf && (member.role === "member" ? vault.role === "admin" : !!vault.owner);
	return <SettingRow name={`${member.displayName || member.email}${member.owner ? " (owner)" : ""}`} desc={`${member.email} * ${member.role}`} control={<>{canPromote ? <button onClick={() => void runNotice(undefined, async () => { await plugin.auth.promoteMember(vault.id, member.userId); new Notice("InstaSync: promoted."); reload(); })}>Promote to admin</button> : null}{canRemove ? <button className="mod-warning" onClick={() => void runNotice(undefined, async () => { await plugin.auth.removeMember(vault.id, member.userId); new Notice("InstaSync: member removed."); reload(); })}>Remove</button> : null}</>} />;
}

function InviteGenerator({ plugin, vault }: { plugin: InstaSyncPlugin; vault: VaultInfo }) {
	const [code, setCode] = useState("");
	return <SettingRow name="Invite code" desc="Generate a single-use invite for this vault." control={<><button onClick={() => void runNotice(undefined, async () => { const invite = await plugin.auth.createInvite(vault.id); setCode(invite.code); void navigator.clipboard?.writeText(invite.code).catch(() => {}); new Notice(`InstaSync invite copied: ${invite.code}`, 15000); })}>Generate invite</button>{code ? <code>{code}</code> : null}</>} />;
}

function AdvancedSettings({ app, plugin, refresh }: { app: App; plugin: InstaSyncPlugin; refresh: () => void }) {
	return <details className="instasync-advanced"><summary>Advanced settings</summary><p className="setting-item-description">Changing the InstaSync server URL should usually only be done when resetting or migrating the entire vault.</p><SettingRow name="Instasync server URL" desc={plugin.settings.authServerUrl} control={<button onClick={() => new ServerMigrationModal(app, plugin, refresh).open()}>Change server...</button>} /></details>;
}

class ServerMigrationModal extends Modal {
	private plugin: InstaSyncPlugin;
	private refresh: () => void;
	private root: Root | null = null;

	constructor(app: App, plugin: InstaSyncPlugin, refresh: () => void) {
		super(app);
		this.plugin = plugin;
		this.refresh = refresh;
	}

	onOpen(): void {
		this.root = createRoot(this.contentEl);
		this.root.render(<ServerMigrationView app={this.app} plugin={this.plugin} refresh={this.refresh} close={() => this.close()} />);
	}

	onClose(): void {
		this.root?.unmount();
		this.root = null;
		this.contentEl.empty();
	}
}

function ServerMigrationView({ app, plugin, refresh, close }: { app: App; plugin: InstaSyncPlugin; refresh: () => void; close: () => void }) {
	const [url, setUrl] = useState(plugin.settings.authServerUrl);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	return (
		<>
			<h2>Change InstaSync Server</h2>
			<p className="setting-item-description">This requires SSO on the new server. The change is only saved if that server has a remote vault named "{app.vault.getName()}".</p>
			<input className="instasync-wide-input" type="url" value={url} onChange={(event) => setUrl(event.currentTarget.value)} />
			{error ? <p className="instasync-error">{error}</p> : null}
			<div className="instasync-actions"><button onClick={close}>Cancel</button><button className="mod-cta" disabled={busy} onClick={() => void (async () => {
				setBusy(true);
				setError("");
				try {
					const normalized = normalizeServerUrl(url);
					const { token, me } = await plugin.auth.authenticateAt(normalized);
					const vaults = await plugin.auth.listVaultsAt(normalized, token);
					const match = vaults.find((vault) => vault.name === app.vault.getName());
					if (!match) throw new Error(`No remote vault named "${app.vault.getName()}" was found on that server.`);
					plugin.settings.activeVaultId = match.id;
					await plugin.auth.setSessionForServer(normalized, token, me);
					await plugin.saveSettings();
					await plugin.reloadSync();
					new Notice("InstaSync: server updated.");
					close();
					refresh();
				} catch (e) {
					setError((e as Error).message);
				} finally {
					setBusy(false);
				}
			})()}>{busy ? "Waiting for SSO..." : "Test with SSO"}</button></div>
		</>
	);
}

function useVaults(plugin: InstaSyncPlugin) {
	const [reloadKey, setReloadKey] = useState(0);
	const [vaults, setVaults] = useState<VaultInfo[] | null>(null);
	const [error, setError] = useState("");
	useEffect(() => {
		let cancelled = false;
		setVaults(null);
		setError("");
		void (async () => {
			try {
				const listed = await plugin.auth.listVaults();
				if (!cancelled) setVaults(listed);
			} catch (e) {
				if (!cancelled) setError(`Could not load vaults: ${(e as Error).message}`);
			}
		})();
		return () => { cancelled = true; };
	}, [plugin, reloadKey]);
	return { vaults, error, reload: () => setReloadKey((key) => key + 1) };
}

function useMembers(plugin: InstaSyncPlugin, vaultId: string) {
	const [reloadKey, setReloadKey] = useState(0);
	const [members, setMembers] = useState<MemberInfo[] | null>(null);
	const [error, setError] = useState("");
	useEffect(() => {
		if (!vaultId) return;
		let cancelled = false;
		setMembers(null);
		setError("");
		void (async () => {
			try {
				const listed = await plugin.auth.listMembers(vaultId);
				if (!cancelled) setMembers(listed);
			} catch (e) {
				if (!cancelled) setError(`Could not load members: ${(e as Error).message}`);
			}
		})();
		return () => { cancelled = true; };
	}, [plugin, vaultId, reloadKey]);
	return { members, error, reload: () => setReloadKey((key) => key + 1) };
}

async function runNotice(setBusy: ((busy: boolean) => void) | undefined, fn: () => Promise<void>): Promise<void> {
	try {
		setBusy?.(true);
		await fn();
	} catch (e) {
		new Notice(`InstaSync: ${(e as Error).message}`);
	} finally {
		setBusy?.(false);
	}
}

function SettingRow({ name, desc, control }: { name: string; desc?: ReactNode; control: ReactNode }) {
	return <div className="setting-item"><div className="setting-item-info"><div className="setting-item-name">{name}</div>{desc ? <div className="setting-item-description">{desc}</div> : null}</div><div className="setting-item-control">{control}</div></div>;
}
