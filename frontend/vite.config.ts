// vite.config.ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 5000,
    allowedHosts: true,
  },
  resolve: {
    alias: {
      "@shared": path.resolve(__dirname, "../shared"),
      // The vendorable rules module. The lobby and the board renderer read the
      // per-unit-type configuration from the same file the engine does rather
      // than restating its defaults (functions/src/gameprocessors/engine).
      "@engine": path.resolve(__dirname, "../functions/src/gameprocessors/engine"),
    },
  },
});
