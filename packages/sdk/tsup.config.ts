import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/node.ts"],
  format: ["esm", "cjs"],
  dts: true,
  target: "es2020",
  // Optional runtime fallback for Node 20 (no global WebSocket); never bundle it.
  external: ["ws"],
  sourcemap: true,
  clean: true,
});
