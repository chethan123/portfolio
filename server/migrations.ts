/**
 * Plain `.sql` files applied in filename order, each in a transaction, applied
 * filenames recorded in `schema_migrations`. No schema DSL, nothing to compile
 * — the database is the source of truth (DESIGN.md §9) — and re-runs skip
 * what is recorded, which is what makes container restarts always safe.
 * `server/migrate.ts` is the CLI; `/healthz` reads {@link pendingMigrations}.
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import type { Pool, PoolClient } from "pg";

/** The ledger. Created by the runner, since it must exist before anything else. */
export const MIGRATIONS_TABLE = "schema_migrations";

/**
 * Resolved from cwd (repo root, `/app` in the container): `import.meta.url`
 * would not survive Vite bundling the app half of this into `build/server`.
 */
export function migrationsDirectory(): string {
  return path.resolve(process.cwd(), "migrations");
}

/**
 * Guards two runners racing on a cold start — single-instance makes that
 * unlikely, not impossible (a restart can overlap a still-stopping container).
 * The number is arbitrary but must not change.
 */
const ADVISORY_LOCK_KEY = "7295380114023641";

/** `42P01 undefined_table` — the ledger has never been created. */
const UNDEFINED_TABLE = "42P01";

const isUndefinedTable = (error: unknown): boolean =>
  typeof error === "object" && error !== null && (error as { code?: string }).code === UNDEFINED_TABLE;

/** Apply order: filenames compared as plain strings — hence the zero-padded prefixes. */
export async function migrationsOnDisk(directory: string = migrationsDirectory()): Promise<string[]> {
  const entries = await readdir(directory);
  return entries.filter((entry) => entry.endsWith(".sql")).sort();
}

/**
 * A missing ledger reads as "nothing applied" rather than an error, so
 * `/healthz` on an unmigrated database reports pending migrations, not a
 * stack trace.
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
 * On disk but not recorded. Empty is the definition of "the schema is
 * current"; non-empty makes `/healthz` non-200 — image and database disagree,
 * the exact state the startup ordering exists to keep requests away from.
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
 * A failure rolls that migration back whole and rethrows with its filename off
 * the ledger, so the next run retries it from clean rather than resuming
 * halfway. The CLI turns the rethrow into the non-zero exit that stops the
 * entrypoint from starting the server.
 *
 * @returns filenames applied by this call, in order; empty on a normal restart.
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

    // Re-read after the lock: a runner we queued behind may have applied some.
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
        // One simple-protocol query, so a file may hold many statements — all
        // of them plus the ledger row commit or roll back together.
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
