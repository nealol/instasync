// Spawns a throwaway y-sweet dev server (optionally with a filesystem store,
// otherwise in-memory) for integration tests, and resolves once it is accepting
// connections.
//
// We resolve the binary through y-sweet's own downloader (`y-sweet/src/get-binary`)
// rather than `npx`, because the npm launcher writes the Windows binary to a file
// without a `.exe` extension and then silently fails to exec it. We copy it to a
// runnable name and spawn it directly. Override with YSWEET_BIN if needed.

import { spawn, type ChildProcess } from "child_process";
import { createRequire } from "module";
import * as net from "net";
import * as fs from "fs";

const require = createRequire(import.meta.url);

export interface YSweetServer {
	url: string;
	/** Filesystem path passed as `--storage`, or undefined if using the in-memory store. */
	storageDir?: string;
	stop: () => Promise<void>;
}

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

/** Resolve a directly-spawnable y-sweet binary path (download + .exe fixup). */
export async function resolveBinary(): Promise<string> {
	if (process.env.YSWEET_BIN) return process.env.YSWEET_BIN;

	const { getBinary } = require("y-sweet/src/get-binary");
	const binpath: string = await getBinary(); // downloads on first use

	if (process.platform === "win32" && !binpath.toLowerCase().endsWith(".exe")) {
		const exePath = binpath + ".exe";
		if (!fs.existsSync(exePath)) fs.copyFileSync(binpath, exePath);
		return exePath;
	}
	return binpath;
}

/** Generate a y-sweet private key via `y-sweet gen-auth --json`. */
export async function genAuthKey(): Promise<string> {
	const bin = await resolveBinary();
	const { execFileSync } = require("child_process");
	const out = execFileSync(bin, ["gen-auth", "--json"], { encoding: "utf8" });
	return JSON.parse(out).private_key as string;
}

export async function startYSweetServer(
	fixedPort?: number,
	authKey?: string,
	/** When provided y-sweet is started with `--storage <dir>` (filesystem store). */
	storageDir?: string,
): Promise<YSweetServer> {
	const bin = await resolveBinary();

	// freePort() releases the port before y-sweet binds it, so a parallel test
	// process can steal it in the gap; retry on a fresh port when that happens.
	const maxAttempts = fixedPort ? 1 : 3;
	let port = 0;
	let child: ChildProcess | undefined;
	let lastError: Error | undefined;

	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		port = fixedPort ?? (await freePort());
		const args = storageDir
			? ["serve", storageDir, "--port", String(port)]
			: ["serve", "--port", String(port)];
		if (authKey) args.push("--auth", authKey);
		child = spawn(bin, args, {
			stdio: ["ignore", "pipe", "pipe"],
		});

		try {
			await waitForReady(child);
			lastError = undefined;
			break;
		} catch (err) {
			lastError = err as Error;
			child.kill("SIGKILL");
		}
	}
	if (lastError || !child) throw lastError ?? new Error("y-sweet failed to start");

	return makeHandle(child, port, storageDir);
}

function waitForReady(child: ChildProcess): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		let output = "";
		const timer = setTimeout(
			() => reject(new Error(`y-sweet server did not become ready in 60s\n${output}`)),
			60_000,
		);
		const onChunk = (buf: Buffer) => {
			output += buf.toString();
			if (output.includes("Listening on")) {
				clearTimeout(timer);
				detach();
				resolve();
			}
		};
		const onExit = (code: number | null) => {
			clearTimeout(timer);
			detach();
			reject(new Error(`y-sweet exited before becoming ready (code ${code})\n${output}`));
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
}

function makeHandle(child: ChildProcess, port: number, storageDir?: string): YSweetServer {
	return {
		url: `http://127.0.0.1:${port}`,
		storageDir,
		stop: () =>
			new Promise<void>((resolve) => {
				if (child.exitCode !== null) return resolve();
				child.once("exit", () => resolve());
				child.kill("SIGTERM");
				setTimeout(() => {
					try {
						child.kill("SIGKILL");
					} catch {
						/* already gone */
					}
					resolve();
				}, 3000);
			}),
	};
}
