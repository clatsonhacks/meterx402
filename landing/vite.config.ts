import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The landing page builds into the hub's public folder: the hub serves
// public/landing/index.html at "/" and the existing app at "/app".
export default defineConfig({
  base: "/landing/",
  plugins: [react()],
  build: {
    outDir: "../public/landing",
    emptyOutDir: true,
    chunkSizeWarningLimit: 1100,
  },
  server: {
    port: 5173,
    // in dev, live data and the app still come from the hub
    proxy: {
      "/registry": "http://127.0.0.1:4021",
      "/app": "http://127.0.0.1:4021",
    },
  },
});
