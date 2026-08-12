import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { parse } from "acorn";
import { checkServerCaps as checkCurrentServerCaps, serverSupportsCapability } from "../src/caps";

type CompatibilityResult =
  | { ok: true }
  | { ok: false; reason: "server-incompatible" | "client-too-old"; detail: string };

type Artifact = {
  path: string;
  url: string;
  bytes: number;
  sha256: string;
};

type Baseline = {
  id: string;
  commit: string;
  plugin: { version: string; artifacts: Artifact[] };
  server: {
    version: string;
    image: string;
    platform: string;
    requiredCaps: string[];
    artifacts: Artifact[];
  };
  expectations: Record<string, "ok" | "server-incompatible" | "client-too-old">;
};

type ReleaseManifest = {
  schemaVersion: number;
  cacheDirectory: string;
  baselines: Baseline[];
};

type ServerContract = {
  version: string;
  caps: Record<string, string>;
  requiredCaps: string[];
};

const repositoryRoot = resolve(import.meta.dir, "..");
const manifestPath = join(import.meta.dir, "releases.json");
const offline = process.argv.includes("--offline");
const runReleasedServer = process.argv.includes("--released-server");

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function readManifest(): Promise<ReleaseManifest> {
  const parsed = JSON.parse(await readFile(manifestPath, "utf8")) as ReleaseManifest;
  invariant(
    parsed.schemaVersion === 1,
    `unsupported compatibility manifest v${parsed.schemaVersion}`,
  );
  invariant(
    typeof parsed.cacheDirectory === "string" && parsed.cacheDirectory.length > 0,
    "compatibility cache directory is missing",
  );
  invariant(Array.isArray(parsed.baselines) && parsed.baselines.length > 0, "no release baselines");
  return parsed;
}

function safeCachePath(cacheRoot: string, baselineId: string, artifactPath: string): string {
  invariant(!isAbsolute(artifactPath), `absolute artifact path ${artifactPath}`);
  const destination = resolve(cacheRoot, baselineId, artifactPath);
  const baselineRoot = `${resolve(cacheRoot, baselineId)}${sep}`;
  invariant(destination.startsWith(baselineRoot), `artifact path escapes cache: ${artifactPath}`);
  return destination;
}

async function digestFile(path: string): Promise<{ bytes: number; sha256: string }> {
  const bytes = new Uint8Array(await readFile(path));
  return {
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

async function artifactMatches(path: string, artifact: Artifact): Promise<boolean> {
  try {
    const actual = await digestFile(path);
    return actual.bytes === artifact.bytes && actual.sha256 === artifact.sha256;
  } catch {
    return false;
  }
}

async function acquireArtifact(cacheRoot: string, baselineId: string, artifact: Artifact) {
  invariant(/^https:\/\//.test(artifact.url), `artifact URL must use HTTPS: ${artifact.url}`);
  invariant(/^[a-f0-9]{64}$/.test(artifact.sha256), `invalid SHA-256 for ${artifact.path}`);
  invariant(
    Number.isSafeInteger(artifact.bytes) && artifact.bytes >= 0,
    `invalid size for ${artifact.path}`,
  );
  const destination = safeCachePath(cacheRoot, baselineId, artifact.path);
  if (await artifactMatches(destination, artifact)) return destination;
  invariant(!offline, `missing or corrupt cached artifact ${artifact.path} in offline mode`);

  const response = await fetch(artifact.url, { redirect: "follow" });
  invariant(response.ok, `download ${artifact.url}: HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  invariant(
    bytes.byteLength === artifact.bytes,
    `${artifact.path}: expected ${artifact.bytes} bytes, got ${bytes.byteLength}`,
  );
  invariant(
    sha256 === artifact.sha256,
    `${artifact.path}: expected SHA-256 ${artifact.sha256}, got ${sha256}`,
  );

  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp-${process.pid}`;
  await writeFile(temporary, bytes, { flag: "wx" });
  await rename(temporary, destination);
  return destination;
}

async function acquireBaseline(cacheRoot: string, baseline: Baseline) {
  invariant(/^[a-f0-9]{40}$/.test(baseline.commit), `${baseline.id}: invalid commit`);
  const artifacts = [...baseline.plugin.artifacts, ...baseline.server.artifacts];
  const paths = new Map<string, string>();
  for (const artifact of artifacts) {
    invariant(
      !paths.has(artifact.path),
      `${baseline.id}: duplicate artifact path ${artifact.path}`,
    );
    paths.set(artifact.path, await acquireArtifact(cacheRoot, baseline.id, artifact));
  }
  return paths;
}

async function runCommand(command: string[], options: { cwd?: string; timeoutMs?: number } = {}) {
  const child = Bun.spawn(command, {
    cwd: options.cwd ?? repositoryRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill(), options.timeoutMs ?? 120_000);
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  clearTimeout(timeout);
  invariant(exitCode === 0, `${command.join(" ")} failed (${exitCode}):\n${stderr}`);
  return { stdout, stderr };
}

async function releasedServerCaps(
  baseline: Baseline,
  artifacts: Map<string, string>,
): Promise<ServerContract> {
  const capsPath = artifacts.get("server/src/caps.rs");
  invariant(capsPath, `${baseline.id}: server caps source was not acquired`);
  const temporary = await mkdtemp(join(tmpdir(), "realtime-compat-rust-"));
  try {
    const helper = join(temporary, "main.rs");
    const executable = join(temporary, "caps");
    const escapedPath = capsPath.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
    await writeFile(
      helper,
      `#[path = "${escapedPath}"]\nmod caps;\nfn main() { for (name, value) in caps::caps() { println!("{}\\t{}", name, value); } }\n`,
    );
    await runCommand(["rustc", "--edition", "2021", helper, "-o", executable], {
      timeoutMs: 60_000,
    });
    const { stdout } = await runCommand([executable], { timeoutMs: 10_000 });
    const caps = Object.fromEntries(
      stdout
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const separator = line.indexOf("\t");
          invariant(separator > 0, `${baseline.id}: malformed cap line ${JSON.stringify(line)}`);
          return [line.slice(0, separator), line.slice(separator + 1)];
        }),
    );
    return { version: baseline.server.version, caps, requiredCaps: baseline.server.requiredCaps };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function currentServerContract(): Promise<ServerContract> {
  const { stdout } = await runCommand(
    [
      "cargo",
      "run",
      "--quiet",
      "--manifest-path",
      "server/Cargo.toml",
      "--bin",
      "realtime-server",
      "--",
      "compatibility",
    ],
    { timeoutMs: 300_000 },
  );
  const contract = JSON.parse(stdout) as ServerContract;
  invariant(typeof contract.version === "string", "current server contract has no version");
  invariant(
    contract.caps && typeof contract.caps === "object",
    "current server contract has no caps",
  );
  invariant(Array.isArray(contract.requiredCaps), "current server contract has no requiredCaps");
  return contract;
}

async function releasedClientChecker(
  baseline: Baseline,
  artifacts: Map<string, string>,
): Promise<(caps: unknown, requiredCaps?: unknown) => CompatibilityResult> {
  const bundlePath = artifacts.get("release/main.js");
  invariant(bundlePath, `${baseline.id}: release bundle was not acquired`);
  const bundle = await readFile(bundlePath, "utf8");
  const marker = "server did not advertise compatibility caps";
  const markerOffset = bundle.indexOf(marker);
  invariant(markerOffset >= 0, `${baseline.id}: released bundle has no cap checker`);

  const program = parse(bundle, {
    ecmaVersion: "latest",
    sourceType: "script",
  }) as unknown as {
    body: Array<{ start: number; end: number }>;
  };
  const statement = program.body.find(
    ({ start, end }) => start <= markerOffset && markerOffset < end,
  );
  invariant(statement, `${baseline.id}: could not extract cap checker from released bundle`);

  const dependencyStart = bundle.lastIndexOf("var ", statement.start - 1);
  invariant(dependencyStart >= 0, `${baseline.id}: released cap checker constants are missing`);
  let extracted = bundle.slice(dependencyStart, statement.end);
  const syncReference = /pluginDbSync:\[([$A-Z_a-z][$\w]*)\]/.exec(extracted)?.[1];
  invariant(syncReference, `${baseline.id}: released plugin DB cap is missing`);
  const syncDefinition = new RegExp(`(?:var|let|const)\\s+${syncReference}=(["'][^"']+["'])`).exec(
    bundle.slice(0, dependencyStart),
  );
  invariant(syncDefinition, `${baseline.id}: released plugin DB cap value is missing`);
  extracted = `var ${syncReference}=${syncDefinition[1]};${extracted}`;
  const functionMatch = /function\s+([$A-Z_a-z][$\w]*)\s*\([^)]*\)\s*\{/.exec(extracted);
  invariant(functionMatch, `${baseline.id}: released bundle cap checker is not a function`);
  const checkerName = functionMatch[1];
  const helper = `${extracted}\nexport default ${checkerName};\n`;
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(helper).toString("base64")}`;
  const module = (await import(moduleUrl)) as {
    default?: (caps: unknown, requiredCaps?: unknown) => CompatibilityResult;
  };
  invariant(typeof module.default === "function", `${baseline.id}: released cap checker missing`);
  return module.default;
}

function resultKind(result: CompatibilityResult): "ok" | "server-incompatible" | "client-too-old" {
  return result.ok ? "ok" : result.reason;
}

function canonicalRecord(record: Record<string, string>): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right))),
  );
}

function assertScenario(
  name: string,
  actual: CompatibilityResult,
  expected: "ok" | "server-incompatible" | "client-too-old",
) {
  const kind = resultKind(actual);
  invariant(
    kind === expected,
    `${name}: expected ${expected}, got ${kind}: ${JSON.stringify(actual)}`,
  );
  return { name, result: kind };
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveReady, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveReady);
  });
  const address = server.address();
  invariant(address && typeof address === "object", "could not reserve a compatibility port");
  const port = address.port;
  await new Promise<void>((resolveClose, reject) =>
    server.close((error) => (error ? reject(error) : resolveClose())),
  );
  return port;
}

async function fetchReleasedServerContract(baseline: Baseline): Promise<ServerContract> {
  const port = await freePort();
  const name = `realtime-compat-${process.pid}-${Date.now()}`;
  const privateKey = "QPMjc_R5o-0dJvgjwnFKmeBfDZqHbxyFWn7Q51TI";
  await runCommand(
    [
      "docker",
      "run",
      "--detach",
      "--rm",
      "--name",
      name,
      "--platform",
      baseline.server.platform,
      "-p",
      `127.0.0.1:${port}:8081`,
      "-e",
      "BIND_ADDR=0.0.0.0:8081",
      "-e",
      `PUBLIC_BASE_URL=http://127.0.0.1:${port}`,
      "-e",
      "OIDC_MODE=mock",
      "-e",
      "ALLOW_MOCK_OIDC=1",
      "-e",
      `YSWEET_AUTH_KEY=${privateKey}`,
      "-e",
      "GIT_AUDIT_ENABLED=0",
      baseline.server.image,
    ],
    { timeoutMs: 300_000 },
  );
  try {
    const deadline = Date.now() + 60_000;
    let lastError = "server did not answer";
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/server-info`);
        if (response.ok) return (await response.json()) as ServerContract;
        lastError = `HTTP ${response.status}`;
      } catch (error) {
        lastError = String(error);
      }
      await Bun.sleep(250);
    }
    throw new Error(`${baseline.id}: released server failed readiness: ${lastError}`);
  } finally {
    await runCommand(["docker", "stop", "--time", "5", name], { timeoutMs: 30_000 }).catch(
      () => undefined,
    );
  }
}

async function main() {
  const manifest = await readManifest();
  const cacheRoot = resolve(repositoryRoot, manifest.cacheDirectory);
  await mkdir(cacheRoot, { recursive: true });
  const currentServer = await currentServerContract();
  const reports: Array<Record<string, unknown>> = [];

  for (const baseline of manifest.baselines) {
    const artifacts = await acquireBaseline(cacheRoot, baseline);
    const releasedManifestPath = artifacts.get("release/manifest.json");
    invariant(releasedManifestPath, `${baseline.id}: release manifest missing`);
    const releasedManifest = JSON.parse(await readFile(releasedManifestPath, "utf8")) as {
      version?: string;
    };
    invariant(
      releasedManifest.version === baseline.plugin.version,
      `${baseline.id}: release manifest version ${releasedManifest.version} does not match ${baseline.plugin.version}`,
    );
    const checkReleased = await releasedClientChecker(baseline, artifacts);
    const sourceContract = await releasedServerCaps(baseline, artifacts);
    const releasedServer = runReleasedServer
      ? await fetchReleasedServerContract(baseline)
      : sourceContract;
    invariant(
      canonicalRecord(releasedServer.caps) === canonicalRecord(sourceContract.caps),
      `${baseline.id}: released image caps differ from pinned source`,
    );
    invariant(
      JSON.stringify(releasedServer.requiredCaps ?? []) ===
        JSON.stringify(sourceContract.requiredCaps),
      `${baseline.id}: released image requiredCaps differ from the pinned contract`,
    );

    const scenarios = [
      assertScenario(
        "released client / released server",
        checkReleased(releasedServer.caps, releasedServer.requiredCaps),
        baseline.expectations.releasedClientReleasedServer,
      ),
      assertScenario(
        "released client / current server",
        checkReleased(currentServer.caps, currentServer.requiredCaps),
        baseline.expectations.releasedClientCurrentServer,
      ),
      assertScenario(
        "current client / released server",
        checkCurrentServerCaps(releasedServer.caps, releasedServer.requiredCaps),
        baseline.expectations.currentClientReleasedServer,
      ),
      assertScenario(
        "current client / current server",
        checkCurrentServerCaps(currentServer.caps, currentServer.requiredCaps),
        baseline.expectations.currentClientCurrentServer,
      ),
    ];

    const withoutInvalidation = { ...currentServer.caps };
    delete withoutInvalidation.documentInvalidation;
    assertScenario(
      "current client / server without optional invalidations",
      checkCurrentServerCaps(withoutInvalidation, currentServer.requiredCaps),
      "ok",
    );
    invariant(
      !serverSupportsCapability(withoutInvalidation, "documentInvalidation"),
      "mobile eviction would be enabled without document invalidations",
    );

    reports.push({
      baseline: baseline.id,
      pluginVersion: baseline.plugin.version,
      serverVersion: baseline.server.version,
      currentServerVersion: currentServer.version,
      liveReleasedServer: runReleasedServer,
      scenarios,
    });
  }

  console.log(JSON.stringify({ schemaVersion: 1, reports }, null, 2));
}

await main();
