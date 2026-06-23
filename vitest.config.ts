import { defineConfig } from "vitest/config";
import * as path from "path";

export default defineConfig({
  // Pin the root; otherwise vitest can auto-discover a stray vite config under
  // references/ and run from the wrong directory.
  root: __dirname,
  test: {
    projects: [
      {
        test: {
          name: "plugin",
          environment: "jsdom",
          setupFiles: ["./tests/support/setup.ts"],
          include: ["tests/unit/**/*.test.{ts,tsx}"],
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
      },
      {
        test: {
          name: "sdk-unit",
          environment: "node",
          include: ["packages/sdk/tests/unit/**/*.test.ts"],
          testTimeout: 30_000,
        },
      },
      {
        test: {
          name: "cli-unit",
          environment: "node",
          include: ["packages/cli/tests/unit/**/*.test.ts"],
          testTimeout: 30_000,
        },
      },
      {
        test: {
          name: "web-unit",
          environment: "node",
          include: ["packages/web/tests/unit/**/*.test.{ts,tsx}"],
          testTimeout: 30_000,
        },
      },
      {
        test: {
          name: "sdk-e2e",
          environment: "node",
          include: ["packages/sdk/tests/e2e/**/*.test.ts"],
          testTimeout: 90_000,
          hookTimeout: 180_000,
          // The e2e harness spawns the Rust server + y-sweet per file.
          fileParallelism: false,
        },
      },
    ],
  },
});
