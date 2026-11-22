import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  root: path.resolve("client"),
  publicDir: path.resolve("public"),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve("client/src"),
    },
  },
  build: {
    outDir: path.resolve("dist"),
    emptyOutDir: true,
    sourcemap: false,
    target: "es2022",
  },
  server: {
    port: 20127,
    proxy: {
      "/api": "http://127.0.0.1:20128",
      "/v1": "http://127.0.0.1:20128",
      "/v1beta": "http://127.0.0.1:20128",
    },
  },
});
