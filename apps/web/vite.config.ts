import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The hub serves /ws on HUB_PORT (default 8787). Proxy it so the browser stays same-origin.
const hubPort = process.env.HUB_PORT ?? "8787";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/ws": { target: `ws://127.0.0.1:${hubPort}`, ws: true },
    },
  },
});
