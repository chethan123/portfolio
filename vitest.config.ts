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
    // A loader that reads configuration — the market timezone the as-of caption
    // renders in — calls `getConfig()`, which validates the whole environment
    // and refuses without a `DATABASE_URL`. Tests never connect through it:
    // `withDatabase` puts a transaction in async storage and `getDb()` finds it
    // there. Pointing it at the same throwaway Postgres the suite already uses
    // keeps the one variable config demands truthful rather than invented.
    env: {
      DATABASE_URL:
        process.env.TEST_DATABASE_URL ??
        "postgres://portfolio:portfolio@127.0.0.1:55432/portfolio_test",
    },
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
