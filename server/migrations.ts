/**
 * Plain `.sql` files, applied in filename order, each inside a transaction,
 * with the applied filenames recorded in `schema_migrations`.
 *
 * The database is the source of truth (DESIGN.md §9), so there is no schema
 * DSL and nothing to compile: a migration is a file of SQL, and the record of
 * what ran is a table. Re-running skips what is already recorded, which is what
 * makes restarting the container always safe.
 *
 * This module is the shared part. `server/migrate.ts` is the CLI the entrypoint
 * runs; `/healthz` reads {@link pendingMigrations} to tell the truth about
 * whether the schema is current.
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import type { Pool, PoolClient } from "pg";

/** The ledger. Created by the runner, since it must exist before anything else. */
export const MIGRATIONS_TABLE = "schema_migrations";

/**
 * Where the `.sql` files live, resolved from the working directory.
 *
 * Both callers run with the repository root (or `/app` in the container) as
 * their working directory, and resolving from `import.meta.url` would not
 * survive Vite bundling the application half of this into `build/server`.
 */
export function migrationsDirectory(): string {
  return path.resolve(process.cwd(), "migrations");
}

/**
 * A guard against two runners racing on a cold start. Single-instance
 * deployment makes this unlikely rather than impossible — a restart can overlap
 * a still-shutting-down container — and the cost of holding it is one row in
 * `pg_locks`. The number is arbitrary but must not change.
 */
const ADVISORY_LOCK_KEY = "7295380114023641";

/** `42P01 undefined_table` — the ledger has never been created. */
const UNDEFINED_TABLE = "42P01";

const isUndefinedTable = (error: unknown): boolean =>
  typeof error === "object" && error !== null && (error as { code?: string }).code === UNDEFINED_TABLE;

/**
 * Every migration on disk, in the order it must be applied.
 *
 * Filename order, compared as plain strings — which is why the files are named
 * with a zero-padded numeric prefix.
 */
export async function migrationsOnDisk(directory: string = migrationsDirectory()): Promise<string[]> {
  const entries = await readdir(directory);
  return entries.filter((entry) => entry.endsWith(".sql")).sort();
}

/**
 * Every migration recorded as applied.
 *
 * A missing ledger reads as "nothing has been applied" rather than as an error,
 * so `/healthz` on an unmigrated database reports pending migrations instead of
 * a stack trace.
 */
export async function appliedMigrations(pool: Pool): Promise<string[]> {
  try {
    const result = await pool.query<{ filename: string }>(
      `select filename from ${MIGRATIONS_TABLE} order by filename`,
    );
    return result.rows.map((row) => row.filename);
  } catch (error) {
    if (isUndefinedTable(error)) return [];
    throw error;
  }
}

/**
 * Migrations present on disk but not recorded as applied.
 *
 * An empty array is the definition of "the schema is current". A non-empty one
 * is what makes `/healthz` return a non-200: the image and the database
 * disagree, and serving requests against that is the failure the startup
 * ordering exists to prevent.
 */
export async function pendingMigrations(
  pool: Pool,
  directory: string = migrationsDirectory(),
): Promise<string[]> {
  const [onDisk, applied] = await Promise.all([
    migrationsOnDisk(directory),
    appliedMigrations(pool),
  ]);
  const done = new Set(applied);
  return onDisk.filter((filename) => !done.has(filename));
}

async function createMigrationsTable(client: PoolClient): Promise<void> {
  await client.query(`
    create table if not exists ${MIGRATIONS_TABLE} (
      filename   text primary key,
      applied_at timestamptz not null default now()
    )
  `);
}

/**
 * Apply every pending migration, in order, each in its own transaction.
 *
 * A failure rolls that migration back whole and rethrows, leaving the ledger
 * without its filename — so the next run retries it from a clean state rather
 * than resuming halfway through. The caller (the CLI) turns the rethrow into a
 * non-zero exit, which is what stops the entrypoint from starting the server.
 *
 * @returns the filenames applied by this call, in order. Empty when there was
 *          nothing to do, which is the normal case on a restart.
 */
export async function applyPendingMigrations(
  pool: Pool,
  directory: string = migrationsDirectory(),
  log: (message: string) => void = () => {},
): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];

  try {
    await createMigrationsTable(client);
    // Session-level, so it spans the per-migration transactions below.
    await client.query(`select pg_advisory_lock(${ADVISORY_LOCK_KEY})`);

    // Re-read after taking the lock: a runner we queued behind may have applied
    // some of these while we waited.
    const recorded = new Set(
      (
        await client.query<{ filename: string }>(
          `select filename from ${MIGRATIONS_TABLE}`,
        )
      ).rows.map((row) => row.filename),
    );

    for (const filename of await migrationsOnDisk(directory)) {
      if (recorded.has(filename)) {
        log(`  skip    ${filename} (already applied)`);
        continue;
      }

      const statements = await readFile(path.join(directory, filename), "utf8");

      await client.query("begin");
      try {
        // A single simple-protocol query, so a file may contain many
        // statements. All of them, plus the ledger row, commit or roll back
        // together.
        await client.query(statements);
        await client.query(`insert into ${MIGRATIONS_TABLE} (filename) values ($1)`, [filename]);
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw new Error(`Migration ${filename} failed and was rolled back.`, { cause: error });
      }

      log(`  applied ${filename}`);
      applied.push(filename);
    }

    return applied;
  } finally {
    await client.query(`select pg_advisory_unlock(${ADVISORY_LOCK_KEY})`).catch(() => {});
    client.release();
  }
}
