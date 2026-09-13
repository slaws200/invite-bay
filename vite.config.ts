import { defineConfig } from "vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";

export default defineConfig({
  plugins: [
    nodePolyfills({
      include: ["buffer", "process", "util", "stream", "events", "path", "os"],
      globals: {
        Buffer: true,
        global: true,
        process: true,
      },
    }),
  ],
  server: {
    port: 5173,
    host: true,
  },
  build: {
    target: "es2022",
    sourcemap: true,
  },
  optimizeDeps: {
    include: ["telegram", "buffer"],
  },
});
