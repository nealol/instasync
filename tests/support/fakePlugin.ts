// An in-memory stand-in for the slice of the Obsidian plugin/app/vault API that
// src/Document.ts and src/VaultSync.ts touch. Vault mutations fire events
// synchronously, which keeps Document's `writingToDisk` echo-guard deterministic
// (it is set true around the mutation that triggers the event).

import { TFile, TAbstractFile } from "./obsidian-mock";

type Handler = (...args: any[]) => void;

export class FakeVault {
	files = new Map<string, string>();
	folders = new Set<string>();
	private handlers: Record<string, Handler[]> = {};

	on(name: string, cb: Handler): { name: string; cb: Handler } {
		(this.handlers[name] ??= []).push(cb);
		return { name, cb };
	}
	off(name: string, cb: Handler): void {
		this.handlers[name] = (this.handlers[name] ?? []).filter((h) => h !== cb);
	}
	private emit(name: string, ...args: any[]): void {
		for (const h of this.handlers[name] ?? []) h(...args);
	}

	getAbstractFileByPath(path: string): TAbstractFile | null {
		if (this.files.has(path)) return new TFile(path);
		if (this.folders.has(path)) return new TAbstractFile(path);
		return null;
	}
	async read(file: TFile): Promise<string> {
		return this.files.get(file.path) ?? "";
	}
	async modify(file: TFile, text: string): Promise<void> {
		this.files.set(file.path, text);
		this.emit("modify", new TFile(file.path));
	}
	async create(path: string, text: string): Promise<TFile> {
		this.files.set(path, text);
		const f = new TFile(path);
		this.emit("create", f);
		return f;
	}
	async delete(file: TAbstractFile): Promise<void> {
		this.files.delete(file.path);
		this.emit("delete", new TFile(file.path));
	}
	async createFolder(path: string): Promise<void> {
		this.folders.add(path);
	}
	getMarkdownFiles(): TFile[] {
		return [...this.files.keys()]
			.filter((p) => p.endsWith(".md"))
			.map((p) => new TFile(p));
	}

	/** Test helper: simulate an external/offline edit + the resulting event. */
	rename(oldPath: string, newPath: string): void {
		const content = this.files.get(oldPath) ?? "";
		this.files.delete(oldPath);
		this.files.set(newPath, content);
		this.emit("rename", new TFile(newPath), oldPath);
	}
}

export interface FakePlugin {
	settings: {
		serverUrl: string;
		vaultId: string;
		clientName: string;
		clientColor: string;
		clientColorLight: string;
		enabled: boolean;
	};
	app: { vault: FakeVault; workspace: { on: () => unknown } };
	registerEvent: (ref: unknown) => void;
	applyAwarenessTo: (doc: unknown) => void;
	setStatus: (status: string) => void;
}

export function makeFakePlugin(
	serverUrl: string,
	opts: { clientName?: string; vaultId?: string } = {},
): { plugin: FakePlugin; vault: FakeVault } {
	const vault = new FakeVault();
	const plugin: FakePlugin = {
		settings: {
			serverUrl,
			vaultId: opts.vaultId ?? "test-vault",
			clientName: opts.clientName ?? "Test Client",
			clientColor: "#ffffff",
			clientColorLight: "#ffffff33",
			enabled: true,
		},
		app: { vault, workspace: { on: () => ({}) } },
		registerEvent: () => {},
		applyAwarenessTo: () => {},
		setStatus: () => {},
	};
	return { plugin, vault };
}
