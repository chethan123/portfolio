/**
 * Startup migration step. The entrypoint runs this to completion and only
 * then starts the server (DESIGN.md §10.1) — a non-zero exit here is what
 * keeps requests off a half-migrated schema. Run directly under Node's type
 * stripping, no build step (DESIGN.md §9): `node ./server/migrate.ts`.
 * Re-runs skip recorded filenames and exit 0.
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
