import path from "path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 5173,
    headers: {
      "Cache-Control": "no-cache",
    },
    fs: {
      allow: [path.resolve(__dirname, "..")],
    },
    proxy: {
      // Standalone-frontend diagnostics proxy to the TS Application Host
      // (Phase 8: the legacy FastAPI 8000 target is retired).
      "/api": {
        target: process.env.VITE_BACKEND_TARGET ?? "http://127.0.0.1:5173",
        changeOrigin: true,
      },
      "/api/v1/ws": {
        target: (process.env.VITE_BACKEND_TARGET ?? "http://127.0.0.1:5173")
          .replace(/^http/, "ws"),
        ws: true,
        changeOrigin: true,
      },
    },
  },
});
