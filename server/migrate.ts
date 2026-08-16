/**
 * The migration step of the startup sequence.
 *
 * The container entrypoint runs this to completion and only then starts the
 * server — not concurrently, and not as a separate one-shot service
 * (DESIGN.md §10.1). Serving requests against a half-migrated schema is the
 * failure that ordering prevents, and a non-zero exit here is what stops the
 * server from starting at all.
 *
 * Run directly under Node 24's type stripping — no build step for operational
 * scripts (DESIGN.md §9):
 *
 *   node ./server/migrate.ts
 *
 * It reads `DATABASE_URL` from the environment, like everything else, and is
 * safe to run against an already-migrated database: applied filenames are
 * recorded, so a re-run skips them and exits 0.
 */
import { ConfigError, loadConfig } from "./config.ts";
import { createPool } from "./db.ts";
import { applyPendingMigrations, migrationsDirectory } from "./migrations.ts";

async function main(): Promise<void> {
  const { DATABASE_URL } = loadConfig(process.env);
  const directory = migrationsDirectory();

  console.log(`Applying migrations from ${directory}`);

  const pool = createPool(DATABASE_URL);
  try {
    const applied = await applyPendingMigrations(pool, directory, (line) => console.log(line));
    console.log(
      applied.length === 0
        ? "Migrations OK — nothing pending."
        : `Migrations OK — applied ${applied.length}.`,
    );
  } finally {
    await pool.end();
  }
}

try {
  await main();
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(error.message);
  } else {
    console.error("Migrations failed. The server will not be started.");
    console.error(error);
  }
  process.exit(1);
}
