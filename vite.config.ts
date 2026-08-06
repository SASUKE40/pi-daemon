import { defineConfig } from "vite";

export default defineConfig({
  root: "web",
  publicDir: "static",
  build: {
    outDir: "../public",
    emptyOutDir: true,
  },
});
