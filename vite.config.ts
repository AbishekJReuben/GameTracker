import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { readFileSync } from "node:fs";

// App version, read from package.json (kept in sync by scripts/bump-version.ps1)
// and exposed to the frontend as __APP_VERSION__ so the UI's version labels and
// the title bar always reflect the real build version.
const pkg = JSON.parse(readFileSync(path.resolve(__dirname, "package.json"), "utf-8")) as {
  version: string;
};

// Tauri expects a fixed dev port and ignores src-tauri while watching.
// Tailwind v4 runs through its first-party Vite plugin (no PostCSS config needed).
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    target: "esnext",
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      // Three entry points: the desktop app (index.html), the phone companion
      // (companion.html, shipped by the companion Tauri Android app), and the
      // Meta Quest client (quest.html — also built standalone for the signaling
      // server by vite.quest.config.ts; see npm run quest:build).
      input: {
        main: path.resolve(__dirname, "index.html"),
        companion: path.resolve(__dirname, "companion.html"),
        quest: path.resolve(__dirname, "quest.html"),
      },
    },
  },
}));
