import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { readFileSync } from "node:fs";

// Discovery static build: companion (mobile browser) + quest (headset) into
// signaling/static so the signaling server can host both over the Cloudflare
// Tunnel. HTTPS matters for Quest: WebXR (`navigator.xr`) only exists in
// secure contexts.
//
// Build with: npm run quest:build  (or discovery:build)

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
        companion: path.resolve(__dirname, "companion.html"),
        quest: path.resolve(__dirname, "quest.html"),
      },
    },
  },
}));
