/**
 * Startup migration step: entrypoint runs this to completion before starting
 * the server (DESIGN.md §10.1), so requests never hit a half-migrated schema.
 * Runs directly under Node's type stripping: `node ./server/migrate.ts`.
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
