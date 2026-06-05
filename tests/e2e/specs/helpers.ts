// Helpers for driving the two Obsidian instances. `executeObsidian` runs a
// function inside the renderer with the Obsidian `app` available.

/* eslint-disable @typescript-eslint/no-explicit-any */

import { mockLogin, apiCreateInvite } from "../../support/authServer.js";

// --- InstaSync auth / vault onboarding (Tier-3) ----------------------------

/**
 * Sign a device in: mint a mock-OIDC session (Node side) for a distinct user,
 * then inject the auth URL + session into that device's plugin. Returns the
 * session token so the caller can drive admin API calls (e.g. invites).
 */
export async function signInDevice(b: any, authUrl: string, sub: string): Promise<string> {
	const token = await mockLogin(authUrl, sub);
	await b.executeObsidian(
		async ({ app }: any, url: string, tok: string) => {
			const p = (app as any).plugins.plugins.instasync;
			p.settings.authServerUrl = url;
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
		const p = (app as any).plugins.plugins.instasync;
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
		const p = (app as any).plugins.plugins.instasync;
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

/** Returns "ok" if the device can mint a token for the vault, else "refused". */
export async function docTokenStatus(b: any, vaultId: string): Promise<string> {
	return b.executeObsidian(async ({ app }: any, vid: string) => {
		try {
			await (app as any).plugins.plugins.instasync.auth.docToken(vid, vid);
			return "ok";
		} catch {
			return "refused";
		}
	}, vaultId);
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
		if (on) await app.plugins.enablePlugin("instasync");
		else await app.plugins.disablePlugin("instasync");
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

/** Reads the InstaSync status-bar text from the renderer. */
export async function statusText(b: any): Promise<string> {
	return b.executeObsidian(() => {
		const el = Array.from(document.querySelectorAll(".status-bar-item")).find((e) =>
			(e.textContent ?? "").includes("InstaSync"),
		);
		return el?.textContent ?? "";
	});
}
