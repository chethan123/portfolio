// Lock's two tables (ADR-0012, docs/specs/lock/01-the-passkey-and-the-grant.md): passkey and unlock_grant.
// Ticket 02 builds the domain module; nothing owns them yet, so this pins the schema itself — cascade,
// foreign key, and the partial unique index that is half of what makes first enrolment atomic.
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

      // Index constrains only rows where the flag is true — slot frees the moment that row goes, letting a second bootstrap land and returning to the anyone-may-enrol recovery case.
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
      // Rule guarded: passkey_bootstrap_idx must be partial (where bootstrap). A plain unique(bootstrap)
      // would pass every other test here but collide two ordinary passkeys (both default false), capping the household at one — ADR-0012 needs several devices coexisting.
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

      // bigint crosses the driver boundary as a string (server/db.ts); a 32-bit unsigned int never loses
      // precision as a Number(), so both are asserted: exact string, and a lossless round trip.
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
  // Real concurrency, two independent connections — withDatabase's single transaction can't exercise what
  // this index is for: two bootstrap enrolments in flight, neither seeing the other's uncommitted row.
  it("lets exactly one of two concurrent bootstrap enrolments land", async () => {
    // Applies migrations itself, not relying on a sibling file having run first, or running this file alone fails on a bare ECONNREFUSED.
    await testDatabase();

    const pool: Pool = createPool(TEST_DATABASE_URL);
    let bodyFailed = false;

    try {
      // A run killed between the commit below and its cleanup leaves race-a committed, poisoning every
      // later run — clearing here and below stops one killed run taking down every run after it.
      await clearRacingPasskeys(pool);

      const clientA: PoolClient = await pool.connect();
      try {
        // Acquired inside A's cleanup scope — if this checkout fails, A is still released and pool.end() below doesn't wait forever on an unreturned client.
        const clientB: PoolClient = await pool.connect();
        try {
          await clientA.query("begin");
          await clientB.query("begin");

          // A's insert lands first, stays uncommitted — a tentative row no other transaction can yet see.
          await insertBootstrapPasskey(clientA, "race-a");

          // B's insert is issued while A is still open — Postgres can't yet say if A's row will exist, so B blocks here (not awaited immediately).
          const blockedInsert = insertBootstrapPasskey(clientB, "race-b");
          // Rejection handler attached at creation, closing the window where an unhandled rejection (had commit thrown first) would land on an unrelated test.
          blockedInsert.catch(() => {});

          // Resolving A unblocks B — now A's row is real, B's insert finds a genuine conflict.
          await clientA.query("commit");

          // Constraint name is what proves this index — the primary key would also satisfy a bare { code: "23505" }.
          await expect(blockedInsert).rejects.toMatchObject({
            code: "23505",
            constraint: "passkey_bootstrap_idx",
          });

          // Refusing the second insert is only half the point — the other half is that the first landed.
          expect(await bootstrapPasskeyExists(pool, "race-a")).toBe(true);

          // What this index does NOT prove: nothing may bootstrap once a passkey is already committed.
          // That half is ticket 02's conditional insert — no index can stand in for a where-not-exists predicate.
        } finally {
          // Rollback recovers a client left mid-transaction as safely as it no-ops on one already committed — cheap insurance against handing the pool a connection stuck open.
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
      // Only place in the suite that commits outside withDatabase — keeps database.ts's promise to leave
      // the database as found. Suppressed only when the body already failed, so it never masks the real diagnostic.
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
