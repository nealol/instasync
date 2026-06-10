// The cr-sqlite WASM, inlined by esbuild's `dataurl` loader (see
// esbuild.config.mjs) as a `data:application/octet-stream;base64,…` URL. This is
// handed to cr-sqlite's `locateFile` so the WASM loads with no separate asset,
// download, or filesystem access — working identically on desktop, mobile, BRAT,
// manual installs, and the e2e harness.
//
// Imported only by obsidianDeps (the real plugin runtime); test environments
// inject their own locate function and never load this module.
import wasmDataUrl from "@vlcn.io/crsqlite-wasm/crsqlite.wasm";

export const CRSQLITE_WASM_DATA_URL: string = wasmDataUrl;
