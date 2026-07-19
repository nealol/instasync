# Canvas collaboration internals

Realtime keeps the standard JSON Canvas file shape on disk. Each Canvas gets its own Yjs document with ID-keyed `nodes` and `edges` maps, order arrays, and deletion tombstones. Text-like fields remain `Y.Text`; no cursor, selection, drag, resize, or viewport data enters persistent document state.

## Local edits

`CanvasBinding` keeps a normalized shadow of the state last shown in the bound Obsidian view. A save or interaction sample compares the current view with that shadow and sends only changed fields through `CanvasDocument.applyCanvasOperations()`. The operation batch runs in one Yjs transaction. A node move therefore changes `x` and `y` without replaying stale text or style fields.

Pointer interactions sample at a fixed interval and publish once more on release. Remote document events coalesce, and snapshot imports wait until a local drag ends. The final save path remains patched as a correctness fallback.

## Remote edits and private APIs

`CanvasViewAdapter` isolates Obsidian's private Canvas methods. It probes reads, item mutation, rendering, selection, interaction, viewport, and active text-editor shapes before calling them. A supported operation batch updates the live node or edge directly while retaining selection and viewport state.

Ordering changes, missing methods, and thrown private calls trigger one full `importData(..., true)` fallback. If the plugin can't attach a safe live binding at all, `StructuredDocument` writes the CRDT value to disk. Reused leaves recheck `file.path` before every read or write so an old binding can't overwrite the newly opened Canvas.

## Text cards and awareness

An active text card binds its CodeMirror document to the node's `Y.Text`. Relative cursor positions carry the active node ID; clients render a remote caret only when both the node ID and resolved `Y.Text` match. Detaching the editor clears the cursor and editing state.

Canvas awareness payload version 1 carries selections, drag or resize previews, the edited node, viewport coordinates, and a monotonic sequence. Parsers reject malformed or unknown versions. Unbind, blur, hidden-document, and disconnect paths clear local Canvas awareness and remove overlays.

## Server and automation

`POST /api/vaults/{id}/canvas-operations/{path}` accepts node, edge, and order operations. The server validates the complete batch against one decoded Yjs state, builds one field-level Yjs update, then writes it. A bad operation leaves the document unchanged. Deletes create tombstones; callers must use an explicit restore operation to reuse a tombstoned ID.

`mutationId` deduplicates retries. The SDK exposes the same operation union through `canvases.applyOperations()`, MCP exposes `apply_canvas_operations`, and the CLI accepts JSON through `rtmd canvas-apply`. Existing SDK node and edge helpers try the batch endpoint first, then use the older route only when a server returns 404.

## Attachments and diagnostics

File nodes pass through `VaultSync.canvasBinaryPaths()` before priority changes. Markdown, Canvas, Base, excluded, and disabled paths never enter binary sync. Missing indexed binaries move ahead of background transfers; repeated Canvas saves don't schedule repeated hashing.

Enable diagnostic logging in Realtime's advanced settings to inspect local operation counts, incremental applications, full-import fallbacks, deferred remote updates, and presence cleanup. Server logs include failed Canvas operation batches with their vault and path.
