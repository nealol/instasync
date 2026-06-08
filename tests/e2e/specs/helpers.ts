// Helpers for driving the two Obsidian instances. `executeObsidian` runs a
// function inside the renderer with the Obsidian `app` available.

/* eslint-disable @typescript-eslint/no-explicit-any */

import { mockLogin, apiCreateInvite } from "../../support/authServer.js";

// --- Realtime auth / vault onboarding (Tier-3) ----------------------------

/**
 * Sign a device in: mint a mock-OIDC session (Node side) for a distinct user,
 * then inject the auth URL + session into that device's plugin. Returns the
 * session token so the caller can drive admin API calls (e.g. invites).
 */
export async function signInDevice(b: any, authUrl: string, sub: string): Promise<string> {
	const token = await mockLogin(authUrl, sub);
	await b.executeObsidian(
		async ({ app }: any, url: string, tok: string) => {
			const p = (app as any).plugins.plugins.realtime;
			p.settings.authServerUrl = url;
			p.settings.enabled = true;
			await p.auth.setSession(tok);
		},
		authUrl,
		token,
	);
	return token;
}

/** Create a vault from the device's local files and start syncing it. */
export async function createVaultFromLocal(b: any, name: string): Promise<string> {
	return b.executeObsidian(async ({ app }: any, n: string) => {
		const p = (app as any).plugins.plugins.realtime;
		await p.createAndActivateVault(n);
		return p.settings.activeVaultId as string;
	}, name);
}

/** Generate a single-use invite for a vault (admin, Node side). */
export function generateInvite(authUrl: string, adminToken: string, vaultId: string): Promise<string> {
	return apiCreateInvite(authUrl, adminToken, vaultId);
}

/**
 * Redeem an invite on a device and adopt that vault locally: erases local
 * Markdown, binds the vault, and reloads sync (mirrors plugin.adoptVault without
 * the confirm modal, which is impractical to drive headless).
 */
export async function redeemAndAdopt(b: any, code: string): Promise<string> {
	return b.executeObsidian(async ({ app }: any, c: string) => {
		const p = (app as any).plugins.plugins.realtime;
		const { vaultId } = await p.auth.redeemInvite(c);
		for (const f of app.vault.getMarkdownFiles()) {
			try {
				await app.vault.delete(f);
			} catch {
				/* ignore */
			}
		}
		p.settings.activeVaultId = vaultId;
		await p.saveSettings();
		await p.reloadSync();
		return vaultId as string;
	}, code);
}

/** Redeem an invite but leave the local vault bound to its current remote. */
export async function redeemInviteOnly(b: any, code: string): Promise<{ vaultId: string; activeVaultId: string }> {
	return b.executeObsidian(async ({ app }: any, c: string) => {
		const p = (app as any).plugins.plugins.realtime;
		const { vaultId } = await p.auth.redeemInvite(c);
		return { vaultId, activeVaultId: p.settings.activeVaultId as string };
	}, code);
}

export async function activeVaultId(b: any): Promise<string> {
	return b.executeObsidian(async ({ app }: any) => {
		return (app as any).plugins.plugins.realtime.settings.activeVaultId as string;
	});
}

export async function listedVaultIds(b: any): Promise<string[]> {
	return b.executeObsidian(async ({ app }: any) => {
		return ((await (app as any).plugins.plugins.realtime.auth.listVaults()) as { id: string }[]).map((v) => v.id);
	});
}

export async function setSyncPaused(b: any, paused: boolean): Promise<void> {
	await b.executeObsidian(async ({ app }: any, p: boolean) => {
		const plugin = (app as any).plugins.plugins.realtime;
		plugin.settings.enabled = !p;
		await plugin.saveSettings();
		await plugin.reloadSync();
	}, paused);
}

/** Returns "ok" if the device can mint a token for the vault, else "refused". */
export async function docTokenStatus(b: any, vaultId: string): Promise<string> {
	return b.executeObsidian(async ({ app }: any, vid: string) => {
		try {
			await (app as any).plugins.plugins.realtime.auth.docToken(vid, vid);
			return "ok";
		} catch {
			return "refused";
		}
	}, vaultId);
}

// --- Live editing (real CM6 editor) ----------------------------------------
//
// The plain vault.modify/read helpers never open a file in an editor, so they
// can't catch the class of bug where editing an *open* note corrupts content
// (Obsidian's "modified externally and changes have been merged in" 3-way merge
// duplicating characters). These helpers drive the actual Obsidian editor.

/** Open a note in an editing (source/live-preview) leaf and make it active. */
export async function openNoteInEditor(b: any, path: string): Promise<void> {
	await b.executeObsidian(async ({ app }: any, p: string) => {
		const f = app.vault.getAbstractFileByPath(p);
		const leaf = app.workspace.getLeaf(true);
		await leaf.openFile(f, { active: true, state: { mode: "source" } });
		app.workspace.setActiveLeaf(leaf, { focus: true });
	}, path);
}

/** Type text into the open editor for `path`, one char per CM transaction. */
export async function typeInEditor(b: any, path: string, text: string): Promise<void> {
	await b.executeObsidian(
		async ({ app }: any, p: string, t: string) => {
			const leaf = app.workspace
				.getLeavesOfType("markdown")
				.find((l: any) => l.view?.file?.path === p);
			const editor = leaf?.view?.editor;
			if (!editor) throw new Error("no open editor for " + p);
			const last = editor.lastLine();
			editor.setCursor({ line: last, ch: editor.getLine(last).length });
			// Insert character by character so each is its own CM transaction —
			// this is what a real keystroke stream looks like to LiveEdit.update().
			for (const ch of t) editor.replaceSelection(ch);
		},
		path,
		text,
	);
}

/** Read the live editor buffer (not disk) for an open note. */
export async function editorText(b: any, path: string): Promise<string | null> {
	return b.executeObsidian(async ({ app }: any, p: string) => {
		const leaf = app.workspace
			.getLeavesOfType("markdown")
			.find((l: any) => l.view?.file?.path === p);
		return leaf?.view?.editor ? (leaf.view.editor.getValue() as string) : null;
	}, path);
}

/**
 * Toggle Live Preview ↔ raw Source on the active editor. This reconfigures the
 * CM6 editor and destroys+recreates its view plugins (including LiveEdit) while
 * the file stays open — the exact teardown that used to flush stale Y.Text to a
 * disk that lagged the editor, triggering Obsidian's external-merge duplication.
 */
export async function toggleSourceMode(b: any): Promise<void> {
	await b.executeObsidian(async ({ app }: any) => {
		(app as any).commands.executeCommandById("editor:toggle-source");
	});
}

/** Close every open markdown editor (test isolation). */
export async function closeAllEditors(b: any): Promise<void> {
	await b.executeObsidian(async ({ app }: any) => {
		app.workspace.detachLeavesOfType("markdown");
	});
}

// --- Structured files (canvas / base live bindings) ------------------------
//
// Canvas and Base files sync through a CRDT, but when the file is *open* the
// disk write-through is suppressed in favor of a live binding (CanvasBinding /
// BaseBinding). The plain read/write helpers only exercise the disk path; these
// drive the actual open views so the bindings are under test.

/**
 * Enable an Obsidian core plugin (e.g. "canvas", "bases"). Returns true if the
 * plugin is enabled afterwards — false means this Obsidian build doesn't ship it
 * (older versions predate Bases), so the caller can skip the dependent tests.
 */
export async function enableCorePlugin(b: any, id: string): Promise<boolean> {
	return b.executeObsidian(async ({ app }: any, pid: string) => {
		const ip = (app as any).internalPlugins;
		const plugin = ip.getPluginById ? ip.getPluginById(pid) : ip.plugins?.[pid];
		if (!plugin) return false;
		if (!plugin.enabled) {
			try {
				if (ip.enablePluginAndSave) await ip.enablePluginAndSave(pid);
				else if (plugin.enable) await plugin.enable();
			} catch {
				return false;
			}
		}
		return !!plugin.enabled;
	}, id);
}

/** Open a file in its native view (canvas/base) in a new active leaf. */
export async function openFileInLeaf(b: any, path: string): Promise<void> {
	await b.executeObsidian(async ({ app }: any, p: string) => {
		const f = app.vault.getAbstractFileByPath(p);
		const leaf = app.workspace.getLeaf(true);
		await leaf.openFile(f, { active: true });
		app.workspace.setActiveLeaf(leaf, { focus: true });
	}, path);
}

/** Force the plugin to (re)bind live canvas/base views to their documents. */
export async function bindOpenStructured(b: any): Promise<void> {
	await b.executeObsidian(async ({ app }: any) => {
		const vs = (app as any).plugins.plugins.realtime.vaultSync;
		vs?.bindOpenCanvases?.();
		vs?.bindOpenBases?.();
	});
}

/** Detach all leaves of a given view type (e.g. "canvas", "bases"). */
export async function detachLeaves(b: any, viewType: string): Promise<void> {
	await b.executeObsidian(async ({ app }: any, vt: string) => {
		app.workspace.detachLeavesOfType(vt);
	}, viewType);
}

/** Read the live canvas view's data object for an open canvas, or null. */
export async function canvasViewData(b: any, path: string): Promise<any | null> {
	return b.executeObsidian(async ({ app }: any, p: string) => {
		let result: any = null;
		app.workspace.iterateAllLeaves((leaf: any) => {
			const v = leaf?.view;
			if (v?.getViewType?.() === "canvas" && v?.file?.path === p && v.canvas?.getData) {
				result = v.canvas.getData();
			}
		});
		return result;
	}, path);
}

/** Apply data to the live canvas view and save it — simulates a user edit. */
export async function editCanvasView(b: any, path: string, data: any): Promise<void> {
	await b.executeObsidian(async ({ app }: any, p: string, d: any) => {
		let done = false;
		app.workspace.iterateAllLeaves((leaf: any) => {
			const v = leaf?.view;
			if (!done && v?.getViewType?.() === "canvas" && v?.file?.path === p && v.canvas?.importData) {
				v.canvas.importData(d);
				v.canvas.requestSave();
				done = true;
			}
		});
		if (!done) throw new Error("no open canvas view for " + p);
	}, path, data);
}

/** Read the live base view's serialized data (YAML) for an open base, or null. */
export async function baseViewData(b: any, path: string): Promise<string | null> {
	return b.executeObsidian(async ({ app }: any, p: string) => {
		let result: string | null = null;
		app.workspace.iterateAllLeaves((leaf: any) => {
			const v = leaf?.view;
			if (v?.getViewType?.() === "bases" && v?.file?.path === p && typeof v.getViewData === "function") {
				result = v.getViewData();
			}
		});
		return result;
	}, path);
}

/** Load YAML into the live base view and save it — simulates a user config edit. */
export async function editBaseView(b: any, path: string, yaml: string): Promise<void> {
	await b.executeObsidian(async ({ app }: any, p: string, y: string) => {
		let done = false;
		app.workspace.iterateAllLeaves((leaf: any) => {
			const v = leaf?.view;
			if (!done && v?.getViewType?.() === "bases" && v?.file?.path === p && typeof v.setViewData === "function") {
				v.setViewData(y, false);
				v.requestSave();
				done = true;
			}
		});
		if (!done) throw new Error("no open base view for " + p);
	}, path, yaml);
}

export async function readNote(b: any, path: string): Promise<string | null> {
	return b.executeObsidian(
		async ({ app }: any, p: string) => {
			const f = app.vault.getAbstractFileByPath(p);
			return f ? await app.vault.read(f) : null;
		},
		path,
	);
}

export async function writeNote(b: any, path: string, content: string): Promise<void> {
	await b.executeObsidian(
		async ({ app }: any, p: string, c: string) => {
			const f = app.vault.getAbstractFileByPath(p);
			if (f) await app.vault.modify(f, c);
			else await app.vault.create(p, c);
		},
		path,
		content,
	);
}

export async function deleteNote(b: any, path: string): Promise<void> {
	await b.executeObsidian(async ({ app }: any, p: string) => {
		const f = app.vault.getAbstractFileByPath(p);
		if (f) await app.vault.delete(f);
	}, path);
}

export async function listMarkdown(b: any): Promise<string[]> {
	return b.executeObsidian(async ({ app }: any) =>
		app.vault.getMarkdownFiles().map((f: any) => f.path),
	);
}

export async function setPluginEnabled(b: any, enabled: boolean): Promise<void> {
	await b.executeObsidian(async ({ app }: any, on: boolean) => {
		if (on) await app.plugins.enablePlugin("realtime");
		else await app.plugins.disablePlugin("realtime");
	}, enabled);
}

// Network cut at the WebSocket layer.
//
// Chromium's CDP network emulation (setOfflineMode) does NOT intercept loopback
// (127.0.0.1) traffic, so it can't sever the y-sweet WebSocket in these tests.
// Instead we shim `window.WebSocket`: while "offline" it redirects new sockets to
// a dead port and closes live ones — a real connection failure that exercises the
// provider's own reconnect path (backoff + watchdog), isolated to this device.
//
// The shim must be installed before the sockets we want to control are created,
// so the caller reloads the plugin afterwards (its providers capture `window`'s
// WebSocket at construction).
export async function installNetworkShim(b: any, deadPort: number): Promise<void> {
	await b.executeObsidian((_ctx: any, dead: number) => {
		const w = window as any;
		if (w.__wsShimInstalled) {
			w.__deadPort = dead;
			return;
		}
		const Orig: any = w.WebSocket;
		w.__origWS = Orig;
		w.__wsSet = new Set();
		w.__netOffline = false;
		w.__deadPort = dead;
		const Shim: any = function (url: string, protocols?: any) {
			const target = w.__netOffline ? "ws://127.0.0.1:" + w.__deadPort + "/" : url;
			const sock = protocols !== undefined ? new Orig(target, protocols) : new Orig(target);
			w.__wsSet.add(sock);
			sock.addEventListener("close", () => w.__wsSet.delete(sock));
			return sock;
		};
		Shim.prototype = Orig.prototype;
		for (const k of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) Shim[k] = Orig[k];
		w.WebSocket = Shim;
		w.__wsShimInstalled = true;
	}, deadPort);
}

/** Toggle the simulated network outage for a device (requires installNetworkShim). */
export async function setNetworkOffline(b: any, offline: boolean): Promise<void> {
	await b.executeObsidian((_ctx: any, off: boolean) => {
		const w = window as any;
		w.__netOffline = off;
		if (off) {
			for (const s of [...w.__wsSet]) {
				try {
					s.close();
				} catch {
					/* ignore */
				}
			}
		}
	}, offline);
}

/** Reads the Realtime status-bar text from the renderer. */
export async function statusText(b: any): Promise<string> {
	return b.executeObsidian(() => {
		const el = Array.from(document.querySelectorAll(".status-bar-item")).find((e) =>
			(e.textContent ?? "").includes("Sync:"),
		);
		return el?.textContent ?? "";
	});
}
