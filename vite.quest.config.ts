import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { readFileSync } from "node:fs";

// Standalone build of the Meta Quest client (quest.html only), emitted into
// signaling/static so the signaling server can host it over the Cloudflare
// Tunnel at https://discovery.chilloutgamestudio.com/quest. HTTPS matters:
// WebXR (`navigator.xr`) only exists in secure contexts, so the immersive mode
// works when served from here but not from the desktop's plain-http LAN server.
//
// Build with: npm run quest:build

const pkg = JSON.parse(readFileSync(path.resolve(__dirname, "package.json"), "utf-8")) as {
  version: string;
};

export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  clearScreen: false,
  build: {
    target: "esnext",
    outDir: path.resolve(__dirname, "signaling/static"),
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      input: {
        quest: path.resolve(__dirname, "quest.html"),
      },
    },
  },
}));
