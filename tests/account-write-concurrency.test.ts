// Account position history is a complete-snapshot log. These tests use independent committed
// Postgres transactions because rollback-isolated tests cannot expose cross-connection row locks.
import { sql } from "kysely";
import { afterAll, describe, expect, it } from "vitest";

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

import type { ControlledTransaction, Kysely } from "kysely";

type RaceRows = {
  accountId: string;
  instrumentA: string;
  instrumentB: string;
  cleanup(): Promise<void>;
};

const READY_MAPPING = {
  headerRow: 0,
  delimiter: "," as const,
  columns: { instrument: "Symbol", quantity: "Quantity", costBasis: "Basis" },
  costBasisIs: "per_share" as const,
  owedAsPositive: false,
  combineDuplicateRows: true,
};

afterAll(closeTestDatabase);

async function seedRace(database: Kysely<Database>, suffix: string): Promise<RaceRows> {
  const person = await database
    .insertInto("person")
    .values({ name: `Account write race ${suffix}` })
    .returning("id")
    .executeTakeFirstOrThrow();
  const classification = await database
    .insertInto("classification")
    .values({ name: `Account write race ${suffix}`, asset_class: "equity" })
    .returning("id")
    .executeTakeFirstOrThrow();
  const instruments = await database
    .insertInto("instrument")
    .values([
      {
        symbol: `RACEA${suffix}`,
        name: `Race A ${suffix}`,
        quote_type: "EQUITY",
        price_source: "feed",
        classification_id: classification.id,
      },
      {
        symbol: `RACEB${suffix}`,
        name: `Race B ${suffix}`,
        quote_type: "EQUITY",
        price_source: "feed",
        classification_id: classification.id,
      },
    ])
    .returning("id")
    .execute();
  const instrumentA = instruments[0]!.id;
  const instrumentB = instruments[1]!.id;
  const account = await database
    .insertInto("account")
    .values({
      name: `Account write race ${suffix}`,
      institution: "Race",
      kind: "brokerage",
      owner_id: person.id,
      tax_treatment: "taxable",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  const set = await database
    .insertInto("position_set")
    .values({ account_id: account.id, as_of_date: "2026-09-01", source: "upload" })
    .returning("id")
    .executeTakeFirstOrThrow();
  await database
    .insertInto("holding")
    .values([
      { position_set_id: set.id, instrument_id: instrumentA, quantity: "10" },
      { position_set_id: set.id, instrument_id: instrumentB, quantity: "20" },
    ])
    .execute();

  return {
    accountId: account.id,
    instrumentA,
    instrumentB,
    cleanup: async () => {
      await database
        .deleteFrom("holding")
        .where(
          "position_set_id",
          "in",
          database.selectFrom("position_set").select("id").where("account_id", "=", account.id),
        )
        .execute();
      await database.deleteFrom("position_set").where("account_id", "=", account.id).execute();
      await database.deleteFrom("account").where("id", "=", account.id).execute();
      await database.deleteFrom("instrument").where("id", "in", [instrumentA, instrumentB]).execute();
      await database.deleteFrom("classification").where("id", "=", classification.id).execute();
      await database.deleteFrom("person").where("id", "=", person.id).execute();
    },
  };
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
  accountId: string,
  filename: string,
  csv: string,
): Promise<string> {
  const draft = await database
    .insertInto("upload_draft")
    .values({
      account_id: accountId,
      filename,
      raw_file: Buffer.from(csv),
      mapping: JSON.stringify(READY_MAPPING),
      had_first_sightings: false,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
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
    let bodyFailed = false;

    try {
      // Force the waiting transaction's old default now() to predate the lock holder. The fixed
      // default stamps its later INSERT statement, so serialized order also becomes latest order.
      await sql`select now()`.execute(olderTransaction);
      await lockHolder
        .selectFrom("account")
        .select("id")
        .where("id", "=", rows.accountId)
        .forNoKeyUpdate()
        .executeTakeFirstOrThrow();

      const pid = await backendPid(olderTransaction);
      let settled = false;
      const second = revisePosition(
        rows.accountId,
        rows.instrumentB,
        { quantity: "22", costBasisPerShare: "" },
        olderTransaction,
      ).finally(() => {
        settled = true;
      });
      second.catch(() => {});

      const state = await waitForBlockedOrSettled(database, pid, () => settled);
      await revisePosition(
        rows.accountId,
        rows.instrumentA,
        { quantity: "11", costBasisPerShare: "" },
        lockHolder,
      );
      await lockHolder.commit().execute();

      // Before the fix, `second` has already copied the original snapshot. Committing it after A
      // makes one accepted edit disappear. With the guard it resumes here and copies A's snapshot.
      await second;
      await olderTransaction.commit().execute();

      const quantities = await currentQuantities(database, rows.accountId);
      expect(quantities.get(rows.instrumentA)).toBe("11.00000000");
      expect(quantities.get(rows.instrumentB)).toBe("22.00000000");
      expect(state).toBe("blocked");
    } catch (error) {
      bodyFailed = true;
      throw error;
    } finally {
      await rollbackIfOpen(lockHolder);
      await rollbackIfOpen(olderTransaction);
      try {
        await rows.cleanup();
      } catch (error) {
        if (!bodyFailed) throw error;
      }
    }
  }, 20_000);

  it("carries an upload forward when a correction overlaps its commit", async () => {
    const database = await testDatabase();
    const rows = await seedRace(database, `upload-correction-${process.pid}`);
    const symbols = [`RACEAupload-correction-${process.pid}`, `RACEBupload-correction-${process.pid}`];
    await database
      .insertInto("instrument_alias")
      .values([
        { raw_string: symbols[0]!, instrument_id: rows.instrumentA },
        { raw_string: symbols[1]!, instrument_id: rows.instrumentB },
      ])
      .execute();
    const draftId = await readyDraft(
      database,
      rows.accountId,
      "overlap.csv",
      `Symbol,Quantity,Basis\n${symbols[0]},100,\n${symbols[1]},200,\n`,
    );
    const correctionTransaction = await database.startTransaction().execute();
    const uploadTransaction = await database.startTransaction().execute();
    let bodyFailed = false;

    try {
      await sql`select now()`.execute(correctionTransaction);
      await commitUpload(
        draftId,
        { accountId: rows.accountId, asOf: new Date().toISOString().slice(0, 10) },
        uploadTransaction,
      );

      const pid = await backendPid(correctionTransaction);
      let settled = false;
      const correction = revisePosition(
        rows.accountId,
        rows.instrumentA,
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

      const quantities = await currentQuantities(database, rows.accountId);
      expect(quantities.get(rows.instrumentA)).toBe("111.00000000");
      expect(quantities.get(rows.instrumentB)).toBe("200.00000000");
      expect(state).toBe("blocked");
    } catch (error) {
      bodyFailed = true;
      throw error;
    } finally {
      await rollbackIfOpen(uploadTransaction);
      await rollbackIfOpen(correctionTransaction);
      try {
        await rows.cleanup();
      } catch (error) {
        if (!bodyFailed) throw error;
      }
    }
  }, 20_000);

  it("refuses a balance write that overlaps an upload adding a security", async () => {
    const database = await testDatabase();
    const suffix = `balance-upload-${process.pid}`;
    const person = await database
      .insertInto("person")
      .values({ name: suffix })
      .returning("id")
      .executeTakeFirstOrThrow();
    const classification = await database
      .insertInto("classification")
      .values({ name: suffix, asset_class: "equity" })
      .returning("id")
      .executeTakeFirstOrThrow();
    const security = await database
      .insertInto("instrument")
      .values({
        symbol: suffix,
        name: suffix,
        quote_type: "EQUITY",
        price_source: "feed",
        classification_id: classification.id,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const usd = await database
      .selectFrom("instrument")
      .select("id")
      .where("symbol", "=", "USD")
      .where("price_source", "=", "fixed")
      .orderBy("id")
      .executeTakeFirstOrThrow();
    const account = await database
      .insertInto("account")
      .values({
        name: suffix,
        institution: "Race",
        kind: "bank",
        owner_id: person.id,
        tax_treatment: "taxable",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const initial = await database
      .insertInto("position_set")
      .values({ account_id: account.id, as_of_date: "2026-09-01", source: "manual" })
      .returning("id")
      .executeTakeFirstOrThrow();
    await database
      .insertInto("holding")
      .values({ position_set_id: initial.id, instrument_id: usd.id, quantity: "100" })
      .execute();
    const rawUsd = `${suffix}-USD`;
    const rawSecurity = `${suffix}-SEC`;
    await database
      .insertInto("instrument_alias")
      .values([
        { raw_string: rawUsd, instrument_id: usd.id },
        { raw_string: rawSecurity, instrument_id: security.id },
      ])
      .execute();
    const draftId = await readyDraft(
      database,
      account.id,
      "bank-overlap.csv",
      `Symbol,Quantity,Basis\n${rawUsd},200,\n${rawSecurity},5,\n`,
    );
    const balanceTransaction = await database.startTransaction().execute();
    const uploadTransaction = await database.startTransaction().execute();
    let bodyFailed = false;

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
      if (state === "blocked") {
        await uploadTransaction.commit().execute();
        await expect(balance).rejects.toBeInstanceOf(ValidationError);
        await balanceTransaction.rollback().execute();
      } else {
        await balance;
        await uploadTransaction.commit().execute();
        await balanceTransaction.commit().execute();
      }

      const quantities = await currentQuantities(database, account.id);
      expect(quantities.get(usd.id)).toBe("200.00000000");
      expect(quantities.get(security.id)).toBe("5.00000000");
      expect(state).toBe("blocked");
    } catch (error) {
      bodyFailed = true;
      throw error;
    } finally {
      await rollbackIfOpen(uploadTransaction);
      await rollbackIfOpen(balanceTransaction);
      try {
        await database.deleteFrom("instrument_alias").where("raw_string", "in", [rawUsd, rawSecurity]).execute();
        await database
          .deleteFrom("holding")
          .where(
            "position_set_id",
            "in",
            database.selectFrom("position_set").select("id").where("account_id", "=", account.id),
          )
          .execute();
        await database.deleteFrom("position_set").where("account_id", "=", account.id).execute();
        await database.deleteFrom("account").where("id", "=", account.id).execute();
        await database.deleteFrom("instrument").where("id", "=", security.id).execute();
        await database.deleteFrom("classification").where("id", "=", classification.id).execute();
        await database.deleteFrom("person").where("id", "=", person.id).execute();
      } catch (error) {
        if (!bodyFailed) throw error;
      }
    }
  }, 20_000);

  it("refuses a correction that was waiting when the account closed", async () => {
    const database = await testDatabase();
    const rows = await seedRace(database, `closure-${process.pid}`);
    const closer = await database.startTransaction().execute();
    const writer = await database.startTransaction().execute();
    let bodyFailed = false;

    try {
      await closeAccount(rows.accountId, { confirmClose: "true" }, closer);

      const pid = await backendPid(writer);
      let settled = false;
      const correction = revisePosition(
        rows.accountId,
        rows.instrumentA,
        { quantity: "11", costBasisPerShare: "" },
        writer,
      ).finally(() => {
        settled = true;
      });
      correction.catch(() => {});

      const state = await waitForBlockedOrSettled(database, pid, () => settled);
      if (state === "blocked") {
        await closer.commit().execute();
        await expect(correction).rejects.toBeInstanceOf(ValidationError);
        await writer.rollback().execute();
      } else {
        // Old behavior: the correction accepted an account whose close was already in flight.
        await correction;
        await writer.commit().execute();
        await closer.commit().execute();
      }

      const sets = await database
        .selectFrom("position_set")
        .select("id")
        .where("account_id", "=", rows.accountId)
        .execute();
      expect(sets).toHaveLength(1);
      expect(state).toBe("blocked");
    } catch (error) {
      bodyFailed = true;
      throw error;
    } finally {
      await rollbackIfOpen(closer);
      await rollbackIfOpen(writer);
      try {
        await rows.cleanup();
      } catch (error) {
        if (!bodyFailed) throw error;
      }
    }
  }, 20_000);
});
