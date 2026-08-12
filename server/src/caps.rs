//! Named capability versioning.
//!
//! Each constant here pins the wire/protocol shape of one compatibility surface
//! between the server and its clients. A cap value is an opaque string bumped
//! **only** on a wire-incompatible change to that surface — adding an optional
//! request/response field does NOT bump; removing or renaming a field, changing
//! a type, or changing semantics DOES bump.
//!
//! These values are advertised on `GET /api/server-info` as `caps`, plus a
//! `requiredCaps` list of cap names that clients must understand. See
//! `AGENTS.md` "Compatibility & versioning" for the full rules.

/// REST API surface (`/api/*` request/response shapes), plus the sync transport
/// the plugin now requires: Yjs documents are multiplexed over bounded `/dmux`
/// WebSocket shards, so a client on this cap will not connect to a server that
/// lacks that route.
pub const REST_API: &str = "3";

/// OAuth 2.1 server metadata + token endpoint shape, as consumed by the
/// Obsidian plugin's own OAuth flow. External MCP clients consume the OAuth
/// metadata document directly and do not see this cap.
pub const OAUTH: &str = "1";

/// cr-sqlite plugin-database replication wire format. Mirrors the client-side
/// `SYNC_FORMAT` constant in `src/pluginDb/types.ts`; the two must stay in
/// lockstep.
pub const PLUGIN_DB_SYNC: &str = "crsqlite-1";

/// Attachment shim text format committed into git backups for oversized blobs.
/// The full URI is the cap value — there is one source of truth for this
/// string, re-exported by `git::ATTACHMENT_SHIM_VERSION`.
pub const ATTACHMENT_SHIM: &str = "https://realtime.md/attachment-shim/v1";

/// Wire-visible logical replacement of long-lived Yjs documents. Clients must
/// persist and acknowledge the proposed epoch before reconnecting with a fresh
/// Y.Doc; old-epoch writes are rejected.
pub const DOCUMENT_EPOCH: &str = "1";

/// Advisory child-document invalidation messages delivered over a live vault
/// index connection. Mobile clients use this before evicting per-file Y.Docs.
pub const DOCUMENT_INVALIDATION: &str = "1";

/// Cap names clients must understand before connecting. Invalidation remains
/// optional because older clients never evict documents and can ignore it.
pub const REQUIRED: &[&str] = &["documentEpoch"];

/// All caps advertised on `/api/server-info`, in stable order.
pub fn caps() -> Vec<(&'static str, &'static str)> {
    vec![
        ("restApi", REST_API),
        ("oauth", OAUTH),
        ("pluginDbSync", PLUGIN_DB_SYNC),
        ("attachmentShim", ATTACHMENT_SHIM),
        ("documentEpoch", DOCUMENT_EPOCH),
        ("documentInvalidation", DOCUMENT_INVALIDATION),
    ]
}
