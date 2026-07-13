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
  build: {
    rollupOptions: {
      // In CI, any Rollup warning (circular deps, eval, etc.) aborts the build.
      onwarn(warning, defaultHandler) {
        // Allow circular-dependency warnings that originate inside
        // node_modules -- these are third-party library internals we
        // cannot fix, not project code issues.
        if (
          process.env.CI &&
          warning.code === "CIRCULAR_DEPENDENCY" &&
          warning.message?.includes("node_modules")
        ) {
          return; // silently skip
        }
        // Allow chunk-size advisory warnings -- these are informational
        // hints about bundle size, not correctness issues. Without
        // manualChunks Vite auto-splits, which is sufficient for a
        // desktop app bundled by PyInstaller.
        if (
          process.env.CI &&
          warning.message?.includes("chunk size")
        ) {
          return;
        }
        if (process.env.CI) {
          throw new Error(`Build warning: ${warning.message}`);
        }
        defaultHandler(warning);
      },
    },
  },
});
