/**
 * Named-capability versioning for client/server compatibility.
 *
 * The server advertises a `caps` object on `GET /api/server-info` mapping each
 * compatibility surface to an opaque string version. The client intersects
 * those values against `REQUIRED_CAPS` below; on any mismatch the client
 * hard-blocks connect/sync rather than proceeding and corrupting state.
 *
 * Cap values are bumped **only** on a wire-incompatible change to that surface
 * (removing/renaming a field, changing a type, changing semantics). Adding an
 * optional field does NOT bump. See `AGENTS.md` "Compatibility & versioning".
 *
 * Only the Obsidian plugin enforces caps. The SDK and CLI mirror the optional
 * `caps`/`requiredCaps` fields on `ServerInfoResponse` so consumers can
 * self-gate, but they do not block on mismatches themselves.
 */

import { SYNC_FORMAT } from "./pluginDb/types";

/** Names of every compatibility surface the plugin understands. */
export const CAP_NAMES = ["restApi", "oauth", "pluginDbSync", "attachmentShim"] as const;
export type CapName = (typeof CAP_NAMES)[number];

/**
 * Accepted cap values per surface. A server advertising a value not in this
 * list is treated as incompatible (direction cannot be inferred from opaque
 * strings, so the result is the neutral `"server-incompatible"`).
 *
 * To accept a range of server releases during a migration window, list multiple
 * values here (e.g. `restApi: ["1", "2"]`).
 */
export const REQUIRED_CAPS: Record<CapName, string[]> = {
  restApi: ["1"],
  oauth: ["1"],
  pluginDbSync: [SYNC_FORMAT],
  attachmentShim: ["https://realtime.md/attachment-shim/v1"],
};

/** Mandatory caps the client always requires (vs. future optional caps). */
const MANDATORY_CAPS: readonly CapName[] = CAP_NAMES;

export type CompatibilityResult =
  | { ok: true }
  | { ok: false; reason: "server-incompatible" | "client-too-old"; detail: string };

/**
 * Check a server's advertised `caps`/`requiredCaps` against the client's
 * accepted values. Pure function — does not know the server's release version.
 *
 * Leniency rules:
 *  - `caps` is `null`/`undefined`/not an object → proceed (old server in the
 *    rollout window before servers advertised caps).
 *  - `caps` is an object but lacks a mandatory cap → block
 *    `"server-incompatible"`.
 *  - cap value not in `REQUIRED_CAPS[name]` → block `"server-incompatible"`.
 *  - cap name listed in the server's `requiredCaps` but unknown to this client
 *    → block `"client-too-old"`.
 *  - unknown cap name NOT in `requiredCaps` → ignored (forward-compatible
 *    additive surfaces).
 */
export function checkServerCaps(caps: unknown, requiredCaps?: unknown): CompatibilityResult {
  // Old server (pre-caps rollout): lenient.
  if (caps === null || caps === undefined || typeof caps !== "object" || Array.isArray(caps)) {
    return { ok: true };
  }
  const capsMap = caps as Record<string, unknown>;

  for (const name of MANDATORY_CAPS) {
    if (!(name in capsMap)) {
      return {
        ok: false,
        reason: "server-incompatible",
        detail: `server is missing required cap "${name}"`,
      };
    }
    const advertised = capsMap[name];
    if (typeof advertised !== "string") {
      return {
        ok: false,
        reason: "server-incompatible",
        detail: `server advertised non-string value for cap "${name}"`,
      };
    }
    if (!REQUIRED_CAPS[name].includes(advertised)) {
      return {
        ok: false,
        reason: "server-incompatible",
        detail: `server advertised ${name}=${JSON.stringify(advertised)}, client accepts ${JSON.stringify(
          REQUIRED_CAPS[name],
        )}`,
      };
    }
  }

  // Server-required caps this client doesn't know → client too old.
  if (Array.isArray(requiredCaps)) {
    for (const name of requiredCaps) {
      if (typeof name !== "string") continue;
      if (!(CAP_NAMES as readonly string[]).includes(name)) {
        return {
          ok: false,
          reason: "client-too-old",
          detail: `server requires cap "${name}" which this client does not know`,
        };
      }
    }
  }

  return { ok: true };
}

/**
 * Thrown by `Auth.serverInfoChecked` when `checkServerCaps` fails. Distinct
 * from `AuthError` — compatibility is not session expiry. Callers (notably
 * `maybeStartSync`) catch this specifically to hard-block sync while still
 * tolerating network/offline errors.
 */
export class CompatibilityError extends Error {
  readonly reason: "server-incompatible" | "client-too-old";
  readonly serverVersion?: string;

  constructor(
    reason: "server-incompatible" | "client-too-old",
    detail: string,
    serverVersion?: string,
  ) {
    super(detail);
    this.name = "CompatibilityError";
    this.reason = reason;
    this.serverVersion = serverVersion;
  }
}
