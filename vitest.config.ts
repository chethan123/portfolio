import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

// Deliberately does NOT load the React Router Vite plugin: the plugin's
// route/manifest generation only gets in the way.
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
    // Read with `npm run test:coverage`. Deliberately not a CI gate and
    // deliberately without a threshold: a percentage that fails a build is how
    // a suite acquires tests written for the number rather than for a rule.
    // The useful reading is which *files* are dark, not what the total says.
    coverage: {
      include: ["app/**", "server/**"],
      // Generated from the live database by `npm run db:types`; there is
      // nothing here anyone wrote.
      exclude: ["app/lib/database.generated.ts"],
    },
  },
});
