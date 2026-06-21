# Repository Guidelines

## Project Layout

- `src/` contains the Obsidian plugin client. The main entry point is `src/main.ts`; editor bindings live under `src/editor/`; plugin database sync lives under `src/pluginDb/`; history UI and binary/text conflict UI are split into focused modules.
- `server/` contains the Rust auth/API server, y-sweet proxy integration, blob storage, OAuth/MCP support, and integration tests.
- `packages/sdk/` contains the TypeScript SDK and its unit/e2e tests.
- `packages/cli/`, `packages/web/`, and `packages/plugin-api-types/` are workspace packages used by the CLI, read-only web viewer, and public plugin API types.
- `tests/` contains plugin unit/e2e support for the Obsidian plugin.
- Generated build artifacts such as `main.js`, `styles.css`, `crsqlite.wasm`, `server/target/`, and package `dist/` directories should not be hand-edited.

## Tooling

This repository is Bun-first for JavaScript/TypeScript tasks.

- Install dependencies with `bun install`.
- Run the plugin/watch build with `bun run dev`.
- Build production artifacts with `bun run build`.
- Run TypeScript checks with `bun run typecheck`.
- Format TypeScript with `bun run format` (`oxfmt`).
- Run the default JS test suite with `bun run test`.
- Run all configured unit suites with `bun run test:unit`.
- Run SDK tests with `bun run test:sdk`; run SDK e2e tests with `bun run test:sdk:e2e`.
- Run Rust server tests with `bun run test:server` or `cargo test --manifest-path server/Cargo.toml`.
- Run the full local validation path with `bun run test:all`.

Prefer targeted test commands while iterating, then run the broadest relevant suite before handing work back.

## Coding Conventions

- Use TypeScript for plugin, SDK, CLI, and web code; use Rust for server code.
- Keep formatting consistent with `oxfmt` for TypeScript and `rustfmt`/Cargo conventions for Rust.
- Prefer existing abstractions around Yjs documents, vault sync, blob storage, auth, and SDK HTTP resources rather than adding parallel implementations.
- Preserve offline-first and conflict-resolution behavior when touching sync paths. Be especially careful around first-write seeding, binary divergence handling, Yjs awareness, cr-sqlite replication, and server-side audit/git behavior.
- Avoid broad refactors across plugin/server/package boundaries unless the change explicitly requires it.
- Do not hand-edit generated OpenAPI/build outputs unless the generation path is unavailable and the user requested it.

## Testing Notes

- Vitest is configured with named projects: `plugin`, `sdk-unit`, `cli-unit`, `web-unit`, and `sdk-e2e`.
- Plugin tests run in `jsdom` with the Obsidian mock from `tests/support/obsidian-mock.ts`.
- Some tests spawn y-sweet or the Rust server and intentionally disable file parallelism. Avoid changing those settings unless you are addressing test infrastructure directly.
- Rust server tests use mock OIDC and hermetic test state; prefer adding focused integration coverage in `server/tests/` for API/auth/storage changes.

## Operational Notes

- The plugin expects one public auth/sync URL; the server reverse-proxies y-sweet under `/d/*`.
- Public REST/OAuth/API behavior is documented through the server OpenAPI setup and README files. Keep docs in sync when changing user-facing routes, configuration, SDK APIs, or plugin setup.
- Workspace packages are linked with Bun workspaces. Keep version and package boundary changes deliberate.
