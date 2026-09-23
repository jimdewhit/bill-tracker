import { readFileSync } from "fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url)));

export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss()],
  // Baked into the bundle at build time so the running app can show its own
  // version and compare it against the version-manifest gist (see the About
  // section in Settings) without depending on anything at runtime.
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
});
