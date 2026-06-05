// Spawns the InstaSync auth server (Rust) in mock-OIDC mode plus a y-sweet
// server started with the matching --auth key, for Tier-2 / Tier-3 tests.
//
// The Rust binary is built once (cargo build) and then run as a child process.

import { spawn, execFileSync, type ChildProcess } from "child_process";
import * as http from "http";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";
import { startYSweetServer, genAuthKey, type YSweetServer } from "./ysweetServer.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");

// ---------- standalone API helpers (pure functions of the auth URL) ----------

/** Raw GET that does NOT follow redirects, so we can read the Location header. */
function rawGet(url: string): Promise<{ status: number; location?: string }> {
	return new Promise((resolve, reject) => {
		const req = http.get(url, (res) => {
			res.resume(); // drain
			resolve({ status: res.statusCode ?? 0, location: res.headers.location });
		});
		req.on("error", reject);
	});
}

/** Drive the mock OIDC flow and return a session bearer token for `sub`. */
export async function mockLogin(authUrl: string, sub: string): Promise<string> {
	const start = await rawGet(
		`${authUrl}/auth/login?redirect=http://app/cb&mock_sub=${sub}&mock_name=${sub}`,
	);
	const state = new URL(`http://x${start.location}`).searchParams.get("state");
	const done = await rawGet(`${authUrl}/auth/callback?state=${state}`);
	const token = new URL(done.location!, authUrl).searchParams.get("token");
	if (!token) throw new Error("mock login did not return a token");
	return token;
}

async function apiPost<T>(authUrl: string, token: string, pathName: string, body: unknown): Promise<T> {
	const res = await fetch(`${authUrl}${pathName}`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
		body: JSON.stringify(body),
	});
	if (!res.ok) throw new Error(`${pathName} -> HTTP ${res.status}`);
	return (await res.json()) as T;
}

export const apiCreateVault = (authUrl: string, token: string, name: string) =>
	apiPost<{ id: string; name: string }>(authUrl, token, "/api/vaults", { name });

export const apiCreateInvite = async (authUrl: string, token: string, vaultId: string) =>
	(await apiPost<{ code: string }>(authUrl, token, `/api/vaults/${vaultId}/invites`, {})).code;

export const apiRedeemInvite = (authUrl: string, token: string, code: string) =>
	apiPost<{ vaultId: string; name: string }>(authUrl, token, "/api/invites/redeem", { code });

export async function apiGet<T>(authUrl: string, token: string, pathName: string): Promise<T> {
	const res = await fetch(`${authUrl}${pathName}`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	if (!res.ok) throw new Error(`${pathName} -> HTTP ${res.status}`);
	return (await res.json()) as T;
}

export async function apiDelete(authUrl: string, token: string, pathName: string): Promise<number> {
	const res = await fetch(`${authUrl}${pathName}`, {
		method: "DELETE",
		headers: { Authorization: `Bearer ${token}` },
	});
	return res.status;
}

export const apiPromoteMember = (authUrl: string, token: string, vaultId: string, userId: string) =>
	apiPost(authUrl, token, `/api/vaults/${vaultId}/members/${userId}/promote`, {});

export const apiRemoveMember = (authUrl: string, token: string, vaultId: string, userId: string) =>
	apiDelete(authUrl, token, `/api/vaults/${vaultId}/members/${userId}`);

// ---------- server process ----------

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = net.createServer();
		srv.once("error", reject);
		srv.listen(0, "127.0.0.1", () => {
			const port = (srv.address() as net.AddressInfo).port;
			srv.close(() => resolve(port));
		});
	});
}

function serverBinary(): string {
	const exe = process.platform === "win32" ? ".exe" : "";
	return path.join(repoRoot, "server", "target", "debug", `instasync-server${exe}`);
}

let built = false;
function buildServerOnce(): void {
	if (built) return;
	execFileSync("cargo", ["build", "--manifest-path", path.join(repoRoot, "server", "Cargo.toml")], {
		stdio: "inherit",
	});
	built = true;
}

export interface AuthServer {
	url: string;
	stop: () => Promise<void>;
}

/** Spawn the auth server against an existing y-sweet, sharing `authKey`. */
export async function startAuthServer(opts: {
	port?: number;
	ysweetUrl: string;
	authKey: string;
}): Promise<AuthServer> {
	buildServerOnce();

	const port = opts.port ?? (await freePort());
	const url = `http://127.0.0.1:${port}`;
	const dbPath = path.join(os.tmpdir(), `instasync-test-${Date.now()}-${port}.db`);
	const blobDir = path.join(os.tmpdir(), `instasync-blobs-${Date.now()}-${port}`);

	const child: ChildProcess = spawn(serverBinary(), [], {
		stdio: ["ignore", "pipe", "pipe"],
		env: {
			...process.env,
			DATABASE_URL: `sqlite://${dbPath.replace(/\\/g, "/")}?mode=rwc`,
			BLOB_DIR: blobDir,
			BIND_ADDR: `127.0.0.1:${port}`,
			PUBLIC_BASE_URL: url,
			YSWEET_URL: opts.ysweetUrl,
			YSWEET_PUBLIC_URL: opts.ysweetUrl,
			YSWEET_AUTH_KEY: opts.authKey,
			OIDC_MODE: "mock",
			ALLOW_MOCK_OIDC: "1",
			ALLOWED_LOGIN_REDIRECTS: "http://app",
			// The readiness probe waits for the "listening on" info log.
			RUST_LOG: "instasync_server=info,warn",
		},
	});

	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error("auth server did not become ready in 30s")),
			30_000,
		);
		const onChunk = (buf: Buffer) => {
			if (buf.toString().includes("listening on")) {
				clearTimeout(timer);
				detach();
				resolve();
			}
		};
		const onExit = (code: number | null) => {
			clearTimeout(timer);
			detach();
			reject(new Error(`auth server exited before ready (code ${code})`));
		};
		const detach = () => {
			child.stdout?.off("data", onChunk);
			child.stderr?.off("data", onChunk);
			child.off("exit", onExit);
		};
		child.stdout?.on("data", onChunk);
		child.stderr?.on("data", onChunk);
		child.on("exit", onExit);
	});

	return {
		url,
		stop: () =>
			new Promise<void>((resolve) => {
				if (child.exitCode !== null) return resolve();
				child.once("exit", () => resolve());
				child.kill("SIGTERM");
				setTimeout(() => {
					try {
						child.kill("SIGKILL");
					} catch {
						/* gone */
					}
					resolve();
				}, 3000);
			}),
	};
}

// ---------- bundled harness (y-sweet + auth server), for Tier-2 ----------

export interface AuthHarness {
	authUrl: string;
	ysweet: YSweetServer;
	stop: () => Promise<void>;
	loginUser: (sub: string) => Promise<string>;
	createVault: (token: string, name: string) => Promise<{ id: string; name: string }>;
	createInvite: (token: string, vaultId: string) => Promise<string>;
	redeemInvite: (token: string, code: string) => Promise<{ vaultId: string; name: string }>;
}

export async function startAuthHarness(): Promise<AuthHarness> {
	const authKey = await genAuthKey();
	const ysweet = await startYSweetServer(undefined, authKey);
	const server = await startAuthServer({ ysweetUrl: ysweet.url, authKey });
	const authUrl = server.url;

	return {
		authUrl,
		ysweet,
		loginUser: (sub) => mockLogin(authUrl, sub),
		createVault: (token, name) => apiCreateVault(authUrl, token, name),
		createInvite: (token, vaultId) => apiCreateInvite(authUrl, token, vaultId),
		redeemInvite: (token, code) => apiRedeemInvite(authUrl, token, code),
		stop: async () => {
			await server.stop();
			await ysweet.stop();
		},
	};
}
