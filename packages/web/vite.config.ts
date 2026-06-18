import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The Rust server serves the build output at /view/{share_id} with assets
// under /view/assets/, so all asset URLs must be rooted at /view/.
export default defineConfig({
  base: "/view/",
  plugins: [react()],
  server: {
    // Dev workflow: `cargo run` the server (default 127.0.0.1:8081), then
    // open http://localhost:5173/view/<share_id> here.
    proxy: {
      "/api": "http://127.0.0.1:8081",
    },
  },
});
