// Two safety-critical cases a passing suite wouldn't otherwise catch:
// - Coexistence (finding 1): placeholder + a developer's own passkey must refuse — the early-return-on-placeholder bug once
//   skipped this check, letting a mixed set get captured into committed screenshots.
// - Wrong database: no `demo_seed` marker must refuse before any write. Tested via prepareCapture (what main actually calls,
//   in order), not ensureCapturePasskey directly, which would keep passing even if validation moved after the write.
// Both talk to a raw pg connection, not Kysely, so withDatabase's rollback (a different connection) can't isolate them —
// one client, one transaction, rolled back here instead.
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

/** Runs `body` in a rolled-back transaction; testDatabase() applies migrations first so `passkey` exists. */
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
      // The migrated test database never runs seed-demo.ts, so it lacks demo_seed — the migrated-but-unseeded case requireDemoSeed
      // catches. Asserting passkey is still empty catches a reordering that still throws, just too late.
      await expect(prepareCapture(client)).rejects.toThrow(/`demo_seed`/);

      const { rows } = await client.query<{ credential_id: string }>(
        "select credential_id from passkey",
      );
      expect(rows).toEqual([]);
    }),
  );
});
