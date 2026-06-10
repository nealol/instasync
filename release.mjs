// Release helper for BRAT / Obsidian.
//
// Usage:
//   node release.mjs <version> [--prerelease] [--notes "..."]
//
// Steps it performs:
//   1. Writes <version> into manifest.json and package.json.
//   2. Adds a "<version>": "<minAppVersion>" entry to versions.json.
//   3. Runs the production build to produce main.js.
//   4. Creates a GitHub release tagged "<version>" (no "v" prefix, to match
//      the Obsidian convention) and uploads manifest.json, main.js and
//      styles.css as assets — which is all BRAT needs.
//
// Requires the `gh` CLI to be installed and authenticated.

import { execFileSync } from "child_process";
import { readFileSync, writeFileSync, existsSync } from "fs";

const args = process.argv.slice(2);
const version = args.find((a) => !a.startsWith("--"));
const prerelease = args.includes("--prerelease");
const notesIdx = args.indexOf("--notes");
const notes =
  notesIdx !== -1 && args[notesIdx + 1]
    ? args[notesIdx + 1]
    : `Release ${version}. Install or update via BRAT (nealol/realtime).`;

if (!version || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
  console.error("Usage: node release.mjs <version> [--prerelease] [--notes \"...\"]");
  console.error("  <version> must be a semver string, e.g. 0.1.1 or 0.2.0-beta.1");
  process.exit(1);
}

// NOTE: pass `shell: true` only for commands that actually need it (e.g. the
// `npm` .cmd shim on Windows). With `shell: true`, Node joins the args array
// into a command line WITHOUT quoting, so any argument containing spaces or
// shell metacharacters (like --notes) would be re-split by the shell. Real
// executables (gh) are run with shell:false so their args pass through verbatim.
const run = (cmd, cmdArgs, opts = {}) =>
  execFileSync(cmd, cmdArgs, { stdio: "inherit", ...opts });

// 1. manifest.json + package.json
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
manifest.version = version;
writeFileSync("manifest.json", JSON.stringify(manifest, null, 2) + "\n");

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
pkg.version = version;
writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");

// 2. versions.json (maps plugin version -> minAppVersion)
const versions = existsSync("versions.json")
  ? JSON.parse(readFileSync("versions.json", "utf8"))
  : {};
versions[version] = manifest.minAppVersion;
writeFileSync("versions.json", JSON.stringify(versions, null, 2) + "\n");

console.log(`Set version to ${version} (minAppVersion ${manifest.minAppVersion}).`);

// 3. Build
console.log("Building…");
// `bun` is launched directly; its args are fixed (no spaces/metacharacters),
// so shell quoting is not a concern.
run("bun", ["run", "build"], { shell: process.platform === "win32" });

if (!existsSync("main.js")) {
  console.error("Build did not produce main.js — aborting.");
  process.exit(1);
}

// 4. GitHub release
// crsqlite.wasm backs the synced-SQLite plugin API; ship it so clients can fetch
// it by version when it is not already cached in the plugin directory.
const assets = ["manifest.json", "main.js", "styles.css", "crsqlite.wasm"].filter((f) => existsSync(f));
const ghArgs = [
  "release",
  "create",
  version,
  ...assets,
  "--title",
  version,
  "--notes",
  notes,
];
if (prerelease) ghArgs.push("--prerelease");

console.log(`Creating GitHub release ${version} with: ${assets.join(", ")}`);
run("gh", ghArgs);

console.log(`\nDone. Released ${version}.`);
console.log(
  "Note: keep the manifest.json version bump out of your default branch for beta-only releases."
);
