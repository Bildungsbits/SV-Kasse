import { defineConfig } from "vite";
import preact from "@preact/preset-vite";

export default defineConfig({
  root: "web",
  publicDir: "../public",
  plugins: [preact()],
  // Neue App-Version = neue Kennung: der Service Worker legt dann einen frischen Speicher an
  define: { __BUILD_ID__: JSON.stringify(Date.now().toString(36)) },
  build: { outDir: "../dist", emptyOutDir: true },
  server: { proxy: { "/api": "http://localhost:8787" } },
});
