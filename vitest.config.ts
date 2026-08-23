import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

// Deliberately does NOT load the React Router Vite plugin: the tests in this
// slice exercise server-side modules (config parsing, the connection pool's
// type-parser overrides) and the plugin's route/manifest generation only gets
// in the way.
export default defineConfig({
  resolve: {
    // Kept in step with `vite.config.ts` — see the note there on why the alias
    // is written out rather than read from `tsconfig.json`.
    alias: [
      { find: /^~\//, replacement: fileURLToPath(new URL("./app/", import.meta.url)) },
    ],
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    // Integration tests share one Postgres; keep them off each other's toes.
    fileParallelism: false,
  },
});
