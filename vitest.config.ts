import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

// Deliberately does NOT load the React Router Vite plugin: the tests in this
// slice exercise server-side modules (config parsing, the connection pool's
// type-parser overrides) and the plugin's route/manifest generation only gets
// in the way.
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    // Integration tests share one Postgres; keep them off each other's toes.
    fileParallelism: false,
  },
});
