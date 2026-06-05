// Spawns a throwaway y-sweet dev server (in-memory store, random free port) for
// integration tests, and resolves once it is accepting connections.
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
): Promise<YSweetServer> {
	const [port, bin] = await Promise.all([
		fixedPort ? Promise.resolve(fixedPort) : freePort(),
		resolveBinary(),
	]);

	const args = ["serve", "--port", String(port)];
	if (authKey) args.push("--auth", authKey);
	const child: ChildProcess = spawn(bin, args, {
		stdio: ["ignore", "pipe", "pipe"],
	});

	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error("y-sweet server did not become ready in 60s")),
			60_000,
		);
		const onChunk = (buf: Buffer) => {
			if (buf.toString().includes("Listening on")) {
				clearTimeout(timer);
				detach();
				resolve();
			}
		};
		const onExit = (code: number | null) => {
			clearTimeout(timer);
			detach();
			reject(new Error(`y-sweet exited before becoming ready (code ${code})`));
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
		url: `http://127.0.0.1:${port}`,
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
