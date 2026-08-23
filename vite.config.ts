import { fileURLToPath } from "node:url";

import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";

export default defineConfig({
  resolve: {
    // The one path alias `tsconfig.json` declares (`~/*` -> `./app/*`),
    // restated here because Vite does not read tsconfig `paths` itself. It
    // used to come from `vite-tsconfig-paths`, which is three packages and a
    // tsconfig parser deprecated as unmaintained (`tsconfck`) to keep one
    // mapping in one place instead of two.
    alias: [
      { find: /^~\//, replacement: fileURLToPath(new URL("./app/", import.meta.url)) },
    ],
  },
  plugins: [reactRouter()],
});
