// Account position history is a complete-snapshot log. These tests use independent committed
// Postgres transactions because rollback-isolated tests cannot expose cross-connection row locks.
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeAccount } from "~/lib/accounts.server";
import { setBalance } from "~/lib/balances.server";
import { type Database } from "~/lib/db.server";
import { ValidationError } from "~/lib/input.server";
import { revisePosition } from "~/lib/positions.server";
import { commitUpload } from "~/lib/uploads.server";
import {
  TEST_DATABASE_URL,
  closeTestDatabase,
  testDatabase,
} from "./support/database.ts";
import {
  ACCOUNT_WRITE_RACE_PREFIX,
  clearAccountWriteRaces,
  makeFixtures,
} from "./support/fixtures.ts";

import type { ControlledTransaction, Kysely } from "kysely";
import type { StatementMapping } from "~/lib/statement";
import type { SeededAccount, SeededInstrument } from "./support/fixtures.ts";

type RaceRows = {
  account: SeededAccount;
  instrumentA: SeededInstrument;
  instrumentB: SeededInstrument;
};

const READY_MAPPING = {
  headerRow: 0,
  delimiter: "," as const,
  columns: { instrument: "Symbol", quantity: "Quantity", costBasis: "Basis" },
  costBasisIs: "per_share" as const,
  owedAsPositive: false,
  combineDuplicateRows: true,
} satisfies StatementMapping;

beforeAll(async () => clearAccountWriteRaces(await testDatabase()));
afterAll(async () => {
  await clearAccountWriteRaces(await testDatabase());
  await closeTestDatabase();
});

async function seedRace(database: Kysely<Database>, suffix: string): Promise<RaceRows> {
  const fixtures = makeFixtures(database);
  const marker = `${ACCOUNT_WRITE_RACE_PREFIX}${suffix}`;
  const person = await fixtures.seedPerson({ name: marker });
  const classification = await fixtures.seedClassification({ name: marker });
  const instrumentA = await fixtures.seedInstrument({
    symbol: `${marker}-A`,
    name: `${marker}-A`,
    classification,
  });
  const instrumentB = await fixtures.seedInstrument({
    symbol: `${marker}-B`,
    name: `${marker}-B`,
    classification,
  });
  const account = await fixtures.seedAccount({
    name: marker,
    institution: "Race",
    owner: person,
  });
  await fixtures.seedPositionSet({
    account,
    asOf: "2026-09-01",
    holdings: [
      { instrument: instrumentA, quantity: "10" },
      { instrument: instrumentB, quantity: "20" },
    ],
  });

  return { account, instrumentA, instrumentB };
}

async function backendPid(handle: Kysely<Database>): Promise<number> {
  const result = await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(handle);
  return result.rows[0]!.pid;
}

async function waitForBlockedOrSettled(
  watcher: Kysely<Database>,
  pid: number,
  settled: () => boolean,
): Promise<"blocked" | "settled"> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const result = await sql<{ blocked: boolean }>`
      select exists (
        select 1 from pg_stat_activity where pid = ${pid} and wait_event_type = 'Lock'
      ) as blocked
    `.execute(watcher);
    if (result.rows[0]?.blocked === true) return "blocked";
    if (settled()) return "settled";
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for backend ${pid} to block or finish.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function rollbackIfOpen(trx: ControlledTransaction<Database>): Promise<void> {
  if (!trx.isCommitted && !trx.isRolledBack) await trx.rollback().execute().catch(() => {});
}

async function readyDraft(
  database: Kysely<Database>,
  account: SeededAccount,
  filename: string,
  csv: string,
): Promise<string> {
  const draft = await makeFixtures(database).seedUploadDraft({
    account,
    filename,
    bytes: new TextEncoder().encode(csv),
    mapping: READY_MAPPING,
    hadFirstSightings: false,
  });
  return draft.id;
}

async function currentQuantities(
  database: Kysely<Database>,
  accountId: string,
): Promise<Map<string, string>> {
  const result = await sql<{ instrument_id: string; quantity: string }>`
    select h.instrument_id, h.quantity
    from holding h
    where h.position_set_id = latest_position_set(${accountId}::bigint)
  `.execute(database);
  return new Map(result.rows.map((row) => [row.instrument_id, row.quantity]));
}

describe("account write serialization", () => {
  it("preserves two accepted corrections that overlap on different holdings", async () => {
    const database = await testDatabase();
    const rows = await seedRace(database, `corrections-${process.pid}`);
    const olderTransaction = await database.startTransaction().execute();
    const lockHolder = await database.startTransaction().execute();

    try {
      // Force the waiting transaction's old default now() to predate the lock holder. The fixed
      // default stamps its later INSERT statement, so serialized order also becomes latest order.
      await sql`select now()`.execute(olderTransaction);
      await lockHolder
        .selectFrom("account")
        .select("id")
        .where("id", "=", rows.account.id)
        .forNoKeyUpdate()
        .executeTakeFirstOrThrow();

      const pid = await backendPid(olderTransaction);
      let settled = false;
      const second = revisePosition(
        rows.account.id,
        rows.instrumentB.id,
        { quantity: "22", costBasisPerShare: "" },
        olderTransaction,
      ).finally(() => {
        settled = true;
      });
      second.catch(() => {});

      const state = await waitForBlockedOrSettled(database, pid, () => settled);
      await revisePosition(
        rows.account.id,
        rows.instrumentA.id,
        { quantity: "11", costBasisPerShare: "" },
        lockHolder,
      );
      await lockHolder.commit().execute();

      // Before the fix, `second` has already copied the original snapshot. Committing it after A
      // makes one accepted edit disappear. With the guard it resumes here and copies A's snapshot.
      await second;
      await olderTransaction.commit().execute();

      const quantities = await currentQuantities(database, rows.account.id);
      expect(quantities.get(rows.instrumentA.id)).toBe("11.00000000");
      expect(quantities.get(rows.instrumentB.id)).toBe("22.00000000");
      expect(state).toBe("blocked");
    } finally {
      await rollbackIfOpen(lockHolder);
      await rollbackIfOpen(olderTransaction);
    }
  }, 20_000);

  it("carries an upload forward when a correction overlaps its commit", async () => {
    const database = await testDatabase();
    const rows = await seedRace(database, `upload-correction-${process.pid}`);
    const fixtures = makeFixtures(database);
    const symbols = [rows.instrumentA.symbol!, rows.instrumentB.symbol!];
    await fixtures.seedInstrumentAlias({ instrument: rows.instrumentA, rawString: symbols[0]! });
    await fixtures.seedInstrumentAlias({ instrument: rows.instrumentB, rawString: symbols[1]! });
    const draftId = await readyDraft(
      database,
      rows.account,
      "overlap.csv",
      `Symbol,Quantity,Basis\n${symbols[0]},100,\n${symbols[1]},200,\n`,
    );
    const correctionTransaction = await database.startTransaction().execute();
    const uploadTransaction = await database.startTransaction().execute();

    try {
      await sql`select now()`.execute(correctionTransaction);
      await commitUpload(
        draftId,
        { accountId: rows.account.id, asOf: new Date().toISOString().slice(0, 10) },
        uploadTransaction,
      );

      const pid = await backendPid(correctionTransaction);
      let settled = false;
      const correction = revisePosition(
        rows.account.id,
        rows.instrumentA.id,
        { quantity: "111", costBasisPerShare: "" },
        correctionTransaction,
      ).finally(() => {
        settled = true;
      });
      correction.catch(() => {});

      const state = await waitForBlockedOrSettled(database, pid, () => settled);
      await uploadTransaction.commit().execute();
      await correction;
      await correctionTransaction.commit().execute();

      const quantities = await currentQuantities(database, rows.account.id);
      expect(quantities.get(rows.instrumentA.id)).toBe("111.00000000");
      expect(quantities.get(rows.instrumentB.id)).toBe("200.00000000");
      expect(state).toBe("blocked");
    } finally {
      await rollbackIfOpen(uploadTransaction);
      await rollbackIfOpen(correctionTransaction);
    }
  }, 20_000);

  it("refuses a balance write that overlaps an upload adding a security", async () => {
    const database = await testDatabase();
    const fixtures = makeFixtures(database);
    const marker = `${ACCOUNT_WRITE_RACE_PREFIX}balance-upload-${process.pid}`;
    const person = await fixtures.seedPerson({ name: marker });
    const classification = await fixtures.seedClassification({ name: marker });
    const security = await fixtures.seedInstrument({
      symbol: marker,
      name: marker,
      classification,
    });
    const usd = await fixtures.usdInstrument();
    const account = await fixtures.seedAccount({
      name: marker,
      institution: "Race",
      kind: "bank",
      owner: person,
    });
    await fixtures.seedPositionSet({
      account,
      asOf: "2026-09-01",
      source: "manual",
      holdings: [{ instrument: usd, quantity: "100" }],
    });
    const rawUsd = `${marker}-USD`;
    const rawSecurity = `${marker}-SEC`;
    await fixtures.seedInstrumentAlias({ instrument: usd, rawString: rawUsd });
    await fixtures.seedInstrumentAlias({ instrument: security, rawString: rawSecurity });
    const draftId = await readyDraft(
      database,
      account,
      "bank-overlap.csv",
      `Symbol,Quantity,Basis\n${rawUsd},200,\n${rawSecurity},5,\n`,
    );
    const balanceTransaction = await database.startTransaction().execute();
    const uploadTransaction = await database.startTransaction().execute();

    try {
      await commitUpload(
        draftId,
        { accountId: account.id, asOf: new Date().toISOString().slice(0, 10) },
        uploadTransaction,
      );

      const pid = await backendPid(balanceTransaction);
      let settled = false;
      const balance = setBalance(
        account.id,
        { amount: "300", asOf: new Date().toISOString().slice(0, 10) },
        balanceTransaction,
      ).finally(() => {
        settled = true;
      });
      balance.catch(() => {});

      const state = await waitForBlockedOrSettled(database, pid, () => settled);
      expect(state).toBe("blocked");
      await uploadTransaction.commit().execute();
      await expect(balance).rejects.toBeInstanceOf(ValidationError);
      await balanceTransaction.rollback().execute();

      const quantities = await currentQuantities(database, account.id);
      expect(quantities.get(usd.id)).toBe("200.00000000");
      expect(quantities.get(security.id)).toBe("5.00000000");

      // A stale accepted balance can sort behind the upload and hide in append-only history.
      const forbiddenBalance = await database
        .selectFrom("position_set as ps")
        .innerJoin("holding as h", "h.position_set_id", "ps.id")
        .select("h.quantity")
        .where("ps.account_id", "=", account.id)
        .where("ps.source", "=", "manual")
        .where("h.instrument_id", "=", usd.id)
        .where("h.quantity", "=", "300")
        .execute();
      expect(forbiddenBalance).toEqual([]);
    } finally {
      await rollbackIfOpen(uploadTransaction);
      await rollbackIfOpen(balanceTransaction);
    }
  }, 20_000);

  it("refuses a correction that was waiting when the account closed", async () => {
    const database = await testDatabase();
    const rows = await seedRace(database, `closure-${process.pid}`);
    const closer = await database.startTransaction().execute();
    const writer = await database.startTransaction().execute();

    try {
      await closeAccount(rows.account.id, { confirmClose: "true" }, closer);

      const pid = await backendPid(writer);
      let settled = false;
      const correction = revisePosition(
        rows.account.id,
        rows.instrumentA.id,
        { quantity: "11", costBasisPerShare: "" },
        writer,
      ).finally(() => {
        settled = true;
      });
      correction.catch(() => {});

      const state = await waitForBlockedOrSettled(database, pid, () => settled);
      expect(state).toBe("blocked");
      await closer.commit().execute();
      await expect(correction).rejects.toBeInstanceOf(ValidationError);
      await writer.rollback().execute();

      const sets = await database
        .selectFrom("position_set")
        .select("id")
        .where("account_id", "=", rows.account.id)
        .execute();
      expect(sets).toHaveLength(1);
    } finally {
      await rollbackIfOpen(closer);
      await rollbackIfOpen(writer);
    }
  }, 20_000);
});
