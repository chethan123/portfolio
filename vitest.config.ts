import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

// No React Router Vite plugin: its route/manifest generation only gets in the way.
export default defineConfig({
  resolve: {
    // In step with `vite.config.ts`.
    alias: [
      { find: /^~\//, replacement: fileURLToPath(new URL("./app/", import.meta.url)) },
    ],
  },
  test: {
    environment: "node",
    // `getConfig()` refuses without both, so every test reaching it needs them.
    // Nothing connects through DATABASE_URL — `withDatabase` puts a transaction in
    // async storage — it points at the throwaway Postgres to keep the demanded
    // variable truthful. `https://` because WebAuthn needs a secure context.
    env: {
      DATABASE_URL:
        process.env.TEST_DATABASE_URL ??
        "postgres://portfolio:portfolio@127.0.0.1:55432/portfolio_test",
      PUBLIC_ORIGIN: "https://portfolio.local",
    },
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    // Integration tests share one Postgres.
    fileParallelism: false,
    // No CI gate and no threshold on purpose: the useful reading is which files
    // are dark, not the total.
    coverage: {
      include: ["app/**", "server/**"],
      exclude: ["app/lib/database.generated.ts"],
    },
  },
});
