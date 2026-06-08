import { App, ExtraButtonComponent, Modal, Notice, PluginSettingTab, ToggleComponent } from 'obsidian'
import { createRoot, type Root } from 'react-dom/client'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type RealtimePlugin from './main'
import { normalizeServerUrl, type KnownSession, type MemberInfo, type RemoteCursorInfo, type VaultInfo } from './auth'
import { PLUGIN_NAME } from './brand'
import { generateClientIdentity } from './names'

export interface RealtimeSettings {
    /** Base URL of the Realtime auth server, e.g. http://127.0.0.1:8081 */
    authServerUrl: string;
    /**
     * Stable id of the server at {@link authServerUrl}, from `/api/server-info`.
     * Combined with the server host, it namespaces this account's session token
     * in Obsidian's SecretStorage (which is shared across local vaults), so one
     * Obsidian client can hold tokens for multiple servers without collisions.
     */
    authServerId: string;
    /**
     * Server URL of an in-progress SSO setup login. Used for nothing else:
     * changing it cancels any pending SSO login (see AuthClient.beginSetupFor).
     */
    pendingSetupServerUrl: string;
    /** Identity from /api/me, cached for status + awareness defaults. */
    userId: string;
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
    /** Whether to sync binary (non-Markdown) files via the content-addressed blob store. */
    syncBinaries: boolean;
    /** Whether to sync Obsidian Canvas files as structured CRDT documents. */
    syncCanvases: boolean;
    /** Whether to sync Obsidian Bases files as structured CRDT documents. */
    syncBases: boolean;
    /**
     * Comma-separated globs (matched against the vault-relative path) of binary
     * files to exclude from sync, e.g. `*.tmp, .obsidian/**`. Empty syncs all.
     */
    binaryExcludeGlobs: string;
    /** Whether this device syncs whitelisted files under `.obsidian`. */
    syncConfigEnabled: boolean;
    /** Globs matched relative to `.obsidian`, e.g. `snippets/*.css`. */
    configIncludeGlobs: string[];
    /** Hidden advanced setting for verbose diagnostic logging. */
    diagnosticLogging: boolean;
}

export function defaultSettings(): RealtimeSettings {
    const identity = generateClientIdentity()
    return {
        authServerUrl: 'http://127.0.0.1:8081',
        authServerId: '',
        pendingSetupServerUrl: '',
        userId: '',
        userDisplayName: '',
        userEmail: '',
        activeVaultId: '',
        clientName: identity.name,
        clientColor: identity.color,
        clientColorLight: identity.colorLight,
        enabled: true,
        syncBinaries: true,
        syncCanvases: true,
        syncBases: true,
        binaryExcludeGlobs: '',
        syncConfigEnabled: false,
        configIncludeGlobs: [],
        diagnosticLogging: false,
    }
}

export class RealtimeSettingTab extends PluginSettingTab {
    plugin: RealtimePlugin
    private root: Root | null = null

    constructor(app: App, plugin: RealtimePlugin) {
        super(app, plugin)
        this.plugin = plugin
    }

    display(): void {
        this.root?.unmount()
        this.root = null
        this.containerEl.empty()
        this.root = createRoot(this.containerEl)
        this.root.render(<SettingsView app={this.app} plugin={this.plugin} refresh={() => this.display()}/>)
    }

    hide(): void {
        this.root?.unmount()
        this.root = null
        this.containerEl.empty()
    }
}

function SettingsView({ app, plugin, refresh }: { app: App; plugin: RealtimePlugin; refresh: () => void }) {
    const fullyConfigured = plugin.auth.isLoggedIn && !!plugin.settings.activeVaultId
    return fullyConfigured ? <FullSettings app={app} plugin={plugin} refresh={refresh}/> :
        <SetupView app={app} plugin={plugin} refresh={refresh}/>
}

type SetupStep = 'server' | 'choose' | 'create' | 'existing' | 'invite';

function SetupView({ app, plugin, refresh }: { app: App; plugin: RealtimePlugin; refresh: () => void }) {
    const [step, setStep] = useState<SetupStep>(plugin.auth.isLoggedIn ? 'choose' : 'server')
    const [serverUrl, setServerUrl] = useState(plugin.settings.authServerUrl)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState('')
    const [sessions, setSessions] = useState<KnownSession[]>([])
    // Reveal the paste-code fallback shortly after SSO starts, in case the deep
    // link back into Obsidian doesn't fire.
    const showPaste = useDelayedFlag(busy, 2000)

    useEffect(() => {
        let cancelled = false
        setSessions([])
        if (step !== 'server' || busy) return
        const timeout = window.setTimeout(() => {
            void plugin.auth.validSessionsForServer(serverUrl).then((result) => {
                if (!cancelled) setSessions(result)
            }).catch(() => {
                if (!cancelled) setSessions([])
            })
        }, 250)
        return () => {
            cancelled = true
            window.clearTimeout(timeout)
        }
    }, [busy, plugin, serverUrl, step])

    return (
        <div className="realtime-setup-wrap">
            <div className="realtime-setup-card">
                <h2>Set up {PLUGIN_NAME}</h2>
                {step === 'server' ? (
                    <form style={{marginTop: '-4px'}}
                        onSubmit={(event) => {
                            event.preventDefault()
                            void (async () => {
                                setBusy(true)
                                setError('')
                                try {
                                    await plugin.auth.loginToServer(serverUrl)
                                    await plugin.onLoggedIn()
                                    setStep('choose')
                                } catch (e) {
                                    setError((e as Error).message)
                                } finally {
                                    setBusy(false)
                                }
                            })()
                        }}
                    >
                        <p className="setting-item-description">Enter your Realtime server URL to start syncing this
                            vault.</p>
                        <input className="realtime-modal-input" type="text" placeholder="https://realtime.example.com"
                               value={serverUrl} onChange={(event) => setServerUrl(event.currentTarget.value)}/>
                        {error ? <p className="realtime-error">{error}</p> : null}
                        <SsoPasteFallback plugin={plugin} visible={showPaste}/>
                        <button className="mod-cta realtime-wide-button" type="submit"
                                disabled={busy}>{busy ? 'Waiting for SSO...' : 'Log in with SSO'}</button>
                        {sessions.map((session) => <button key={session.tokenKey} className="realtime-wide-button" type="button"
                                disabled={busy} onClick={() => void (async () => {
                                    setBusy(true)
                                    setError('')
                                    try {
                                        await plugin.auth.useKnownSession(session)
                                        await plugin.onLoggedIn()
                                        setStep('choose')
                                    } catch (e) {
                                        setError((e as Error).message)
                                    } finally {
                                        setBusy(false)
                                    }
                                })()}>Log in as {session.displayName || session.email}</button>)}
                    </form>
                ) : null}
                {step === 'choose' ?
                    <SetupChoices onCreate={() => setStep('create')} onExisting={() => setStep('existing')}
                                  onInvite={() => setStep('invite')}/> : null}
                {step === 'create' ? <CreateVaultStep app={app} plugin={plugin} refresh={refresh}
                                                      onBack={() => setStep('choose')}/> : null}
                {step === 'existing' ?
                    <ExistingVaultStep plugin={plugin} refresh={refresh} onBack={() => setStep('choose')}/> : null}
                {step === 'invite' ?
                    <InviteVaultStep plugin={plugin} refresh={refresh} onBack={() => setStep('choose')}/> : null}
            </div>
        </div>
    )
}

function SetupChoices({ onCreate, onExisting, onInvite }: {
    onCreate: () => void;
    onExisting: () => void;
    onInvite: () => void
}) {
    return (
        <div className="realtime-choice-list" style={{marginTop: '-16px'}}>
            <p className="setting-item-description">Choose how this local vault should connect to a remote vault.</p>
            <button className="realtime-choice" onClick={onCreate}><strong>Create a new Remote Vault</strong><span>Use the Markdown files already in this local vault.</span>
            </button>
            <button className="realtime-choice" onClick={onExisting}><strong>Initialize an existing Remote
                Vault</strong><span>Replace local vault with a synced remote one.</span></button>
            <button className="realtime-choice" onClick={onInvite}><strong>Join a new Remote Vault</strong><span>Use an invite code to join a vault.</span>
            </button>
        </div>
    )
}

function CreateVaultStep({ app, plugin, refresh, onBack }: {
    app: App;
    plugin: RealtimePlugin;
    refresh: () => void;
    onBack: () => void
}) {
    const [name, setName] = useState(app.vault.getName())
    const [busy, setBusy] = useState(false)
    return (
        <>
            {/*<h3>Create Remote Vault</h3>*/}
            <p className="setting-item-description">Name your new remote vault.</p>
            <input className="realtime-modal-input" type="text" value={name}
                   onChange={(event) => setName(event.currentTarget.value)}/>
            <div className="realtime-actions">
                <button onClick={onBack}>Back</button>
                <button className="mod-cta" disabled={busy || !name.trim()}
                        onClick={() => void runNotice(setBusy, async () => {
                            await plugin.createAndActivateVault(name.trim())
                            new Notice(`${PLUGIN_NAME}: created and syncing "${name.trim()}".`)
                            refresh()
                        })}>Create & Sync
                </button>
            </div>
        </>
    )
}

function ExistingVaultStep({ plugin, refresh, onBack }: {
    plugin: RealtimePlugin;
    refresh: () => void;
    onBack: () => void
}) {
    const { vaults, error, reload } = useVaults(plugin)
    const [confirm, setConfirm] = useState<VaultInfo | null>(null)
    return (
        <>
            {/*<h3>Initialize Existing Remote Vault</h3>*/}
            {confirm ? <EraseConfirm vault={confirm} onCancel={() => setConfirm(null)}
                                     onConfirm={() => void runNotice(undefined, async () => {
                                         await plugin.adoptVault(confirm.id, confirm.name)
                                         refresh()
                                     })}/> : null}
            {!confirm ? <>
                <p className="setting-item-description">Choose a remote vault to clone.</p>
                {error ? <p className="realtime-error">{error}</p> : null}
                {!error && vaults === null ? <p className="setting-item-description">Loading vaults...</p> : null}
                {vaults?.length === 0 ? <p className="setting-item-description">No remote vaults found.</p> : null}
                <div className="realtime-choice-list">
                    {vaults?.map((vault) => <button key={vault.id} className="realtime-choice"
                                                    onClick={() => setConfirm(vault)}>
                        <strong>{vault.name}</strong><span>Role: {vault.role}{vault.owner ? ' (owner)' : ''}</span>
                    </button>)}
                </div>
                <div className="realtime-actions">
                    <button onClick={onBack}>Back</button>
                    <button onClick={reload}>Refresh</button>
                </div>
            </> : null}
        </>
    )
}

function InviteVaultStep({ plugin, refresh, onBack }: {
    plugin: RealtimePlugin;
    refresh: () => void;
    onBack: () => void
}) {
    const [code, setCode] = useState('')
    const [joined, setJoined] = useState<{ vaultId: string; name: string } | null>(null)
    const [busy, setBusy] = useState(false)
    return (
        <>
            {/*<h3>Join Remote Vault</h3>*/}
            {joined ? <EraseConfirm vault={{ id: joined.vaultId, name: joined.name }} onCancel={onBack}
                                    onConfirm={() => void runNotice(undefined, async () => {
                                        await plugin.adoptVault(joined.vaultId, joined.name)
                                        refresh()
                                    })}/> : <>
                <p className="setting-item-description">Enter an invite code from another person.</p>
                <input className="realtime-modal-input" type="text" placeholder="four-word-invite-code" value={code}
                       onChange={(event) => setCode(event.currentTarget.value.trim())}/>
                <div className="realtime-actions">
                    <button onClick={onBack}>Back</button>
                    <button className="mod-cta" disabled={busy || !code}
                            onClick={() => void runNotice(setBusy, async () => {
                                setJoined(await plugin.auth.redeemInvite(code))
                            })}>Redeem Invite
                    </button>
                </div>
            </>}
        </>
    )
}

function EraseConfirm({ vault, onConfirm, onCancel }: {
    vault: Pick<VaultInfo, 'id' | 'name'>;
    onConfirm: () => void;
    onCancel: () => void
}) {
    return (
        <div className="realtime-warning-box">
            <strong>Erase local Markdown and sync "{vault.name}"?</strong>
            <p>This deletes all non-conflict-copy Markdown files in this local Obsidian vault and replaces them with the
                remote vault.</p>
            <div className="realtime-actions">
                <button onClick={onCancel}>Cancel</button>
                <button className="mod-warning" onClick={onConfirm}>Erase & Sync</button>
            </div>
        </div>
    )
}

function FullSettings({ app, plugin, refresh }: { app: App; plugin: RealtimePlugin; refresh: () => void }) {
    return (
        <>
            {/*<h2>Realtime</h2>*/}
            <AccountSection plugin={plugin} refresh={refresh}/>
            <EnableSyncSection plugin={plugin} refresh={refresh}/>
            <StructuredSyncSection plugin={plugin} refresh={refresh}/>
            <BinarySyncSection plugin={plugin} refresh={refresh}/>
            <DeviceSection plugin={plugin}/>
            <VaultDetails app={app} plugin={plugin}/>
            <AdvancedSettings app={app} plugin={plugin} refresh={refresh}/>
        </>
    )
}

function AccountSection({ plugin, refresh }: { plugin: RealtimePlugin; refresh: () => void }) {
    return <><h3>Account</h3><SettingRow name={plugin.settings.userDisplayName || 'Signed in'}
                                         desc={plugin.settings.userEmail} control={<button className="mod-warning"
                                                                                           onClick={() => void runNotice(undefined, async () => {
                                                                                               await plugin.logout()
                                                                                               refresh()
                                                                                           })}>Log out</button>}/></>
}

function EnableSyncSection({ plugin, refresh }: { plugin: RealtimePlugin; refresh: () => void }) {
    return <SettingRow name="Enable syncing"
                       desc="When on, this vault syncs online. Turn off to stay signed in but pause online sync."
                       control={<Toggle value={plugin.settings.enabled}
                                        onChange={(value) => void runNotice(undefined, async () => {
                                            plugin.settings.enabled = value
                                            await plugin.saveSettings()
                                            await plugin.reloadSync()
                                            if (!value) new Notice(`${PLUGIN_NAME}: syncing disabled for this vault.`)
                                            refresh()
                                        })}/>}/>
}

function StructuredSyncSection({ plugin, refresh }: { plugin: RealtimePlugin; refresh: () => void }) {
    return <>
        <SettingRow name="Sync canvases"
                    desc="Sync .canvas files as structured CRDT documents. Live canvas updates use Obsidian's private canvas API when available, with disk write-through fallback."
                    control={<Toggle value={plugin.settings.syncCanvases}
                                     onChange={(value) => void runNotice(undefined, async () => {
                                         plugin.settings.syncCanvases = value
                                         await plugin.saveSettings()
                                         await plugin.reloadSync()
                                         refresh()
                                     })}/>}/>
        <SettingRow name="Sync bases"
                    desc="Sync .base files as structured YAML CRDT documents. YAML formatting may be normalized when remote changes write back to disk."
                    control={<Toggle value={plugin.settings.syncBases}
                                     onChange={(value) => void runNotice(undefined, async () => {
                                         plugin.settings.syncBases = value
                                         await plugin.saveSettings()
                                         await plugin.reloadSync()
                                         refresh()
                                     })}/>}/>
    </>
}

function BinarySyncSection({ plugin, refresh }: { plugin: RealtimePlugin; refresh: () => void }) {
    const [globs, setGlobs] = useState(plugin.settings.binaryExcludeGlobs)
    return <>
        <SettingRow name="Sync attachments"
                    desc="Sync binary files (images, PDFs, and other non-Markdown files) via the content-addressed blob store."
                    control={<Toggle value={plugin.settings.syncBinaries}
                                     onChange={(value) => void runNotice(undefined, async () => {
                                         plugin.settings.syncBinaries = value
                                         await plugin.saveSettings()
                                         await plugin.reloadSync()
                                         refresh()
                                     })}/>}/>
        {plugin.settings.syncBinaries ? <SettingRow name="Attachment exclusions"
                    desc="Comma-separated globs (matched on the file path) to skip, e.g. *.tmp, private/**."
                    control={<input className="realtime-modal-input" type="text" value={globs}
                                    placeholder="*.tmp, private/**"
                                    onChange={(e) => setGlobs(e.currentTarget.value)}
                                    onBlur={() => void (async () => {
                                        if (globs === plugin.settings.binaryExcludeGlobs) return
                                        plugin.settings.binaryExcludeGlobs = globs
                                        await plugin.saveSettings()
                                        await plugin.reloadSync()
                                    })()}/>}/> : null}
    </>
}

/**
 * Real Obsidian `ToggleComponent` mounted into a React-managed element, so the
 * switch looks and behaves exactly like a native settings toggle. The value is
 * applied before the change handler is wired so seeding it can't re-fire it; a
 * full settings re-render remounts this, so no separate value-sync is needed.
 */
function Toggle({ value, onChange }: { value: boolean; onChange: (value: boolean) => void }) {
    const ref = useRef<HTMLSpanElement>(null)
    const onChangeRef = useRef(onChange)
    onChangeRef.current = onChange
    const initial = useRef(value).current
    useEffect(() => {
        const el = ref.current
        if (!el) return
        new ToggleComponent(el).setValue(initial).onChange((v) => onChangeRef.current(v))
        return () => { el.empty() }
    }, [initial])
    return <span ref={ref}/>
}

/**
 * Real Obsidian `ExtraButtonComponent` mounted into a React-managed element,
 * giving the muted icon-button display used elsewhere in settings. `onClick` is
 * read through a ref so a re-render never needs to rebuild the component.
 */
function ExtraButton({ icon, tooltip, className, onClick }: { icon: string; tooltip?: string; className?: string; onClick: () => void }) {
    const ref = useRef<HTMLSpanElement>(null)
    const onClickRef = useRef(onClick)
    onClickRef.current = onClick
    useEffect(() => {
        const el = ref.current
        if (!el) return
        const button = new ExtraButtonComponent(el).setIcon(icon).onClick(() => onClickRef.current())
        if (tooltip) button.setTooltip(tooltip)
        return () => { el.empty() }
    }, [icon, tooltip])
    return <span className={className} ref={ref}/>
}

function DeviceSection({ plugin }: { plugin: RealtimePlugin }) {
    // Local state so randomizing/editing re-renders only this section, instead of
    // calling the page-level refresh (which reloads the slow vaults/members lists).
    const [name, setName] = useState(plugin.settings.clientName)
    const [color, setColor] = useState(plugin.settings.clientColor)

    const applyName = (value: string) => {
        setName(value)
        void runNotice(undefined, async () => {
            plugin.settings.clientName = value
            await plugin.saveSettings()
            plugin.updateLocalAwareness()
        })
    }
    const applyColor = (value: string) => {
        setColor(value)
        void runNotice(undefined, async () => {
            plugin.settings.clientColor = value
            plugin.settings.clientColorLight = value + '33'
            await plugin.saveSettings()
            plugin.updateLocalAwareness()
        })
    }

    return (
        <>
            <h3>Your Device</h3>
            <SettingRow name="Display name" desc="Name shown to other editors on your cursor."
                        control={<><input type="text" value={name}
                                          onChange={(event) => applyName(event.currentTarget.value)}/>
                            <ExtraButton icon="dice" tooltip="Randomize display name"
                                         onClick={() => applyName(generateClientIdentity().name)}/>
                        </>}/>
            <SettingRow name="Cursor color" desc="The color of your cursor and selection for other editors."
                        control={<><input type="color" value={color}
                                          onChange={(event) => applyColor(event.currentTarget.value)}/>
                            <ExtraButton icon="dice" tooltip="Randomize cursor color"
                                         onClick={() => applyColor(generateClientIdentity().color)}/>
                        </>}/>
        </>
    )
}

function VaultDetails({ plugin }: { app: App; plugin: RealtimePlugin }) {
    const { vaults, error: vaultError, reload: reloadVaults } = useVaults(plugin)
    const activeVault = useMemo(() => vaults?.find((vault) => vault.id === plugin.settings.activeVaultId) ?? null, [plugin.settings.activeVaultId, vaults])
    const { members, error: membersError, reload: reloadMembers } = useMembers(plugin, activeVault?.id ?? '')
    const reloadAll = () => {
        reloadVaults()
        reloadMembers()
    }
    return (
        <>
            <h3>Vault Details{activeVault ? ` - ${activeVault.name}` : ''}</h3>
            {vaultError ? <p className="realtime-error">{vaultError}</p> : null}
            {!activeVault ? <p className="setting-item-description">Loading vault details...</p> : null}
            {membersError ? <p className="realtime-error">{membersError}</p> : null}
            {members === null ? <p className="setting-item-description">Loading members...</p> : null}
            {activeVault && members?.map((member) => <MemberRow key={member.userId} plugin={plugin} vault={activeVault}
                                                                member={member} reload={reloadAll}/>)}
            {activeVault?.role === 'admin' ? <InviteGenerator plugin={plugin} vault={activeVault}/> : null}
            {activeVault?.role === 'admin' ? <RemoteCursors plugin={plugin} vault={activeVault}/> : null}
        </>
    )
}

function MemberRow({ plugin, vault, member, reload }: {
    plugin: RealtimePlugin;
    vault: VaultInfo;
    member: MemberInfo;
    reload: () => void
}) {
    const isSelf = member.email === plugin.settings.userEmail
    const canPromote = vault.role === 'admin' && member.role !== 'admin'
    const canRemove = !member.owner && !isSelf && (member.role === 'member' ? vault.role === 'admin' : !!vault.owner)
    return <SettingRow name={`${member.displayName || member.email}${member.owner ? ' (owner)' : ''}`}
                       desc={`${member.email} (${member.role})`}
                       control={<>{canPromote ? <button onClick={() => void runNotice(undefined, async () => {
                           await plugin.auth.promoteMember(vault.id, member.userId)
                            new Notice(`${PLUGIN_NAME}: promoted.`)
                           reload()
                       })}>Promote to admin</button> : null}{canRemove ?
                           <button className="mod-warning" onClick={() => void runNotice(undefined, async () => {
                               await plugin.auth.removeMember(vault.id, member.userId)
                                new Notice(`${PLUGIN_NAME}: member removed.`)
                               reload()
                           })}>Remove</button> : null}</>}/>
}

function InviteGenerator({ plugin, vault }: { plugin: RealtimePlugin; vault: VaultInfo }) {
    const [code, setCode] = useState('')
    return <SettingRow name="Add members" desc="Generate a single-use invite for this vault." control={<>
        <button onClick={() => void runNotice(undefined, async () => {
            const invite = await plugin.auth.createInvite(vault.id)
            setCode(invite.code)
            void navigator.clipboard?.writeText(invite.code).catch(() => {
            })
            new Notice(`${PLUGIN_NAME} invite copied: ${invite.code}`, 15000)
        })}>Generate invite
        </button>
        {code ? <code>{code}</code> : null}</>}/>
}

function RemoteCursors({ plugin, vault }: { plugin: RealtimePlugin; vault: VaultInfo }) {
    const { cursors, error, reload } = useRemoteCursors(plugin, vault.id)
    return <>
        <h3>Remote Cursors</h3>
        {error ? <p className="realtime-error">{error}</p> : null}
        {!error && cursors === null ? <p className="setting-item-description">Loading remote cursors...</p> : null}
        {cursors?.length === 0 ? <p className="setting-item-description">No remote cursors yet.</p> : null}
        {cursors?.map((cursor) => <RemoteCursorRow key={cursor.id} plugin={plugin} vault={vault} cursor={cursor} reload={reload}/>) }
        <SettingRow name="Add remote cursor" desc="Create an app-specific MCP URL with OAuth support and a secret token for direct bearer API calls."
                    control={<button onClick={() => new RemoteCursorNameModal(plugin.app, plugin, vault, reload).open()}>Add remote cursor</button>}/>
    </>
}

function RemoteCursorRow({ plugin, vault, cursor, reload }: {
    plugin: RealtimePlugin;
    vault: VaultInfo;
    cursor: RemoteCursorInfo;
    reload: () => void;
}) {
    return <SettingRow name={<span className="realtime-row-title-action">{cursor.name}<ExtraButton icon="pencil" tooltip="Edit remote cursor" onClick={() => new RemoteCursorNameModal(plugin.app, plugin, vault, reload, cursor).open()}/></span>} desc={cursor.mcpUrl} control={<>
        <button onClick={() => void copyText(cursor.mcpUrl, `${PLUGIN_NAME}: MCP URL copied.`)}>Copy MCP URL</button>
        <button onClick={() => void runNotice(undefined, async () => {
            if (!confirm(`Regenerate the secret token for "${cursor.name}"? The previous token will stop working.`)) return
            const result = await plugin.auth.regenerateCursorToken(vault.id, cursor.id)
            await copyText(result.secretToken, `${PLUGIN_NAME}: new secret token copied.`)
        })}>Regen API Secret</button>
        <ExtraButton className="realtime-danger-icon" icon="trash-2" tooltip="Remove remote cursor" onClick={() => void runNotice(undefined, async () => {
            if (!confirm(`Remove remote cursor "${cursor.name}"?`)) return
            await plugin.auth.deleteCursor(vault.id, cursor.id)
            new Notice(`${PLUGIN_NAME}: remote cursor removed.`)
            reload()
        })}/>
    </>}/>
}

class RemoteCursorNameModal extends Modal {
    private plugin: RealtimePlugin
    private vault: VaultInfo
    private refresh: () => void
    private cursor?: RemoteCursorInfo
    private root: Root | null = null

    constructor(app: App, plugin: RealtimePlugin, vault: VaultInfo, refresh: () => void, cursor?: RemoteCursorInfo) {
        super(app)
        this.plugin = plugin
        this.vault = vault
        this.refresh = refresh
        this.cursor = cursor
    }

    onOpen(): void {
        this.root = createRoot(this.contentEl)
        this.root.render(<RemoteCursorNameView plugin={this.plugin} vault={this.vault} cursor={this.cursor}
                                               refresh={this.refresh} close={() => this.close()}/>)
    }

    onClose(): void {
        this.root?.unmount()
        this.root = null
        this.contentEl.empty()
    }
}

function RemoteCursorNameView({ plugin, vault, cursor, refresh, close }: {
    plugin: RealtimePlugin;
    vault: VaultInfo;
    cursor?: RemoteCursorInfo;
    refresh: () => void;
    close: () => void;
}) {
    const [name, setName] = useState(cursor?.name ?? '')
    const [secretToken, setSecretToken] = useState('')
    const [createdCursor, setCreatedCursor] = useState<RemoteCursorInfo | null>(null)
    const [busy, setBusy] = useState(false)
    const renameMode = !!cursor
    return <>
        <h3>{renameMode ? 'Rename Remote Cursor' : 'Add Remote Cursor'}</h3>
        <p className="setting-item-description">{renameMode ? 'Update the display name for this remote cursor.' : 'Name this remote cursor. MCP servers use the MCP URL for OIDC OAuth. Direct API requests use the secret token as a Bearer token.'}</p>
        <input className="realtime-modal-input" type="text" value={name}
               onChange={(event) => setName(event.currentTarget.value)}/>
        {secretToken ? <div className="realtime-warning-box">
            <strong>Copy this secret token now.</strong>
            <p>It will not be shown again. Use it as an API Bearer token. Regenerating later invalidates this token.</p>
            {createdCursor ? <p>MCP URL: <code>{createdCursor.mcpUrl}</code></p> : null}
            <div className="realtime-actions"><code>{secretToken}</code><button onClick={() => void copyText(secretToken, `${PLUGIN_NAME}: secret token copied.`)}>Copy</button></div>
        </div> : null}
        <div className="realtime-actions">
            <button onClick={close}>{secretToken ? 'Close' : 'Cancel'}</button>
            {!secretToken ? <button className="mod-cta" disabled={busy || !name.trim()} onClick={() => void runNotice(setBusy, async () => {
                if (cursor) {
                    await plugin.auth.renameCursor(vault.id, cursor.id, name.trim())
                    new Notice(`${PLUGIN_NAME}: remote cursor renamed.`)
                    refresh()
                    close()
                } else {
                    const created = await plugin.auth.createCursor(vault.id, name.trim())
                    setCreatedCursor(created)
                    setSecretToken(created.secretToken)
                    await copyText(created.secretToken, `${PLUGIN_NAME}: secret token copied.`)
                    refresh()
                }
            })}>{renameMode ? 'Rename' : 'Create'}</button> : null}
        </div>
    </>
}

/** A glob row with a stable id so React keys survive add/remove reordering. */
interface GlobRow {
    id: number;
    value: string;
}

let nextGlobRowId = 1

/**
 * Self-contained `.obsidian` sync controls. Uses local state for the enabled
 * flag and the glob rows so toggling never re-renders (and scroll-resets) the
 * whole settings page. Rows use plain React buttons — not imperatively-mounted
 * Obsidian components — so React fully owns the dynamic list and reconciliation
 * can't hit a stale `removeChild`.
 */
function ConfigSyncSection({ plugin }: { plugin: RealtimePlugin }) {
    const [enabled, setEnabled] = useState(plugin.settings.syncConfigEnabled)
    const [rows, setRows] = useState<GlobRow[]>(() =>
        plugin.settings.configIncludeGlobs.map((value) => ({ id: nextGlobRowId++, value })))

    const persist = async (next: GlobRow[]) => {
        plugin.settings.configIncludeGlobs = next.map((row) => row.value.trim()).filter(Boolean)
        await plugin.saveSettings()
        await plugin.reloadSync()
    }

    return <>
        <SettingRow name="Sync `.obsidian` files"
                    desc="Opt in per device. Matched files under your Obsidian config folder sync as binary attachments. Expect slight issues. Must be configured per-device. "
                    control={<Toggle value={enabled}
                                     onChange={(value) => void runNotice(undefined, async () => {
                                         setEnabled(value)
                                         plugin.settings.syncConfigEnabled = value
                                         await plugin.saveSettings()
                                         await plugin.reloadSync()
                                     })}/>}/>
        {enabled ? <SettingRow name="Config include globs"
                    desc="Matched relative to your config folder, e.g. snippets/*.css or hotkeys.json. Uses picomatch. The Realtime plugin folder and all node_modules folders are hard excluded."
                    control={<div className="realtime-choice-list">
                        {rows.map((row) => <div className="realtime-actions" key={row.id}>
                            <input className="realtime-modal-input" type="text" value={row.value}
                                   placeholder="snippets/*.css"
                                   onChange={(event) => {
                                       const value = event.currentTarget.value
                                       setRows((current) => current.map((r) => r.id === row.id ? { ...r, value } : r))
                                   }}
                                   onBlur={() => void persist(rows)}/>
                            <button className="mod-warning" onClick={() => {
                                const next = rows.filter((r) => r.id !== row.id)
                                setRows(next)
                                void persist(next)
                            }}>Remove</button>
                        </div>)}
                        <button onClick={() => setRows((current) => [...current, { id: nextGlobRowId++, value: '' }])}>Add glob</button>
                    </div>}/> : null}
    </>
}

function AdvancedSettings({ app, plugin, refresh }: { app: App; plugin: RealtimePlugin; refresh: () => void }) {
    return <details className="realtime-advanced">
        <summary>Advanced settings</summary>
        <ConfigSyncSection plugin={plugin}/>
        <SettingRow name="Diagnostic logging"
                    desc="Write verbose Realtime diagnostics to the developer console. Keep this off unless troubleshooting."
                    control={<Toggle value={plugin.settings.diagnosticLogging}
                                     onChange={(value) => void runNotice(undefined, async () => {
                                         plugin.settings.diagnosticLogging = value
                                         await plugin.saveSettings()
                                         plugin.applyDiagnosticLoggingSetting()
                                         refresh()
                                     })}/>}/>
        <p className="setting-item-description">Changing the Realtime server URL should usually only be done when
            resetting or migrating the entire vault.</p><SettingRow name="Realtime server URL"
                                                                    desc={plugin.settings.authServerUrl}
                                                                    control={<button
                                                                        onClick={() => new ServerMigrationModal(app, plugin, refresh).open()}>Change
                                                                        server...</button>}/></details>
}

class ServerMigrationModal extends Modal {
    private plugin: RealtimePlugin
    private refresh: () => void
    private root: Root | null = null

    constructor(app: App, plugin: RealtimePlugin, refresh: () => void) {
        super(app)
        this.plugin = plugin
        this.refresh = refresh
    }

    onOpen(): void {
        this.root = createRoot(this.contentEl)
        this.root.render(<ServerMigrationView app={this.app} plugin={this.plugin} refresh={this.refresh}
                                              close={() => this.close()}/>)
    }

    onClose(): void {
        this.root?.unmount()
        this.root = null
        this.contentEl.empty()
    }
}

function ServerMigrationView({ app, plugin, refresh, close }: {
    app: App;
    plugin: RealtimePlugin;
    refresh: () => void;
    close: () => void
}) {
    const [url, setUrl] = useState(plugin.settings.authServerUrl)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState('')
    const showPaste = useDelayedFlag(busy, 2000)
    return (
        <>
            <h3>Change Realtime Server</h3>
            <p className="setting-item-description">This requires SSO on the new server. The change is only saved if
                that server has a remote vault named "{app.vault.getName()}".</p>
            <input className="realtime-modal-input" type="text" value={url}
                   onChange={(event) => setUrl(event.currentTarget.value)}/>
            {error ? <p className="realtime-error">{error}</p> : null}
            <SsoPasteFallback plugin={plugin} visible={showPaste}/>
            <div className="realtime-actions">
                <button onClick={close}>Cancel</button>
                <button className="mod-cta" disabled={busy} onClick={() => void (async () => {
                    setBusy(true)
                    setError('')
                    try {
                        const normalized = normalizeServerUrl(url)
                        const { token, me } = await plugin.auth.authenticateAt(normalized)
                        const vaults = await plugin.auth.listVaultsAt(normalized, token)
                        const match = vaults.find((vault) => vault.name === app.vault.getName())
                        if (!match) throw new Error(`No remote vault named "${app.vault.getName()}" was found on that server.`)
                        plugin.settings.activeVaultId = match.id
                        await plugin.auth.setSessionForServer(normalized, token, me)
                        await plugin.saveSettings()
                        await plugin.reloadSync()
                        new Notice(`${PLUGIN_NAME}: server updated.`)
                        close()
                        refresh()
                    } catch (e) {
                        setError((e as Error).message)
                    } finally {
                        setBusy(false)
                    }
                })()}>{busy ? 'Waiting for SSO...' : 'Test with SSO'}</button>
            </div>
        </>
    )
}

function useVaults(plugin: RealtimePlugin) {
    const [reloadKey, setReloadKey] = useState(0)
    const [vaults, setVaults] = useState<VaultInfo[] | null>(null)
    const [error, setError] = useState('')
    useEffect(() => {
        let cancelled = false
        setVaults(null)
        setError('')
        void (async () => {
            try {
                const listed = await plugin.auth.listVaults()
                if (!cancelled) setVaults(listed)
            } catch (e) {
                if (!cancelled) setError(`Could not load vaults: ${(e as Error).message}`)
            }
        })()
        return () => {
            cancelled = true
        }
    }, [plugin, reloadKey])
    return { vaults, error, reload: () => setReloadKey((key) => key + 1) }
}

function useMembers(plugin: RealtimePlugin, vaultId: string) {
    const [reloadKey, setReloadKey] = useState(0)
    const [members, setMembers] = useState<MemberInfo[] | null>(null)
    const [error, setError] = useState('')
    useEffect(() => {
        if (!vaultId) return
        let cancelled = false
        setMembers(null)
        setError('')
        void (async () => {
            try {
                const listed = await plugin.auth.listMembers(vaultId)
                if (!cancelled) setMembers(listed)
            } catch (e) {
                if (!cancelled) setError(`Could not load members: ${(e as Error).message}`)
            }
        })()
        return () => {
            cancelled = true
        }
    }, [plugin, vaultId, reloadKey])
    return { members, error, reload: () => setReloadKey((key) => key + 1) }
}

function useRemoteCursors(plugin: RealtimePlugin, vaultId: string) {
    const [reloadKey, setReloadKey] = useState(0)
    const [cursors, setCursors] = useState<RemoteCursorInfo[] | null>(null)
    const [error, setError] = useState('')
    useEffect(() => {
        if (!vaultId) return
        let cancelled = false
        setCursors(null)
        setError('')
        void (async () => {
            try {
                const listed = await plugin.auth.listCursors(vaultId)
                if (!cancelled) setCursors(listed)
            } catch (e) {
                if (!cancelled) setError(`Could not load remote cursors: ${(e as Error).message}`)
            }
        })()
        return () => {
            cancelled = true
        }
    }, [plugin, vaultId, reloadKey])
    return { cursors, error, reload: () => setReloadKey((key) => key + 1) }
}

/** Becomes true `delayMs` after `active` turns true; resets when it turns false. */
function useDelayedFlag(active: boolean, delayMs: number): boolean {
    const [on, setOn] = useState(false)
    useEffect(() => {
        if (!active) {
            setOn(false)
            return
        }
        const id = window.setTimeout(() => setOn(true), delayMs)
        return () => window.clearTimeout(id)
    }, [active, delayMs])
    return on
}

/**
 * Backup for SSO when the `obsidian://` deep link doesn't return to Obsidian:
 * the login page also prints the session code, which the user can paste here to
 * complete the in-flight login.
 */
function SsoPasteFallback({ plugin, visible }: { plugin: RealtimePlugin; visible: boolean }) {
    const [code, setCode] = useState('')
    if (!visible) return null
    return (
        <div className="realtime-paste-fallback">
            <p className="setting-item-description">Not redirected back to Obsidian? Paste the sign-in code shown in
                your browser:</p>
            <div className="realtime-actions">
                <input className="realtime-modal-input" type="text" placeholder="Paste sign-in code" value={code}
                       onChange={(event) => setCode(event.currentTarget.value.trim())}/>
                <button type="button" className="mod-cta" disabled={!code}
                        onClick={() => plugin.auth.submitPastedCode(code)}>Use code
                </button>
            </div>
        </div>
    )
}

async function runNotice(setBusy: ((busy: boolean) => void) | undefined, fn: () => Promise<void>): Promise<void> {
    try {
        setBusy?.(true)
        await fn()
    } catch (e) {
        new Notice(`${PLUGIN_NAME}: ${(e as Error).message}`)
    } finally {
        setBusy?.(false)
    }
}

async function copyText(text: string, message: string): Promise<void> {
    await navigator.clipboard?.writeText(text)
    new Notice(message)
}

function SettingRow({ name, desc, control }: { name: ReactNode; desc?: ReactNode; control: ReactNode }) {
    return <div className="setting-item">
        <div className="setting-item-info">
            <div className="setting-item-name">{name}</div>
            {desc ? <div className="setting-item-description">{desc}</div> : null}</div>
        <div className="setting-item-control">{control}</div>
    </div>
}
