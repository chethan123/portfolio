/**
 * Two things this script must never get wrong about the database it is
 * pointed at, each safety-critical for a reason a passing suite would not
 * otherwise catch.
 *
 * **The coexistence case (finding 1):** a database holding both the capture
 * placeholder and a developer's own enrolled passkey must refuse — the early
 * return on finding the placeholder used to skip that check entirely, which
 * is exactly the case where a mixed set slipped past and every enrolled row
 * would have been captured into the committed screenshots.
 *
 * **The wrong-database case:** a database with no `demo_seed` marker — a
 * migrated-but-unseeded one, or simply the wrong `DATABASE_URL` — must
 * refuse before either the passkey or the grant is written, never after.
 * `ensureCapturePasskey`'s own tests below cannot pin this: they call it
 * directly and would keep passing even if `main` went back to writing first
 * and validating after, so `prepareCapture` — the one function `main`
 * actually calls, in the one order it calls things — is what this suite
 * tests instead.
 *
 * `ensureCapturePasskey` and `prepareCapture` both talk to a raw `pg`
 * connection, never Kysely, so `withDatabase`'s transaction fixture cannot
 * isolate them — that fixture's rollback happens on a *different*
 * connection than the one this function queries, and under READ COMMITTED
 * one connection never sees another's uncommitted rows. One client, one
 * transaction, always rolled back here instead, so nothing this file
 * inserts survives past its own test.
 */
import { afterAll, describe, expect, it } from "vitest";

import {
  CAPTURE_PLACEHOLDER_CREDENTIAL_ID,
  ensureCapturePasskey,
  prepareCapture,
} from "../../scripts/capture-screenshots.ts";
import { createPool } from "../../server/db.ts";
import { closeTestDatabase, testDatabase, TEST_DATABASE_URL } from "../support/database.ts";

import type { PoolClient } from "pg";

afterAll(closeTestDatabase);

const pool = createPool(TEST_DATABASE_URL);
afterAll(() => pool.end());

async function plantPasskey(
  client: PoolClient,
  credentialId: string,
  bootstrap: boolean,
): Promise<void> {
  await client.query(
    `insert into passkey (credential_id, public_key, backup_eligible, label, bootstrap)
     values ($1, $2, true, $3, $4)`,
    [credentialId, Buffer.from(`test passkey ${credentialId}`), `Test: ${credentialId}`, bootstrap],
  );
}

/**
 * Runs `body` against a client transaction that is always rolled back —
 * `testDatabase()` guarantees the `passkey` table exists (migrations
 * applied) before the transaction opens.
 */
function withPasskeyTable(body: (client: PoolClient) => Promise<void>): () => Promise<void> {
  return async () => {
    await testDatabase();
    const client = await pool.connect();
    try {
      await client.query("begin");
      try {
        await body(client);
      } finally {
        await client.query("rollback");
      }
    } finally {
      client.release();
    }
  };
}

describe("ensureCapturePasskey", () => {
  it(
    "refuses a database holding both the placeholder and a developer's own passkey",
    withPasskeyTable(async (client) => {
      await plantPasskey(client, CAPTURE_PLACEHOLDER_CREDENTIAL_ID, /* bootstrap */ true);
      await plantPasskey(client, "a-developers-own-credential-id", /* bootstrap */ false);

      await expect(ensureCapturePasskey(client)).rejects.toThrow(
        /already holds a passkey that is not the capture placeholder/,
      );
    }),
  );

  it(
    "adopts the placeholder when it is the only passkey enrolled",
    withPasskeyTable(async (client) => {
      await plantPasskey(client, CAPTURE_PLACEHOLDER_CREDENTIAL_ID, /* bootstrap */ true);

      await expect(ensureCapturePasskey(client)).resolves.toBe(CAPTURE_PLACEHOLDER_CREDENTIAL_ID);
    }),
  );

  it(
    "plants the placeholder when the household holds no passkey yet",
    withPasskeyTable(async (client) => {
      await expect(ensureCapturePasskey(client)).resolves.toBe(CAPTURE_PLACEHOLDER_CREDENTIAL_ID);
    }),
  );
});

describe("prepareCapture", () => {
  it(
    "refuses a database with no `demo_seed` marker before any passkey is written",
    withPasskeyTable(async (client) => {
      // The migrated test database never runs `seed-demo.ts`, so it never
      // carries the `demo_seed` marker table — exactly the migrated-but-
      // unseeded case `requireDemoSeed` exists to catch. The three tests
      // above call `ensureCapturePasskey` directly and would keep passing
      // even if `main` went back to minting the placeholder passkey before
      // checking the marker (the bug the module header already tells this
      // story about) — only a test that goes through `prepareCapture`
      // itself, the one function `main` actually calls, can catch that
      // regression; asserting `passkey` is still empty is what catches a
      // reordering that still throws, just too late.
      await expect(prepareCapture(client)).rejects.toThrow(/`demo_seed`/);

      const { rows } = await client.query<{ credential_id: string }>(
        "select credential_id from passkey",
      );
      expect(rows).toEqual([]);
    }),
  );
});
