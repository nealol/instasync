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
export const CAP_NAMES = [
  "restApi",
  "oauth",
  "pluginDbSync",
  "attachmentShim",
  "documentEpoch",
  "documentInvalidation",
] as const;
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
  restApi: ["3"],
  oauth: ["1"],
  pluginDbSync: [SYNC_FORMAT],
  attachmentShim: ["https://realtime.md/attachment-shim/v1"],
  documentEpoch: ["1"],
  documentInvalidation: ["1"],
};

/**
 * Caps required for every connection. `documentInvalidation` is intentionally
 * optional: clients can still sync with an older server, but must retain every
 * mobile document in memory because that server cannot wake an evicted child.
 */
const MANDATORY_CAPS: readonly CapName[] = [
  "restApi",
  "oauth",
  "pluginDbSync",
  "attachmentShim",
  "documentEpoch",
];

/** Whether a server advertises an accepted version of a known capability. */
export function serverSupportsCapability(caps: unknown, name: CapName): boolean {
  if (caps === null || caps === undefined || typeof caps !== "object" || Array.isArray(caps)) {
    return false;
  }
  const advertised = (caps as Record<string, unknown>)[name];
  return typeof advertised === "string" && REQUIRED_CAPS[name].includes(advertised);
}

export type CompatibilityResult =
  | { ok: true }
  | { ok: false; reason: "server-incompatible" | "client-too-old"; detail: string };

/**
 * Check a server's advertised `caps`/`requiredCaps` against the client's
 * accepted values. Pure function — does not know the server's release version.
 *
 * Rules:
 *  - `caps` is `null`/`undefined`/not an object → block. This client requires
 *    the caps-advertised `/dmux` transport and cannot safely talk to older
 *    servers that do not advertise caps.
 *  - `caps` is an object but lacks a mandatory cap → block
 *    `"server-incompatible"`.
 *  - mandatory or server-required cap value not in `REQUIRED_CAPS[name]` →
 *    block `"server-incompatible"`.
 *  - cap name listed in the server's `requiredCaps` but unknown to this client
 *    → block `"client-too-old"`.
 *  - unknown cap name NOT in `requiredCaps` → ignored (forward-compatible
 *    additive surfaces).
 */
export function checkServerCaps(caps: unknown, requiredCaps?: unknown): CompatibilityResult {
  // This client always uses /dmux, so a server that does not advertise caps is
  // too old to prove it supports the required sync transport.
  if (caps === null || caps === undefined || typeof caps !== "object" || Array.isArray(caps)) {
    return {
      ok: false,
      reason: "server-incompatible",
      detail: "server did not advertise compatibility caps",
    };
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
      const capName = name as CapName;
      if (!serverSupportsCapability(capsMap, capName)) {
        return {
          ok: false,
          reason: "server-incompatible",
          detail: `server requires unsupported cap "${name}"`,
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
