import { fileURLToPath } from "node:url";

import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";

export default defineConfig({
  resolve: {
    // Restates tsconfig's one alias (`~/*` -> `./app/*`) because Vite does
    // not read tsconfig `paths`. `vite-tsconfig-paths` used to do this —
    // dropped: three packages plus a deprecated parser (`tsconfck`) for one
    // mapping.
    alias: [
      { find: /^~\//, replacement: fileURLToPath(new URL("./app/", import.meta.url)) },
    ],
  },
  plugins: [reactRouter()],
});
