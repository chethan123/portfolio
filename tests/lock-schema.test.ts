/**
 * The lock's two tables (docs/adr/0012, docs/specs/lock/01-the-passkey-and-
 * the-grant.md): `passkey`, the household's enrolled credentials, and
 * `unlock_grant`, one browser's current unlock. Ticket 02 builds the domain
 * module in front of both; nothing owns them yet, so what is worth pinning
 * here is the schema itself — the cascade, the foreign key, and the partial
 * unique index that is one half of what makes the household's first enrolment
 * atomic (the migration's comment on that index says which half, and why no
 * index can be the other one).
 */
import type { Pool, PoolClient } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { createPool } from "../server/db.ts";
import {
  bootstrapPasskeyExists,
  clearRacingPasskeys,
  insertBootstrapPasskey,
} from "./support/fixtures.ts";
import {
  TEST_DATABASE_URL,
  closeTestDatabase,
  testDatabase,
  withDatabase,
} from "./support/database.ts";

afterAll(closeTestDatabase);

/** No test here verifies a signature; only the bytes need to round-trip. */
const A_PUBLIC_KEY = new Uint8Array([1, 2, 3, 4]);

describe("passkey", () => {
  it(
    "deletes a passkey's grants when the passkey is removed",
    withDatabase(async ({ db, seedPasskey, seedUnlockGrant }) => {
      const passkey = await seedPasskey({ publicKey: A_PUBLIC_KEY });
      const grant = await seedUnlockGrant({ passkeyId: passkey.credentialId });

      await db.deleteFrom("passkey").where("credential_id", "=", passkey.credentialId).execute();

      const remaining = await db
        .selectFrom("unlock_grant")
        .select("id")
        .where("id", "=", grant.id)
        .execute();
      expect(remaining).toHaveLength(0);
    }),
  );

  it(
    "reopens the bootstrap case once every passkey is removed",
    withDatabase(async ({ db, seedPasskey }) => {
      const first = await seedPasskey({ publicKey: A_PUBLIC_KEY, bootstrap: true });
      await db.deleteFrom("passkey").where("credential_id", "=", first.credentialId).execute();

      // The index constrains only the rows whose flag is true, so the slot
      // frees the moment the flagged row goes and a second bootstrap
      // enrolment lands — which is what returns a household that removed
      // every passkey to the unlocked, anyone-may-enrol case the operator's
      // recovery depends on.
      const second = await seedPasskey({ publicKey: A_PUBLIC_KEY, bootstrap: true });

      const bootstrapRows = await db
        .selectFrom("passkey")
        .select("credential_id")
        .where("bootstrap", "=", true)
        .execute();
      expect(bootstrapRows).toEqual([{ credential_id: second.credentialId }]);
    }),
  );

  it(
    "enrolls a second ordinary passkey without conflicting with the first",
    withDatabase(async ({ db, seedPasskey }) => {
      // The rule this guards: `passkey_bootstrap_idx` must be partial (`where
      // bootstrap`). Written as a plain `unique (bootstrap)` instead, every
      // other test in this file would still pass — both ordinary passkeys
      // below default `bootstrap` to false, and a non-partial index would
      // collide the second insert on that shared false, capping the
      // household at one ordinary passkey. ADR-0012 and ticket 02 are built
      // on several passkeys across different devices coexisting.
      const first = await seedPasskey({ publicKey: A_PUBLIC_KEY, label: "Phone" });
      const second = await seedPasskey({ publicKey: A_PUBLIC_KEY, label: "Laptop" });

      const rows = await db
        .selectFrom("passkey")
        .select("credential_id")
        .where("credential_id", "in", [first.credentialId, second.credentialId])
        .execute();
      expect(rows).toHaveLength(2);
    }),
  );

  it(
    "keeps the signature counter exact at the top of its 32-bit range",
    withDatabase(async ({ db, seedPasskey }) => {
      const MAX_UINT32 = 4294967295;
      const passkey = await seedPasskey({ publicKey: A_PUBLIC_KEY, counter: MAX_UINT32 });

      const row = await db
        .selectFrom("passkey")
        .select("counter")
        .where("credential_id", "=", passkey.credentialId)
        .executeTakeFirstOrThrow();

      // `bigint` crosses the driver boundary as a string (server/db.ts,
      // registered globally) — the shape ticket 02's module is allowed to
      // turn back into a number, on the argument that a 32-bit unsigned
      // integer can never lose precision doing it. Both halves of that
      // argument get their own assertion: the exact string Postgres sent,
      // and a round trip through `Number()` that loses nothing.
      // `tests/numeric.test.ts` is this suite's precedent for the first.
      expect(row.counter).toBe(String(MAX_UINT32));
      expect(Number(row.counter)).toBe(MAX_UINT32);
    }),
  );
});

describe("unlock_grant", () => {
  it(
    "refuses a grant naming a passkey that does not exist",
    withDatabase(async ({ seedUnlockGrant }) => {
      await expect(seedUnlockGrant({ passkeyId: "no-such-credential" })).rejects.toThrow(
        /unlock_grant_passkey_id_fkey/,
      );
    }),
  );
});

describe("passkey_bootstrap_idx", () => {
  // Real concurrency, against real Postgres, on two independent connections.
  // `withDatabase` runs a test body inside one transaction, which can only
  // ever prove what a single transaction would also satisfy — and what this
  // index is for is precisely the case a single transaction cannot exercise:
  // two bootstrap enrolments in flight at once, neither able to see the
  // other's uncommitted row. `pool-resilience.test.ts` is where this suite
  // reaches Postgres the same way, outside the shared transaction; the
  // statements themselves stay behind the fixture seam, where the schema is
  // known once.
  it("lets exactly one of two concurrent bootstrap enrolments land", async () => {
    // Applies migrations itself rather than depending on a sibling test file
    // having run first — without this, running this file alone (a `-t`
    // filter, say) fails on a bare `ECONNREFUSED` instead of the curated
    // "cannot prepare the test database" message `testDatabase` gives.
    await testDatabase();

    const pool: Pool = createPool(TEST_DATABASE_URL);
    let bodyFailed = false;

    try {
      // A run killed between the commit below and its own cleanup leaves a
      // committed `race-a` behind. Left alone that row poisons every later
      // run: the next insert of the same id hits the primary key before this
      // index is ever reached, and its transaction aborts before a single
      // assertion is made. Clearing here as well as below is what stops one
      // killed run taking down every run after it.
      await clearRacingPasskeys(pool);

      const clientA: PoolClient = await pool.connect();
      try {
        // Acquired inside A's own cleanup scope: if this second checkout
        // fails, A is still released, and `pool.end()` below does not wait
        // forever on a client nothing will hand back.
        const clientB: PoolClient = await pool.connect();
        try {
          await clientA.query("begin");
          await clientB.query("begin");

          // A's insert lands first and stays uncommitted — a tentative row
          // whose fate no other transaction can yet know.
          await insertBootstrapPasskey(clientA, "race-a");

          // B's insert is issued while A is still open, so Postgres cannot
          // yet say whether A's row will exist. B blocks here rather than
          // returning, which is why this is not awaited immediately.
          const blockedInsert = insertBootstrapPasskey(clientB, "race-b");
          // A rejection handler at creation, closing the window between this
          // line and the `await` below where an unhandled rejection — had the
          // commit thrown first — would be reported against an unrelated test.
          blockedInsert.catch(() => {});

          // Resolving A is what unblocks B: now that A's row is real, B's
          // insert finds a genuine conflict rather than landing after the
          // first, exactly as the migration's comment argues.
          await clientA.query("commit");

          // The constraint name is what makes this the index under test and
          // not some other unique violation — the primary key would also
          // satisfy a bare `{ code: "23505" }`.
          await expect(blockedInsert).rejects.toMatchObject({
            code: "23505",
            constraint: "passkey_bootstrap_idx",
          });

          // The index refusing the second insert is only half of what this
          // test is named for; the other half is that the first one landed.
          expect(await bootstrapPasskeyExists(pool, "race-a")).toBe(true);

          // What this index does *not* prove: that nothing may bootstrap once
          // a passkey is already committed, however long ago. That half of
          // the rule is ticket 02's conditional insert (`where not exists`),
          // built in the module ticket 02 creates — the migration's comment
          // on this index is explicit that emptiness is not a uniqueness
          // predicate and no index can stand in for it.
        } finally {
          // Rollback recovers a client left mid-transaction (aborted or not)
          // as safely as it no-ops on one that already committed — cheap
          // insurance against handing the pool back a connection stuck
          // inside an open transaction.
          await clientB.query("rollback").catch(() => {});
          clientB.release();
        }
      } finally {
        await clientA.query("rollback").catch(() => {});
        clientA.release();
      }
    } catch (error) {
      bodyFailed = true;
      throw error;
    } finally {
      // This test is the one place in the suite that commits outside
      // `withDatabase`, so the compensating delete is what keeps the promise
      // `tests/support/database.ts` makes about leaving the database as
      // found. A failure here is therefore a failure of the test, not
      // housekeeping to shrug at: a surviving `race-a` makes every later lock
      // test read a household that holds a passkey. It is suppressed only
      // when the body already failed, so a second-order error never replaces
      // the diagnostic that actually matters.
      let cleanupError: unknown;
      try {
        await clearRacingPasskeys(pool);
      } catch (error) {
        cleanupError = error;
      }
      await pool.end();
      if (cleanupError !== undefined && !bodyFailed) throw cleanupError;
    }
  });
});
