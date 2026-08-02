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
    host: true,
    port: 5173,
    headers: {
      "Cache-Control": "no-cache",
    },
    fs: {
      allow: [path.resolve(__dirname, "..")],
    },
    proxy: {
      "/api": {
        target: process.env.VITE_BACKEND_TARGET ?? "http://127.0.0.1:8000",
        changeOrigin: true,
      },
      "/api/v1/ws": {
        target: (process.env.VITE_BACKEND_TARGET ?? "http://127.0.0.1:8000")
          .replace(/^http/, "ws"),
        ws: true,
        changeOrigin: true,
      },
    },
  },
});
