import { sql } from "kysely";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabase, type Database } from "~/lib/db.server";
import type { Kysely } from "kysely";

/**
 * The regression these tests exist for: `node-postgres` parses `numeric` into a
 * JavaScript number by default, which silently rounds. Asserting on strings is
 * the point — `toBeCloseTo` would hide exactly the bug being guarded against.
 *
 * Requires a real Postgres. See `compose.test.yaml`:
 *   docker compose -f compose.test.yaml up -d
 */
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://portfolio:portfolio@127.0.0.1:55432/portfolio_test";

describe("numeric type parsing", () => {
  it("registers a string parser for numeric globally, not per query", () => {
    // 1700 is `numeric`. Any pool anywhere in the process inherits this.
    expect(pg.types.getTypeParser(pg.types.builtins.NUMERIC)("12345.6789")).toBe("12345.6789");
  });

  it("registers a string parser for int8", () => {
    expect(pg.types.getTypeParser(pg.types.builtins.INT8)("9007199254740993")).toBe(
      "9007199254740993",
    );
  });
});

describe("numeric values crossing the database boundary", () => {
  let db: Kysely<Database>;

  beforeAll(async () => {
    db = createDatabase(TEST_DATABASE_URL);
    try {
      await sql`select 1`.execute(db);
    } catch (cause) {
      throw new Error(
        `Cannot reach the test database at ${TEST_DATABASE_URL}.\n` +
          "Start it with: docker compose -f compose.test.yaml up -d\n" +
          "or point TEST_DATABASE_URL at your own throwaway Postgres.",
        { cause },
      );
    }
  });

  afterAll(async () => {
    await db?.destroy();
  });

  it("returns a numeric as a decimal string at full scale, not as a number", async () => {
    const result = await sql<{ amount: string }>`
      select cast('12345.6789' as numeric(20, 4)) as amount
    `.execute(db);

    const amount = result.rows[0]?.amount;

    expect(typeof amount).toBe("string");
    expect(amount).toBe("12345.6789");
  });

  it("preserves trailing zeros, which a number cannot carry", async () => {
    const result = await sql<{ amount: string }>`
      select cast('25000' as numeric(20, 4)) as amount
    `.execute(db);

    // Stored scale is 4, so the string is '25000.0000'. Number would give 25000.
    expect(result.rows[0]?.amount).toBe("25000.0000");
  });

  it("preserves a value large enough that float coercion would round it", async () => {
    const enormous = "123456789012345678.87654321";

    const result = await sql<{ amount: string }>`
      select cast(${enormous} as numeric(38, 8)) as amount
    `.execute(db);

    expect(result.rows[0]?.amount).toBe("123456789012345678.87654321");
    // Proof the guard is load-bearing rather than decorative.
    expect(String(Number(enormous))).not.toBe(enormous);
  });

  it("preserves a fractional-share quantity at full scale", async () => {
    const result = await sql<{ quantity: string }>`
      select cast('0.0000000001' as numeric(28, 10)) as quantity
    `.execute(db);

    expect(result.rows[0]?.quantity).toBe("0.0000000001");
  });

  it("preserves a negative quantity, which is how a liability is encoded", async () => {
    const result = await sql<{ quantity: string }>`
      select cast('-412000.0000' as numeric(20, 4)) as quantity
    `.execute(db);

    expect(result.rows[0]?.quantity).toBe("-412000.0000");
  });

  it("keeps a numeric a string through a round trip into a real column", async () => {
    // In one transaction so the temporary table and the read share a connection.
    const amount = await db.transaction().execute(async (trx) => {
      await sql`
        create temporary table numeric_round_trip (amount numeric(20, 4) not null)
        on commit drop
      `.execute(trx);
      await sql`insert into numeric_round_trip (amount) values ('12345.6789')`.execute(trx);

      const result = await sql<{ amount: string }>`
        select amount from numeric_round_trip
      `.execute(trx);

      return result.rows[0]?.amount;
    });

    expect(amount).toBe("12345.6789");
  });

  it("returns count(*), an int8, as a string", async () => {
    const result = await sql<{ total: string }>`select count(*) as total from (select 1) t`.execute(
      db,
    );

    expect(result.rows[0]?.total).toBe("1");
  });

  it("connects with the session time zone set to UTC", async () => {
    const result = await sql<{ zone: string }>`
      select current_setting('TimeZone') as zone
    `.execute(db);

    expect(result.rows[0]?.zone).toBe("UTC");
  });
});
