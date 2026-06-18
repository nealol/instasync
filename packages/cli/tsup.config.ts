import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["esm"],
  target: "es2022",
  banner: { js: "#!/usr/bin/env node" },
  // Resolved at runtime from node_modules; the workspace SDK is bundled so a
  // published CLI tarball doesn't need the workspace protocol resolved.
  external: ["ws", "commander"],
  noExternal: ["@realtime-md/sdk"],
  sourcemap: true,
  clean: true,
});
