import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The dashboard. `npm run dev:web` proxies /api to a running Handrail;
// `npm run build:web` writes web/dist, which Handrail serves at /.
export default defineConfig({
  root: dirname(fileURLToPath(import.meta.url)),
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/api": `http://127.0.0.1:${process.env.PORT || 8787}` },
  },
  // AG Grid's core is ~1 MB minified (300 kB gzipped); fine for an admin dashboard.
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 1200 },
});
