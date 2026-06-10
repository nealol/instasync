#!/usr/bin/env bun
/**
 * Rewrite the per-vault git audit repos so every commit subject uses the
 * descriptive format the server now generates ("Add note.md",
 * "Rename Old.md → New.md and update links", "Update 4 plugin databases", …)
 * instead of the old "Sync n file(s)", then force-push each vault that has a
 * git backup configured.
 *
 * Subjects are recomputed deterministically from each commit's diff, so the
 * script is idempotent: commits that already carry the new format keep their
 * subject (their hash still changes if an ancestor's did). Bodies — the
 * Vault-Id / Principal-* / Co-authored-by trailers — and author/committer
 * identities and dates are preserved exactly. History must be linear (the
 * audit log always is); repos with merge commits are skipped with a warning.
 *
 * Usage:
 *   bun scripts/rewrite-commit-subjects.ts [--git-dir ./git] [--db ./realtime.db]
 *                                          [--dry-run] [--no-push] [--gc]
 *
 * Run it with the server STOPPED (it rewrites refs the server also writes to).
 */

import { Database } from "bun:sqlite";
import { existsSync, readdirSync, statSync, chmodSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

// ---------- CLI ----------

const args = process.argv.slice(2);
function flag(name: string): boolean {
	return args.includes(name);
}
function opt(name: string, fallback: string): string {
	const i = args.indexOf(name);
	return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const GIT_DIR = resolve(opt("--git-dir", process.env.GIT_DATA_DIR ?? "./git"));
const DB_PATH = resolve(opt("--db", process.env.REALTIME_DB ?? "./realtime.db"));
const DRY_RUN = flag("--dry-run");
const NO_PUSH = flag("--no-push");
const GC = flag("--gc");

// ---------- git helpers ----------

function git(
	repo: string,
	argv: string[],
	options: { env?: Record<string, string>; stdin?: string; allowFail?: boolean } = {},
): string {
	const proc = Bun.spawnSync(["git", "-C", repo, ...argv], {
		env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...options.env },
		stdin: options.stdin !== undefined ? new TextEncoder().encode(options.stdin) : undefined,
	});
	if (proc.exitCode !== 0 && !options.allowFail) {
		throw new Error(`git ${argv.join(" ")} failed: ${proc.stderr.toString().trim()}`);
	}
	return proc.stdout.toString();
}

// ---------- subject computation (port of server/src/git.rs) ----------

interface Change {
	status: string; // A | M | D | R (others group with M)
	path: string; // old path for renames
	renamedTo?: string;
}

const SUBJECT_MAX_FILES = 3;
// Current and legacy locations of plugin-database SQL dumps in the repo.
const SQL_DUMP_PREFIXES = [".sql/", ".realtime/plugin-dbs/"];

function parseNameStatus(output: string): Change[] {
	const changes: Change[] = [];
	for (const line of output.split("\n")) {
		const parts = line.split("\t");
		if (parts.length < 2 || !parts[0]) continue;
		const status = parts[0][0];
		if (status === "R" && parts.length >= 3) {
			changes.push({ status: "R", path: parts[1], renamedTo: parts[2] });
		} else {
			changes.push({ status, path: parts[1] });
		}
	}
	return changes;
}

function sqlDumpParts(path: string): { plugin: string; name: string } | null {
	for (const prefix of SQL_DUMP_PREFIXES) {
		if (!path.startsWith(prefix)) continue;
		const rest = path.slice(prefix.length);
		const slash = rest.indexOf("/");
		if (slash <= 0) continue;
		const plugin = rest.slice(0, slash);
		const file = rest.slice(slash + 1);
		if (!file.endsWith(".sql") || file.includes("/")) continue;
		const name = file.slice(0, -".sql".length);
		if (name) return { plugin, name };
	}
	return null;
}

function changeLabel(change: Change): string {
	if (change.renamedTo) return `${change.path} → ${change.renamedTo}`;
	const dump = sqlDumpParts(change.path);
	return dump ? `${dump.plugin} plugin database (${dump.name})` : change.path;
}

/** Strings a rename plausibly changes inside other notes' links, longest first. */
function renameLinkVariants(oldPath: string, newPath: string): [string, string][] {
	const variants: [string, string][] = [[oldPath, newPath]];
	if (oldPath.endsWith(".md") && newPath.endsWith(".md")) {
		variants.push([oldPath.slice(0, -3), newPath.slice(0, -3)]);
	}
	const oldBase = oldPath.split("/").pop()!;
	const newBase = newPath.split("/").pop()!;
	if (oldBase !== oldPath) variants.push([oldBase, newBase]);
	if (oldBase.endsWith(".md") && newBase.endsWith(".md")) {
		variants.push([oldBase.slice(0, -3), newBase.slice(0, -3)]);
	}
	variants.sort((a, b) => b[0].length - a[0].length);
	return variants.filter(([o], i) => variants.findIndex(([p]) => p === o) === i);
}

function isLinkOnlyUpdate(diff: string, renames: [string, string][]): boolean {
	const removed: string[] = [];
	const added: string[] = [];
	for (const line of diff.split("\n")) {
		if (line.startsWith("--- ") || line.startsWith("+++ ")) continue;
		if (line.startsWith("-")) removed.push(line.slice(1));
		else if (line.startsWith("+")) added.push(line.slice(1));
	}
	if (removed.length === 0 || removed.length !== added.length) return false;
	const variants = renames
		.flatMap(([o, n]) => renameLinkVariants(o, n))
		.sort((a, b) => b[0].length - a[0].length);
	return removed.every((before, i) => {
		let rewritten = before;
		for (const [o, n] of variants) rewritten = rewritten.replaceAll(o, n);
		return rewritten === added[i];
	});
}

const GROUPS: [string, string][] = [
	["R", "rename"],
	["A", "add"],
	["M", "update"],
	["D", "delete"],
];

function group(status: string): string {
	return status === "R" || status === "A" || status === "D" ? status : "M";
}

function commitSubject(changes: Change[], linkOnly: Set<string>): string {
	const renames = changes.filter((c) => c.status === "R");
	const others = changes.filter((c) => c.status !== "R");
	if (renames.length > 0 && others.every((c) => linkOnly.has(c.path))) {
		let subject =
			renames.length <= SUBJECT_MAX_FILES
				? `Rename ${renames.map((c) => `${c.path} → ${c.renamedTo}`).join(", ")}`
				: `Rename ${renames.length} files`;
		if (others.length > 0) subject += " and update links";
		return subject;
	}

	if (changes.length <= SUBJECT_MAX_FILES) {
		const segments: string[] = [];
		for (const [status, verb] of GROUPS) {
			const labels = changes.filter((c) => group(c.status) === status).map(changeLabel);
			if (labels.length > 0) segments.push(`${verb} ${labels.join(", ")}`);
		}
		const subject = segments.join(", ");
		return subject[0].toUpperCase() + subject.slice(1);
	}

	const kinds = new Set(changes.map((c) => c.status));
	const verb =
		kinds.size === 1 ? ({ A: "Add", D: "Delete" }[changes[0].status] ?? "Update") : "Update";
	return changes.every((c) => sqlDumpParts(c.path) !== null)
		? `${verb} ${changes.length} plugin databases`
		: `${verb} ${changes.length} files`;
}

// ---------- history rewrite ----------

/** Rewrite all subjects in `repo`. Returns the new HEAD, or null if unchanged/skipped. */
function rewriteRepo(repo: string): string | null {
	const head = git(repo, ["rev-parse", "--verify", "-q", "HEAD"], { allowFail: true }).trim();
	if (!head) {
		console.log(`  empty repo, skipping`);
		return null;
	}
	const commits = git(repo, ["rev-list", "--reverse", "HEAD"]).trim().split("\n");
	const rewritten = new Map<string, string>();
	let anySubjectChanged = false;

	for (const commit of commits) {
		const parents = git(repo, ["rev-list", "--parents", "-n", "1", commit])
			.trim()
			.split(" ")
			.slice(1);
		if (parents.length > 1) {
			console.warn(`  merge commit ${commit.slice(0, 8)} found — skipping this repo`);
			return null;
		}

		const nameStatus = git(repo, [
			"diff-tree", "-r", "--find-renames", "--no-commit-id", "--name-status", "--root", commit,
		]);
		const changes = parseNameStatus(nameStatus);

		// Link-only detection mirrors the server: only when every non-rename
		// change is a modification alongside at least one rename.
		const linkOnly = new Set<string>();
		const renames: [string, string][] = changes
			.filter((c) => c.renamedTo)
			.map((c) => [c.path, c.renamedTo!]);
		if (renames.length > 0 && changes.every((c) => c.status === "R" || c.status === "M")) {
			for (const c of changes.filter((c) => c.status === "M")) {
				const diff = git(repo, [
					"diff-tree", "-r", "--no-commit-id", "--root", "-p", commit, "--", c.path,
				]);
				if (isLinkOnlyUpdate(diff, renames)) linkOnly.add(c.path);
			}
		}

		const message = git(repo, ["log", "-1", "--format=%B", commit]);
		const blank = message.indexOf("\n\n");
		const oldSubject = (blank >= 0 ? message.slice(0, blank) : message).trim();
		const body = blank >= 0 ? message.slice(blank + 2).trimEnd() : "";
		const newSubject = changes.length > 0 ? commitSubject(changes, linkOnly) : oldSubject;
		if (newSubject !== oldSubject) {
			anySubjectChanged = true;
			console.log(`  ${commit.slice(0, 8)}  ${JSON.stringify(oldSubject)} -> ${JSON.stringify(newSubject)}`);
		}
		if (DRY_RUN) continue;

		const [an, ae, ad, cn, ce, cd] = git(repo, [
			"log", "-1", "--format=%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI", commit,
		]).trim().split("\0");
		const tree = git(repo, ["rev-parse", `${commit}^{tree}`]).trim();
		const parentArgs = parents.flatMap((p) => ["-p", rewritten.get(p) ?? p]);
		const newCommit = git(repo, ["commit-tree", tree, ...parentArgs], {
			stdin: `${newSubject}\n\n${body}\n`,
			env: {
				GIT_AUTHOR_NAME: an, GIT_AUTHOR_EMAIL: ae, GIT_AUTHOR_DATE: ad,
				GIT_COMMITTER_NAME: cn, GIT_COMMITTER_EMAIL: ce, GIT_COMMITTER_DATE: cd,
			},
		}).trim();
		rewritten.set(commit, newCommit);
	}

	if (DRY_RUN || !anySubjectChanged) {
		if (!anySubjectChanged) console.log("  all subjects already up to date");
		return null;
	}
	const newHead = rewritten.get(head)!;
	const branch = git(repo, ["symbolic-ref", "--short", "HEAD"]).trim();
	git(repo, ["update-ref", `refs/heads/${branch}`, newHead, head]);
	console.log(`  ${branch}: ${head.slice(0, 8)} -> ${newHead.slice(0, 8)}`);
	if (GC) {
		git(repo, ["reflog", "expire", "--expire=now", "--all"]);
		git(repo, ["gc", "--prune=now", "--quiet"]);
	}
	return newHead;
}

// ---------- force-push (mirrors GitService::run_remote_git) ----------

interface BackupRow {
	vault_id: string;
	remote_url: string;
	auth_method: string;
	branch: string;
	ssh_private_key: string | null;
	https_token: string | null;
	enabled: number;
}

function forcePush(repo: string, vaultId: string, cfg: BackupRow) {
	const env: Record<string, string> = {};
	const argv = ["push", "--force"];
	if (cfg.auth_method === "ssh") {
		if (!cfg.ssh_private_key) throw new Error("ssh backup has no private key");
		const keyPath = join(GIT_DIR, `${vaultId}.ssh_key`);
		writeFileSync(keyPath, cfg.ssh_private_key);
		chmodSync(keyPath, 0o600);
		env.GIT_SSH_COMMAND = `ssh -i '${keyPath.replaceAll("'", `'\\''`)}' -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o BatchMode=yes`;
	} else if (cfg.auth_method === "https") {
		if (!cfg.https_token) throw new Error("https backup has no token");
		argv.unshift("-c", `credential.helper=!f() { echo "username=x-token"; echo "password=$GIT_BACKUP_TOKEN"; }; f`);
		env.GIT_BACKUP_TOKEN = cfg.https_token;
	}
	git(repo, [...argv, cfg.remote_url, `HEAD:refs/heads/${cfg.branch}`], { env });
}

// ---------- main ----------

if (!existsSync(GIT_DIR)) {
	console.error(`git data dir not found: ${GIT_DIR}`);
	process.exit(1);
}
const db = existsSync(DB_PATH) ? new Database(DB_PATH, { readonly: true }) : null;
if (!db) console.warn(`db not found at ${DB_PATH} — rewriting only, no pushes`);

const backups = new Map<string, BackupRow>();
if (db) {
	try {
		for (const row of db.query<BackupRow, []>("SELECT * FROM git_backups WHERE enabled = 1").all()) {
			backups.set(row.vault_id, row);
		}
	} catch {
		console.warn("no git_backups table — rewriting only, no pushes");
	}
}

const repos = readdirSync(GIT_DIR).filter((name) => {
	const p = join(GIT_DIR, name);
	return statSync(p).isDirectory() && existsSync(join(p, ".git"));
});
console.log(`${repos.length} vault repo(s) under ${GIT_DIR}${DRY_RUN ? " (dry run)" : ""}`);

let failures = 0;
for (const vaultId of repos) {
	const repo = join(GIT_DIR, vaultId);
	console.log(`\n${vaultId}`);
	try {
		const newHead = rewriteRepo(repo);
		if (newHead && !NO_PUSH) {
			const cfg = backups.get(vaultId);
			if (cfg) {
				forcePush(repo, vaultId, cfg);
				console.log(`  force-pushed to ${cfg.remote_url} (${cfg.branch})`);
			} else {
				console.log("  no enabled backup configured — not pushed");
			}
		}
	} catch (e) {
		failures++;
		console.error(`  FAILED: ${(e as Error).message}`);
	}
}
if (failures > 0) {
	console.error(`\n${failures} repo(s) failed`);
	process.exit(1);
}
