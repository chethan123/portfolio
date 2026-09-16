// withAccountLock (accounts.server.ts, ARCHITECTURE.md §7.2): every writer that appends a position
// set, and closeAccount, waits its turn on the account row. Two connections and committed rows,
// because withDatabase's one rolled-back transaction cannot contend with itself; every row planted
// here carries RACE_PREFIX and is swept at both ends.
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeAccount } from "~/lib/accounts.server";
import { setBalance } from "~/lib/balances.server";
import { ValidationError } from "~/lib/input.server";
import { revisePosition } from "~/lib/positions.server";
import { RefusedUpload, commitUpload, reviewForDraft } from "~/lib/uploads.server";

import {
  backendPid,
  closeTestDatabase,
  testDatabase,
  waitUntilBlocked,
} from "./support/database.ts";
import { RACE_PREFIX, clearRaces, makeFixtures } from "./support/fixtures.ts";

import type { Database } from "~/lib/db.server";
import type { StatementMapping } from "~/lib/statement";
import type { Kysely } from "kysely";
import type { SeededAccount, SeededInstrument } from "./support/fixtures.ts";

beforeAll(async () => clearRaces(await testDatabase()));
afterAll(async () => {
  try {
    await clearRaces(await testDatabase());
  } finally {
    await closeTestDatabase();
  }
});

const today = (): string => new Date().toISOString().slice(0, 10);

type Writer<T> = (trx: Kysely<Database>) => Promise<T>;

/** The refusal a call produced, or a failure if it did not refuse. */
async function refusalOf(run: () => Promise<unknown>): Promise<ValidationError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof ValidationError) return error;
    throw error;
  }
  throw new Error("Expected the write to be refused, and it was not.");
}

/**
 * `holds` runs in one transaction and stays open; `waits` is issued in a second and has to block on
 * a lock before `holds` commits, so what it returns or throws was produced after waiting. Settling
 * before it blocked is the failure these tests exist for, and is reported by name rather than as a
 * timeout. The waiter's transaction begins first when asked: now() is pinned at BEGIN, so that is
 * the writer whose stamp would be older than the set it waited for.
 */
async function behindTheLock<T>(
  database: Kysely<Database>,
  holds: Writer<unknown>,
  waits: Writer<T>,
  { waiterBeginsFirst = false } = {},
): Promise<T> {
  const earlier = await database.startTransaction().execute();
  const later = await database.startTransaction().execute();
  const [holder, waiter] = waiterBeginsFirst ? [later, earlier] : [earlier, later];

  try {
    await holds(holder);

    // Read ahead of the statement that blocks: a query queued behind it on the same connection blocks with it.
    const pid = await backendPid(waiter);
    const pending = waits(waiter);
    pending.catch(() => {});
    await waitUntilBlocked(database, pid, { unless: pending });

    await holder.commit().execute();
    try {
      const value = await pending;
      await waiter.commit().execute();
      return value;
    } catch (error) {
      await waiter.rollback().execute();
      throw error;
    }
  } finally {
    for (const trx of [holder, waiter]) {
      if (!trx.isCommitted && !trx.isRolledBack) await trx.rollback().execute().catch(() => {});
    }
  }
}

type Planted = {
  account: SeededAccount;
  x: SeededInstrument;
  y: SeededInstrument;
  z: SeededInstrument;
  // The seeded set's own id — every commitUpload call here is dated after it, so it is the
  // baseline every one of them must post to avoid an unrelated stale-baseline refusal (#181).
  baselineSetId: string;
};

/** A committed account holding X and Y, with Z known but not held. Each instrument is aliased to its own name, so a file naming it needs no resolving step; every name is under RACE_PREFIX for the sweep. */
async function plant(database: Kysely<Database>, tag: string): Promise<Planted> {
  const fixtures = makeFixtures(database);
  const name = (part: string) => `${RACE_PREFIX}${tag}-${part}`;
  const owner = await fixtures.seedPerson({ name: name("owner") });
  const classification = await fixtures.seedClassification({ name: name("class") });
  const instrument = async (part: string) => {
    const seeded = await fixtures.seedInstrument({
      symbol: name(part),
      name: name(part),
      classification,
    });
    await fixtures.seedInstrumentAlias({ instrument: seeded, rawString: seeded.name });
    return seeded;
  };
  const x = await instrument("X");
  const y = await instrument("Y");
  const z = await instrument("Z");
  const account = await fixtures.seedAccount({ name: name("account"), owner });
  const seeded = await fixtures.seedPositionSet({
    account,
    asOf: "2026-09-01",
    holdings: [
      { instrument: x, quantity: "10" },
      { instrument: y, quantity: "20" },
    ],
  });

  return { account, x, y, z, baselineSetId: seeded.id };
}

const MAPPING: StatementMapping = {
  headerRow: 0,
  delimiter: ",",
  columns: { instrument: "Symbol", quantity: "Quantity", costBasis: "Basis" },
  costBasisIs: "per_share",
  owedAsPositive: false,
  combineDuplicateRows: true,
};

/** A review-ready draft naming each raw string with a quantity, mapping saved as the columns step leaves it. */
async function stagedUpload(
  database: Kysely<Database>,
  account: SeededAccount,
  rows: ReadonlyArray<readonly [raw: string, quantity: string]>,
): Promise<string> {
  const csv = ["Symbol,Quantity,Basis", ...rows.map(([raw, quantity]) => `${raw},${quantity},`)];
  const draft = await makeFixtures(database).seedUploadDraft({
    account,
    filename: "race.csv",
    bytes: new TextEncoder().encode(`${csv.join("\n")}\n`),
    mapping: MAPPING,
    hadFirstSightings: false,
  });

  return draft.id;
}

/** What the account's latest set holds, by instrument id, at the stored scale. */
async function latestQuantities(
  database: Kysely<Database>,
  accountId: string,
): Promise<Record<string, string>> {
  const result = await sql<{ instrument_id: string; quantity: string }>`
    select h.instrument_id, h.quantity
    from holding h
    where h.position_set_id = latest_position_set(${accountId}::bigint)
  `.execute(database);

  return Object.fromEntries(result.rows.map((row) => [row.instrument_id, row.quantity]));
}

async function positionSetCount(database: Kysely<Database>, accountId: string): Promise<number> {
  const rows = await database
    .selectFrom("position_set")
    .select("id")
    .where("account_id", "=", accountId)
    .execute();

  return rows.length;
}

async function revisionFor(
  database: Kysely<Database>,
  draftId: string,
  asOf: string,
): Promise<string> {
  return (await reviewForDraft(draftId, asOf, database)).reviewRevision ?? "";
}

describe("the account lock", () => {
  it(
    "keeps both of two corrections to different holdings, the second carrying the first forward",
    async () => {
      const database = await testDatabase();
      const { account, x, y } = await plant(database, "two-corrections");

      await behindTheLock(
        database,
        (trx) => revisePosition(account.id, x.id, { quantity: "11", costBasisPerShare: "" }, trx),
        (trx) => revisePosition(account.id, y.id, { quantity: "22", costBasisPerShare: "" }, trx),
      );

      expect(await latestQuantities(database, account.id)).toEqual({
        [x.id]: "11.00000000",
        [y.id]: "22.00000000",
      });
    },
    20_000,
  );

  it(
    "lets a correction whose transaction began first still speak last, once it has waited its turn",
    async () => {
      const database = await testDatabase();
      const { account, x, y } = await plant(database, "older-waiter");

      // Both land today; created_at decides. Stamped at the insert (0014), not at BEGIN — a BEGIN
      // stamp would sort the waiter's set, the one carrying both edits, behind the one it copied.
      await behindTheLock(
        database,
        (trx) => revisePosition(account.id, x.id, { quantity: "11", costBasisPerShare: "" }, trx),
        (trx) => revisePosition(account.id, y.id, { quantity: "22", costBasisPerShare: "" }, trx),
        { waiterBeginsFirst: true },
      );

      expect(await latestQuantities(database, account.id)).toEqual({
        [x.id]: "11.00000000",
        [y.id]: "22.00000000",
      });
    },
    20_000,
  );

  it(
    "carries an upload forward in a correction that was waiting on its commit",
    async () => {
      const database = await testDatabase();
      const { account, x, y, baselineSetId } = await plant(database, "upload-then-correction");
      const draftId = await stagedUpload(database, account, [
        [x.name, "100"],
        [y.name, "200"],
      ]);
      const reviewRevision = await revisionFor(database, draftId, today());

      await behindTheLock(
        database,
        (trx) =>
          commitUpload(
            draftId,
            { accountId: account.id, asOf: today(), baselineSetId, reviewRevision },
            trx,
          ),
        (trx) => revisePosition(account.id, x.id, { quantity: "111", costBasisPerShare: "" }, trx),
      );

      // Without the lock the correction copies the pre-upload set forward and the statement vanishes from "current".
      expect(await latestQuantities(database, account.id)).toEqual({
        [x.id]: "111.00000000",
        [y.id]: "200.00000000",
      });
    },
    20_000,
  );

  it(
    "reads the statement it lands on when an upload was waiting on another, refusing a stale baseline it could not see before",
    async () => {
      const database = await testDatabase();
      const { account, x, y, z, baselineSetId } = await plant(database, "upload-then-upload");
      const first = await stagedUpload(database, account, [
        [x.name, "10"],
        [y.name, "20"],
        [z.name, "5"],
      ]);
      const second = await stagedUpload(database, account, [[x.name, "10"]]);
      const firstRevision = await revisionFor(database, first, today());
      const secondRevision = await revisionFor(database, second, today());

      // `second` is drawn before the race against the plant's own set — it cannot know the id of
      // the set `first` is about to land while it waits, so its posted baseline (undefined, i.e.
      // "") is stale by the time it runs against the set `first` actually lands. A writer
      // genuinely did land in the gap, so reason 1 fires and names it — there is no filed-behind
      // story here to subsume it (both commit today's date), unlike an undated file's ordinary
      // first POST, where the "baseline" only ever moves because the loader could not see a date
      // yet to compare against (#181).
      const refusal = await refusalOf(() =>
        behindTheLock(
          database,
          (trx) =>
            commitUpload(
              first,
              { accountId: account.id, asOf: today(), baselineSetId, reviewRevision: firstRevision },
              trx,
            ),
          (trx) =>
            commitUpload(
              second,
              { accountId: account.id, asOf: today(), reviewRevision: secondRevision },
              trx,
            ),
        ),
      );

      // Both reasons fire together: the stale-baseline sentence, and the waiter's own
      // re-classification against the set it actually landed on (issue #283), not the one it was
      // staged against — 3 positions, 2 of them gone in its own one-row file.
      expect(refusal.fieldErrors.form).toMatch(/measured against/);
      expect(refusal.fieldErrors.form).toMatch(/removes 2 of the 3 positions/);
      if (!(refusal instanceof RefusedUpload)) throw refusal;
      expect(refusal.diff.currentCount).toBe(3);
      expect(refusal.diff.removed).toHaveLength(2);
      expect(await latestQuantities(database, account.id)).toEqual({
        [x.id]: "10.00000000",
        [y.id]: "20.00000000",
        [z.id]: "5.00000000",
      });
      expect(await positionSetCount(database, account.id)).toBe(2);
    },
    20_000,
  );

  it(
    "refuses a balance that was waiting while an upload added a security, recording nothing",
    async () => {
      const database = await testDatabase();
      const fixtures = makeFixtures(database);
      const name = (part: string) => `${RACE_PREFIX}upload-then-balance-${part}`;
      const usd = await fixtures.usdInstrument();
      const owner = await fixtures.seedPerson({ name: name("owner") });
      const classification = await fixtures.seedClassification({ name: name("class") });
      const fund = await fixtures.seedInstrument({
        symbol: name("FUND"),
        name: name("FUND"),
        classification,
      });
      await fixtures.seedInstrumentAlias({ instrument: fund, rawString: fund.name });
      await fixtures.seedInstrumentAlias({ instrument: usd, rawString: name("CASH") });
      const account = await fixtures.seedAccount({ name: name("account"), owner, kind: "bank" });
      const baseline = await fixtures.seedPositionSet({
        account,
        asOf: "2026-09-01",
        source: "manual",
        holdings: [{ instrument: usd, quantity: "100" }],
      });
      const draftId = await stagedUpload(database, account, [
        [name("CASH"), "200"],
        [fund.name, "5"],
      ]);
      const reviewRevision = await revisionFor(database, draftId, today());

      const refusal = await refusalOf(() =>
        behindTheLock(
          database,
          (trx) =>
            commitUpload(
              draftId,
              {
                accountId: account.id,
                asOf: today(),
                baselineSetId: baseline.id,
                reviewRevision,
              },
              trx,
            ),
          (trx) => setBalance(account.id, { amount: "300", asOf: today() }, trx),
        ),
      );

      // Read under the lock, the statement now lists a security a typed balance would sell.
      expect(refusal.fieldErrors.form).toMatch(/also lists/);
      expect(await latestQuantities(database, account.id)).toEqual({
        [usd.id]: "200.00000000",
        [fund.id]: "5.00000000",
      });
      // Not hiding behind the upload in history either: the seeded balance and the statement, nothing else.
      expect(await positionSetCount(database, account.id)).toBe(2);
    },
    20_000,
  );

  it(
    "refuses a correction that was waiting while the account closed",
    async () => {
      const database = await testDatabase();
      const { account, x } = await plant(database, "close-then-correction");

      const refusal = await refusalOf(() =>
        behindTheLock(
          database,
          (trx) => closeAccount(account.id, { confirmClose: "true" }, trx),
          (trx) => revisePosition(account.id, x.id, { quantity: "11", costBasisPerShare: "" }, trx),
        ),
      );

      expect(refusal.fieldErrors.form).toMatch(/closed/);
      expect(await positionSetCount(database, account.id)).toBe(1);
    },
    20_000,
  );
});
