import { defineConfig } from "vitest/config";
import * as path from "path";

export default defineConfig({
	// Pin the root; otherwise vitest can auto-discover a stray vite config under
	// references/ and run from the wrong directory.
	root: __dirname,
	test: {
		environment: "jsdom",
		setupFiles: ["./tests/support/setup.ts"],
		include: ["tests/unit/**/*.test.ts"],
		// Must comfortably exceed waitFor's 30s default (tests/support/util.ts):
		// when they were equal, a single stalled sync round-trip surfaced as an
		// opaque vitest "Test timed out" instead of the labeled waitFor error.
		testTimeout: 90_000,
		hookTimeout: 120_000,
		// One y-sweet server is spawned per test file; serialise files so we never
		// run a swarm of `npx y-sweet` processes (and to keep ports/logs sane).
		fileParallelism: false,
	},
	resolve: {
		alias: {
			// Let src/* import "obsidian" against our Node-friendly mock.
			obsidian: path.resolve(__dirname, "tests/support/obsidian-mock.ts"),
		},
	},
});
