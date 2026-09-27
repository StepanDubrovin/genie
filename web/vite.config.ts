import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The UI is served by `genie web` from web/dist. During development run
// `genie web` (port 7420) and `npm run dev:web`; API calls are proxied to it.
export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true, sourcemap: true },
  server: { port: 5173, proxy: { "/api": { target: "http://127.0.0.1:7420", headers: { host: "127.0.0.1:7420" } } } },
});
