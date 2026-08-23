import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabase, type Database } from "~/lib/db.server";
import { createPool } from "../server/db.ts";
import {
  MIGRATIONS_TABLE,
  appliedMigrations,
  applyPendingMigrations,
  migrationsOnDisk,
  pendingMigrations,
} from "../server/migrations.ts";

import type { Kysely } from "kysely";
import type { Pool } from "pg";

/**
 * The schema and the runner that creates it, against a real Postgres.
 *
 * Requires one. See `compose.test.yaml`:
 *   docker compose -f compose.test.yaml up -d --wait
 *
 * Every test that writes does so inside a transaction it rolls back, so the
 * suite leaves the database exactly as it found it and ordering never matters.
 */
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://portfolio:portfolio@127.0.0.1:55432/portfolio_test";

let pool: Pool;
let db: Kysely<Database>;

/** Run a statement and return the Postgres error code it raised, or null. */
async function errorCodeFrom(statements: string): Promise<string | null> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(statements);
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? "unknown";
  } finally {
    await client.query("rollback").catch(() => {});
    client.release();
  }
}

/**
 * Run statements in a transaction that is always rolled back, returning the
 * rows the last one produced. Lets a test read back what the schema stored
 * without leaving anything behind.
 */
async function rowsFromRolledBack<Row extends Record<string, unknown>>(
  statements: string,
): Promise<Row[]> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const results = await client.query<Row>(statements);
    const last = Array.isArray(results) ? results[results.length - 1] : results;
    return last?.rows ?? [];
  } finally {
    await client.query("rollback").catch(() => {});
    client.release();
  }
}

/** A person, an account and an empty position set to hang holdings off. */
const A_POSITION_SET = `
  insert into person (name) values ('Test Owner');
  insert into account (name, institution, kind, owner_id, tax_treatment)
    select 'Test Account', 'Test Institution', 'brokerage', id, 'taxable'
    from person where name = 'Test Owner';
  insert into position_set (account_id, as_of_date, source)
    select id, date '2026-01-31', 'upload' from account where name = 'Test Account';
`;

beforeAll(async () => {
  pool = createPool(TEST_DATABASE_URL);
  db = createDatabase(TEST_DATABASE_URL);

  try {
    await sql`select 1`.execute(db);
  } catch (cause) {
    throw new Error(
      `Cannot reach the test database at ${TEST_DATABASE_URL}.\n` +
        "Start it with: docker compose -f compose.test.yaml up -d --wait\n" +
        "or point TEST_DATABASE_URL at your own throwaway Postgres.",
      { cause },
    );
  }

  await applyPendingMigrations(pool);
});

afterAll(async () => {
  await db?.destroy();
  await pool?.end();
});

describe("the migration runner", () => {
  it("records every migration on disk as applied", async () => {
    const onDisk = await migrationsOnDisk();

    expect(onDisk.length).toBeGreaterThan(0);
    expect(await pendingMigrations(pool)).toEqual([]);
  });

  it("applies nothing on a second run, so a restart is always safe", async () => {
    expect(await applyPendingMigrations(pool)).toEqual([]);
  });

  // Titled for what it actually asserts. `migrationsOnDisk` ends in `.sort()`,
  // so this pins that sort and fails if it is dropped — but nothing here
  // applies anything, so it is not evidence about apply order.
  it("lists migrations in filename order", async () => {
    const onDisk = await migrationsOnDisk();

    expect(onDisk).toEqual([...onDisk].sort());
  });

  it("reports a migration on disk that the database has no record of", async () => {
    // The predicate /healthz turns into a non-200. Every table can be present
    // and the schema still be out of date, because what "out of date" means is
    // that the image carries a migration the database has never seen.
    const directory = await mkdtemp(path.join(tmpdir(), "portfolio-migrations-"));
    try {
      for (const applied of await migrationsOnDisk()) {
        await writeFile(path.join(directory, applied), "");
      }
      await writeFile(path.join(directory, "9999_not_applied_yet.sql"), "select 1;");

      expect(await pendingMigrations(pool, directory)).toEqual(["9999_not_applied_yet.sql"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("leaves nothing behind when a migration fails, so the next run retries it from a clean database", async () => {
    // The only path in the system that can leave a deployed database half
    // migrated. A file is many statements in one transaction, and the ledger
    // row commits with them — if a failure left the DDL that ran before it, or
    // recorded the filename anyway, the next boot would skip the migration and
    // serve requests against a schema nobody can name. Both halves are silent:
    // the operator sees one failed deploy, then a successful one.
    const directory = await mkdtemp(path.join(tmpdir(), "portfolio-migrations-"));
    const filename = "9999_partly_applied.sql";
    const table = "migration_rollback_probe";

    const tableExists = async (): Promise<boolean> => {
      const result = await pool.query<{ present: boolean }>(
        "select to_regclass($1) is not null as present",
        [table],
      );
      return result.rows[0]?.present ?? false;
    };

    try {
      // A statement that works followed by one that does not, which is the
      // shape a real broken migration has — a typo below a valid `create`.
      await writeFile(
        path.join(directory, filename),
        `create table ${table} (id bigint primary key);\nselect no_such_function();`,
      );

      await expect(applyPendingMigrations(pool, directory)).rejects.toThrow(filename);

      // The CLI turns that rethrow into a non-zero exit, which is what stops
      // the entrypoint from starting the server against this database.
      expect(await appliedMigrations(pool)).not.toContain(filename);
      expect(await tableExists()).toBe(false);

      await writeFile(path.join(directory, filename), `create table ${table} (id bigint primary key);`);

      // Retried rather than resumed: the same filename, applied whole.
      expect(await applyPendingMigrations(pool, directory)).toEqual([filename]);
      expect(await tableExists()).toBe(true);
    } finally {
      // The one test here that commits, since a migration runner opens its own
      // transactions and cannot be wrapped in one.
      await pool.query(`drop table if exists ${table}`);
      await pool.query(`delete from ${MIGRATIONS_TABLE} where filename = $1`, [filename]);
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("the seeded cash rows", () => {
  it("seeds a Cash classification rolling up to the cash asset class", async () => {
    const result = await sql<{ name: string; asset_class: string }>`
      select name, asset_class from classification where name = 'Cash'
    `.execute(db);

    expect(result.rows).toEqual([{ name: "Cash", asset_class: "cash" }]);
  });

  it("seeds a USD instrument with a fixed price source, classified as Cash", async () => {
    const result = await sql<{
      symbol: string;
      price_source: string;
      classification: string;
    }>`
      select i.symbol, i.price_source, c.name as classification
      from instrument i
      join classification c on c.id = i.classification_id
      where i.symbol = 'USD'
    `.execute(db);

    expect(result.rows).toEqual([
      { symbol: "USD", price_source: "fixed", classification: "Cash" },
    ]);
  });

  it("seeds a USD quote at 1.00", async () => {
    const result = await sql<{ price: string; is_stale: boolean }>`
      select q.price, q.is_stale
      from quote q join instrument i on i.id = q.instrument_id
      where i.symbol = 'USD'
    `.execute(db);

    expect(result.rows).toEqual([{ price: "1.0000", is_stale: false }]);
  });

  it("seeds a USD daily close at 1970-01-01, which is what makes carry-forward resolve cash for every date", async () => {
    // Load-bearing: because the as-of function carries forward the last close,
    // this single far-past row prices USD at 1.00 on every date the system will
    // ever be asked about — including a statement dated before install. It is
    // why there is no branch for cash anywhere.
    const result = await sql<{ date: string; close: string }>`
      select to_char(p.date, 'YYYY-MM-DD') as date, p.close
      from price_daily p join instrument i on i.id = p.instrument_id
      where i.symbol = 'USD'
    `.execute(db);

    expect(result.rows).toEqual([{ date: "1970-01-01", close: "1.0000" }]);
  });
});

describe("the schema's refusals", () => {
  it("refuses to delete a person who still owns accounts", async () => {
    const code = await errorCodeFrom(`
      insert into person (name) values ('Alice');
      insert into account (name, institution, kind, owner_id, tax_treatment)
        select 'Fidelity Taxable', 'Fidelity', 'brokerage', id, 'taxable'
        from person where name = 'Alice';
      delete from person where name = 'Alice';
    `);

    // 23503 foreign_key_violation — RESTRICT, not CASCADE: the portfolio is not
    // silently destroyed and the owner is not silently orphaned.
    expect(code).toBe("23503");
  });

  it("allows deleting a person who owns nothing", async () => {
    expect(
      await errorCodeFrom(`
        insert into person (name) values ('Nobody');
        delete from person where name = 'Nobody';
      `),
    ).toBeNull();
  });

  it("rejects an account kind outside the allowed set", async () => {
    expect(
      await errorCodeFrom(`
        insert into person (name) values ('Bob');
        insert into account (name, institution, kind, owner_id, tax_treatment)
          select 'X', 'Y', 'crypto_exchange', id, 'taxable' from person where name = 'Bob';
      `),
    ).toBe("23514");
  });

  it("rejects a tax treatment outside the three-way set", async () => {
    // The boolean this replaces would have thrown away the largest distinction
    // on the balance sheet.
    expect(
      await errorCodeFrom(`
        insert into person (name) values ('Bob');
        insert into account (name, institution, kind, owner_id, tax_treatment)
          select 'X', 'Y', 'ira', id, 'sheltered' from person where name = 'Bob';
      `),
    ).toBe("23514");
  });

  it("accepts each of the three tax treatments", async () => {
    expect(
      await errorCodeFrom(`
        insert into person (name) values ('Bob');
        insert into account (name, institution, kind, owner_id, tax_treatment)
          select 'A', 'Y', 'brokerage', id, 'taxable' from person where name = 'Bob';
        insert into account (name, institution, kind, owner_id, tax_treatment)
          select 'B', 'Y', 'ira', id, 'tax_deferred' from person where name = 'Bob';
        insert into account (name, institution, kind, owner_id, tax_treatment)
          select 'C', 'Y', '401k', id, 'tax_free' from person where name = 'Bob';
      `),
    ).toBeNull();
  });

  it("rejects an asset class outside the fixed rollup set", async () => {
    expect(
      await errorCodeFrom(`insert into classification (name, asset_class) values ('NFTs', 'crypto')`),
    ).toBe("23514");
  });

  it("rejects a price source outside the allowed set", async () => {
    expect(
      await errorCodeFrom(`
        insert into instrument (symbol, name, price_source, classification_id)
          select 'X', 'X', 'psychic', id from classification where name = 'Cash';
      `),
    ).toBe("23514");
  });

  it("refuses a duplicate classification name", async () => {
    expect(
      await errorCodeFrom(`insert into classification (name, asset_class) values ('Cash', 'cash')`),
    ).toBe("23505");
  });

  it("refuses two rows for the same instrument in one position set", async () => {
    // A statement lists an instrument once; two rows is a parse fault, not data.
    expect(
      await errorCodeFrom(`
        insert into person (name) values ('Bob');
        insert into account (name, institution, kind, owner_id, tax_treatment)
          select 'A', 'Y', 'bank', id, 'taxable' from person where name = 'Bob';
        insert into position_set (account_id, as_of_date, source)
          select id, date '2026-01-31', 'manual' from account where name = 'A';
        insert into holding (position_set_id, instrument_id, quantity)
          select ps.id, i.id, 1 from position_set ps, instrument i where i.symbol = 'USD';
        insert into holding (position_set_id, instrument_id, quantity)
          select ps.id, i.id, 2 from position_set ps, instrument i where i.symbol = 'USD';
      `),
    ).toBe("23505");
  });

  it("refuses a second row of settings", async () => {
    // 23505 unique_violation, off the boolean primary key constrained to true:
    // "which row is the settings" is a question the schema does not allow to
    // have two answers.
    expect(await errorCodeFrom(`insert into app_setting default values;`)).toBe("23505");
  });

  it("refuses a capital gains rate outside 0 to 100", async () => {
    // 23514 check_violation. A negative rate is not a rate, and a rate above
    // 100% would report a tax larger than the gain it is on.
    expect(
      await errorCodeFrom(`update app_setting set capital_gains_rate = -1;`),
    ).toBe("23514");
    expect(
      await errorCodeFrom(`update app_setting set capital_gains_rate = 100.000001;`),
    ).toBe("23514");
  });

  // Not a refusal, and deliberately here anyway: a check constraint is only
  // as good as the values it lets through, and the pair reads as one rule.
  it("allows the ends of that range", async () => {
    expect(
      await errorCodeFrom(`update app_setting set capital_gains_rate = 0;`),
    ).toBeNull();
    expect(
      await errorCodeFrom(`update app_setting set capital_gains_rate = 100;`),
    ).toBeNull();
  });
});

describe("the schema's nullability", () => {
  it("leaves cost basis per share null rather than defaulting it to zero", async () => {
    // Defaulting it would report a fake gain equal to the entire untracked
    // position, which is the one thing this column must never do. 401k
    // statements omit it routinely, so this path is the common case.
    const rows = await rowsFromRolledBack<{ cost_basis_per_share: string | null }>(`
      ${A_POSITION_SET}
      insert into holding (position_set_id, instrument_id, quantity)
        select ps.id, i.id, '12.34567890'
        from position_set ps, instrument i where i.symbol = 'USD'
      returning cost_basis_per_share;
    `);

    expect(rows).toEqual([{ cost_basis_per_share: null }]);
  });

  it("accepts a position set with no retained file and no filename", async () => {
    expect(
      await errorCodeFrom(`
        insert into person (name) values ('Dave');
        insert into account (name, institution, kind, owner_id, tax_treatment)
          select 'Checking', 'Bank', 'bank', id, 'taxable' from person where name = 'Dave';
        insert into position_set (account_id, as_of_date, source)
          select id, date '2026-01-31', 'manual' from account where name = 'Checking';
      `),
    ).toBeNull();
  });

  it("accepts an instrument with no symbol, which is how a workplace-plan trust is held", async () => {
    expect(
      await errorCodeFrom(`
        insert into instrument (symbol, name, price_source, classification_id)
          select null, 'Vanguard Target Retirement 2045 Trust II', 'manual', id
          from classification where name = 'Cash';
      `),
    ).toBeNull();
  });

  it("accepts a nullable closed_at, since closing preserves history", async () => {
    expect(
      await errorCodeFrom(`
        insert into person (name) values ('Erin');
        insert into account (name, institution, kind, owner_id, tax_treatment, closed_at)
          select 'Old', 'Bank', 'bank', id, 'taxable', now() from person where name = 'Erin';
      `),
    ).toBeNull();
  });
});

describe("the schema's numeric scales", () => {
  it("stores a quantity at eight decimal places and money at four, as decimal strings", async () => {
    const rows = await rowsFromRolledBack<{
      quantity: string;
      cost_basis_per_share: string;
    }>(`
      ${A_POSITION_SET}
      insert into holding (position_set_id, instrument_id, quantity, cost_basis_per_share)
        select ps.id, i.id, '0.12345678', '250.5'
        from position_set ps, instrument i where i.symbol = 'USD'
      returning quantity, cost_basis_per_share;
    `);

    // Trailing zeros a JavaScript number could not carry, at the stored scales.
    expect(rows).toEqual([{ quantity: "0.12345678", cost_basis_per_share: "250.5000" }]);
  });

  it("stores a negative quantity, which is how a liability is encoded", async () => {
    expect(
      await errorCodeFrom(`
        insert into person (name) values ('Gina');
        insert into account (name, institution, kind, owner_id, tax_treatment)
          select 'Loan', 'Private', 'liability', id, 'taxable' from person where name = 'Gina';
        insert into position_set (account_id, as_of_date, source)
          select id, date '2026-01-31', 'manual' from account where name = 'Loan';
        insert into holding (position_set_id, instrument_id, quantity)
          select ps.id, i.id, '-8000.00000000'
          from position_set ps, instrument i where i.symbol = 'USD';
      `),
    ).toBeNull();
  });
});

describe("instrument aliases", () => {
  it("matches the raw string case-sensitively, exactly as the brokerage wrote it", async () => {
    // 'CASH' and 'Cash' are two different strings, so they may point at
    // different instruments; a case-insensitive key would collide them.
    expect(
      await errorCodeFrom(`
        insert into instrument_alias (raw_string, instrument_id)
          select 'CASH', id from instrument where symbol = 'USD';
        insert into instrument_alias (raw_string, instrument_id)
          select 'Cash', id from instrument where symbol = 'USD';
      `),
    ).toBeNull();
  });

  it("refuses the same raw string twice, since it is the key", async () => {
    expect(
      await errorCodeFrom(`
        insert into instrument_alias (raw_string, instrument_id)
          select 'Cash & Cash Investments', id from instrument where symbol = 'USD';
        insert into instrument_alias (raw_string, instrument_id)
          select 'Cash & Cash Investments', id from instrument where symbol = 'USD';
      `),
    ).toBe("23505");
  });
});
