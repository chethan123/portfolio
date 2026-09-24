// withAccountLock (accounts.server.ts, ARCHITECTURE.md §7.2): every writer that appends a position
// set, and closeAccount, waits its turn on the account row. Two connections and committed rows,
// because withDatabase's one rolled-back transaction cannot contend with itself; every row planted
// here carries RACE_PREFIX and is swept at both ends.
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeAccount, getAccount, withAccountLock } from "~/lib/accounts.server";
import { setBalance } from "~/lib/balances.server";
import { ValidationError } from "~/lib/input.server";
import { revisePosition } from "~/lib/positions.server";
import {
  RefusedUpload,
  StaleReviewError,
  answerAccountNumbers,
  recordUpload,
  reviewForDraft,
  type CommitInput,
} from "~/lib/uploads.server";
import { sectionKey } from "~/lib/review-form";

import {
  backendPid,
  closeTestDatabase,
  testDatabase,
  waitUntilBlocked,
} from "./support/database.ts";
import { RACE_PREFIX, clearRaces, makeFixtures, renumber } from "./support/fixtures.ts";
import { onlySection, posted } from "./support/review.ts";

import type { Database } from "~/lib/db.server";
import type { StatementMapping } from "~/lib/statement";
import type { Kysely } from "kysely";
import type { SeededAccount, SeededInstrument, SeededPerson } from "./support/fixtures.ts";

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
  {
    waiterBeginsFirst = false,
    whileWaiting,
  }: { waiterBeginsFirst?: boolean; whileWaiting?: () => Promise<void> } = {},
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
    await whileWaiting?.();

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
  // The seeded set's own id — every recordUpload call here is dated after it, so it is the
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

/** `waits` runs against the account while an uncommitted owner change to `owner` holds its row (#332). */
function behindAnOwnerChange<T>(
  database: Kysely<Database>,
  account: SeededAccount,
  owner: SeededPerson,
  waits: Writer<T>,
): Promise<T> {
  return behindTheLock(
    database,
    (trx) =>
      trx.updateTable("account").set({ owner_id: owner.id }).where("id", "=", account.id).execute(),
    waits,
  );
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
          recordUpload(
            draftId,
            {
              accountId: account.id,
              asOf: today(),
              [sectionKey("baselineSetId", account.id)]: baselineSetId,
              reviewRevision,
            },
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
    "reads the statement it lands on when an upload waited on another and refuses its stale review",
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
      // "") is stale by the time it runs against the set `first` actually lands. The revision
      // also binds that account state, so the stale-review guard fires before confirmations.
      const refusal = await refusalOf(() =>
        behindTheLock(
          database,
          (trx) =>
            recordUpload(
              first,
              {
                accountId: account.id,
                asOf: today(),
                [sectionKey("baselineSetId", account.id)]: baselineSetId,
                reviewRevision: firstRevision,
              },
              trx,
            ),
          (trx) =>
            recordUpload(
              second,
              { accountId: account.id, asOf: today(), reviewRevision: secondRevision },
              trx,
            ),
        ),
      );

      // The warning takes precedence, while its carried diff still proves the waiter reclassified
      // against the set it actually landed on (issue #283): 3 positions, 2 absent from its file.
      expect(refusal.fieldErrors.form).toMatch(/statement or its account changed/);
      expect(refusal.fieldErrors.form).not.toMatch(/measured against/);
      expect(refusal.fieldErrors.form).not.toMatch(/removes 2 of the 3 positions/);
      if (!(refusal instanceof StaleReviewError)) throw refusal;
      const section = onlySection(refusal.diff);
      expect(section.currentCount).toBe(3);
      expect(section.removed).toHaveLength(2);
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
            recordUpload(
              draftId,
              {
                accountId: account.id,
                asOf: today(),
                [sectionKey("baselineSetId", account.id)]: baseline.id,
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

  it(
    "records a balance that was waiting while the account changed owner",
    async () => {
      const database = await testDatabase();
      const fixtures = makeFixtures(database);
      const name = (part: string) => `${RACE_PREFIX}owner-then-balance-${part}`;
      const account = await fixtures.seedAccount({
        name: name("account"),
        kind: "bank",
        // Named, not defaulted: an auto-seeded "Person N" is outside the sweep and strands a row.
        owner: await fixtures.seedPerson({ name: name("owner") }),
      });
      const newOwner = await fixtures.seedPerson({ name: name("new-owner") });

      await behindAnOwnerChange(database, account, newOwner, (trx) =>
        setBalance(account.id, { amount: "300", asOf: today() }, trx),
      );

      expect(await positionSetCount(database, account.id)).toBe(1);
      expect((await getAccount(account.id, database)).ownerId).toBe(newOwner.id);
    },
    20_000,
  );

  it(
    "records a correction that was waiting while the account changed owner",
    async () => {
      const database = await testDatabase();
      const { account, x, y } = await plant(database, "owner-then-correction");
      const newOwner = await makeFixtures(database).seedPerson({
        name: `${RACE_PREFIX}owner-then-correction-new-owner`,
      });

      await behindAnOwnerChange(database, account, newOwner, (trx) =>
        revisePosition(account.id, x.id, { quantity: "11", costBasisPerShare: "" }, trx),
      );

      expect(await latestQuantities(database, account.id)).toEqual({
        [x.id]: "11.00000000",
        [y.id]: "20.00000000",
      });
      expect((await getAccount(account.id, database)).ownerId).toBe(newOwner.id);
    },
    20_000,
  );

  it(
    "records an upload commit that was waiting while the account changed owner",
    async () => {
      const database = await testDatabase();
      const { account, x, y, baselineSetId } = await plant(database, "owner-then-upload");
      const newOwner = await makeFixtures(database).seedPerson({
        name: `${RACE_PREFIX}owner-then-upload-new-owner`,
      });
      const draftId = await stagedUpload(database, account, [
        [x.name, "100"],
        [y.name, "200"],
      ]);
      const reviewRevision = await revisionFor(database, draftId, today());

      await behindAnOwnerChange(database, account, newOwner, (trx) =>
        recordUpload(
          draftId,
          {
            accountId: account.id,
            asOf: today(),
            [sectionKey("baselineSetId", account.id)]: baselineSetId,
            reviewRevision,
          },
          trx,
        ),
      );

      expect(await latestQuantities(database, account.id)).toEqual({
        [x.id]: "100.00000000",
        [y.id]: "200.00000000",
      });
      expect((await getAccount(account.id, database)).ownerId).toBe(newOwner.id);
    },
    20_000,
  );

  it(
    "closes an account that changed owner while the closure waited",
    async () => {
      const database = await testDatabase();
      const { account } = await plant(database, "owner-then-close");
      const newOwner = await makeFixtures(database).seedPerson({
        name: `${RACE_PREFIX}owner-then-close-new-owner`,
      });

      const closed = await behindAnOwnerChange(database, account, newOwner, (trx) =>
        closeAccount(account.id, { confirmClose: "true" }, trx),
      );

      expect(closed.isClosed).toBe(true);
      expect((await getAccount(account.id, database)).ownerId).toBe(newOwner.id);
    },
    20_000,
  );

  it(
    "hands the lock body the owner the account gained while the writer waited",
    async () => {
      const database = await testDatabase();
      const { account } = await plant(database, "owner-then-lock");
      const newOwner = await makeFixtures(database).seedPerson({
        name: `${RACE_PREFIX}owner-then-lock-new-owner`,
      });

      const handed = await behindAnOwnerChange(database, account, newOwner, (trx) =>
        withAccountLock(account.id, trx, async (locked) => locked),
      );

      expect(handed.ownerId).toBe(newOwner.id);
      expect(handed.ownerName).toBe(newOwner.name);
    },
    20_000,
  );
});

type PlantedSeveral = {
  lower: SeededAccount;
  higher: SeededAccount;
  x: SeededInstrument;
  name: (part: string) => string;
  draftId: string;
  fields: CommitInput;
};

const SEVERAL: StatementMapping = {
  headerRow: 0,
  delimiter: ",",
  columns: { instrument: "Symbol", quantity: "Qty", accountNumber: "Account" },
  costBasisIs: "per_share",
  owedAsPositive: false,
  combineDuplicateRows: true,
  multiAccount: true,
};

/** Two committed, numbered accounts and a reviewed multi-account draft naming both, the higher
 * id first in the file so that file order is not lock order. */
async function plantSeveral(database: Kysely<Database>, tag: string): Promise<PlantedSeveral> {
  const fixtures = makeFixtures(database);
  const name = (part: string) => `${RACE_PREFIX}${tag}-${part}`;
  const owner = await fixtures.seedPerson({ name: name("owner") });
  const classification = await fixtures.seedClassification({ name: name("class") });
  const x = await fixtures.seedInstrument({ symbol: name("X"), name: name("X"), classification });
  await fixtures.seedInstrumentAlias({ instrument: x, rawString: x.name });
  const lower = await fixtures.seedAccount({
    name: name("lower"),
    owner,
    externalAccountNumber: name("L"),
  });
  const higher = await fixtures.seedAccount({
    name: name("higher"),
    owner,
    externalAccountNumber: name("H"),
  });
  const csv = `Account,Symbol,Qty\n${name("H")},${x.name},2\n${name("L")},${x.name},1\n`;
  const draft = await fixtures.seedUploadDraft({
    account: null,
    filename: name("several.csv"),
    bytes: new TextEncoder().encode(csv),
    mapping: SEVERAL,
    hadFirstSightings: false,
  });

  const review = await reviewForDraft(draft.id, today(), database);
  const fields = posted(review, { asOf: today() });
  return { lower, higher, x, name, draftId: draft.id, fields };
}

type PlantedNumber = {
  owner: SeededPerson;
  number: string;
  name: (part: string) => string;
  // A multi-account draft whose one row names `number`, over the accounts as they stand.
  draftNaming: () => Promise<string>;
};

async function plantNumber(database: Kysely<Database>, tag: string): Promise<PlantedNumber> {
  const fixtures = makeFixtures(database);
  const name = (part: string) => `${RACE_PREFIX}${tag}-${part}`;
  const owner = await fixtures.seedPerson({ name: name("owner") });
  const classification = await fixtures.seedClassification({ name: name("class") });
  const x = await fixtures.seedInstrument({ symbol: name("X"), name: name("X"), classification });
  await fixtures.seedInstrumentAlias({ instrument: x, rawString: x.name });
  const number = name("N");

  const draftNaming = async () => {
    const draft = await fixtures.seedUploadDraft({
      account: null,
      filename: name("one-number.csv"),
      bytes: new TextEncoder().encode(`Account,Symbol,Qty\n${number},${x.name},1\n`),
      mapping: SEVERAL,
      hadFirstSightings: false,
    });
    return draft.id;
  };

  return { owner, number, name, draftNaming };
}

describe("a multi-account commit's locks", () => {
  it(
    "takes them in ascending id, already holding the lower while it waits on the higher",
    async () => {
      const database = await testDatabase();
      const { lower, higher, x, draftId, fields } = await plantSeveral(database, "several-order");

      await behindTheLock(
        database,
        (trx) => withAccountLock(higher.id, trx, async () => undefined),
        (trx) => recordUpload(draftId, fields, trx),
        {
          whileWaiting: async () => {
            const probe = await database.startTransaction().execute();
            try {
              await expect(
                probe
                  .selectFrom("account")
                  .select("id")
                  .where("id", "=", lower.id)
                  .forNoKeyUpdate()
                  .noWait()
                  .execute(),
              ).rejects.toMatchObject({ code: "55P03" });
            } finally {
              await probe.rollback().execute();
            }
          },
        },
      );

      expect(await latestQuantities(database, lower.id)).toEqual({ [x.id]: "1.00000000" });
      expect(await latestQuantities(database, higher.id)).toEqual({ [x.id]: "2.00000000" });
    },
    20_000,
  );

  it(
    "keeps a correction that waited on it, carrying the upload forward",
    async () => {
      const database = await testDatabase();
      const { lower, higher, x, draftId, fields } = await plantSeveral(
        database,
        "several-then-correction",
      );

      await behindTheLock(
        database,
        (trx) => recordUpload(draftId, fields, trx),
        (trx) => revisePosition(lower.id, x.id, { quantity: "11", costBasisPerShare: "" }, trx),
      );

      expect(await latestQuantities(database, lower.id)).toEqual({ [x.id]: "11.00000000" });
      expect(await positionSetCount(database, lower.id)).toBe(2);
      expect(await latestQuantities(database, higher.id)).toEqual({ [x.id]: "2.00000000" });
    },
    20_000,
  );

  it(
    "refuses a commit that waited on another over the same account, naming that account and recording nothing",
    async () => {
      const database = await testDatabase();
      const { lower, higher, x, name, draftId, fields } = await plantSeveral(
        database,
        "several-then-several",
      );
      const loser = await makeFixtures(database).seedUploadDraft({
        account: null,
        filename: name("higher.csv"),
        bytes: new TextEncoder().encode(`Account,Symbol,Qty\n${name("H")},${x.name},3\n`),
        mapping: SEVERAL,
        hadFirstSightings: false,
      });
      const loserReview = await reviewForDraft(loser.id, today(), database);
      const loserFields = posted(loserReview, { asOf: today() });

      const refusal = await refusalOf(() =>
        behindTheLock(
          database,
          (trx) => recordUpload(draftId, fields, trx),
          (trx) => recordUpload(loser.id, loserFields, trx),
        ),
      );

      expect(refusal).toBeInstanceOf(StaleReviewError);
      expect(refusal.fieldErrors.form).toContain(`Figures were recorded on ${higher.name} after`);
      expect(await positionSetCount(database, lower.id)).toBe(1);
      expect(await positionSetCount(database, higher.id)).toBe(1);
      expect(await latestQuantities(database, higher.id)).toEqual({ [x.id]: "2.00000000" });
    },
    20_000,
  );

  it(
    "refuses rows the locked re-read routes to an account it holds no lock on, recording nothing",
    async () => {
      const database = await testDatabase();
      const { owner, number, name, draftNaming } = await plantNumber(database, "number-returns");
      const moved = await makeFixtures(database).seedAccount({ name: name("moved"), owner });
      const home = await makeFixtures(database).seedAccount({
        name: name("home"),
        owner,
        externalAccountNumber: number,
      });
      const draftId = await draftNaming();
      const review = await reviewForDraft(draftId, today(), database);
      const fields = posted(review, { asOf: today() });

      // After review the number moves, so the commit's unlocked read locks the other account...
      await renumber(database, home, null);
      await renumber(database, moved, number);

      const refusal = await refusalOf(() =>
        behindTheLock(
          database,
          // ...and moves home while the commit waits, reproducing the reviewed revision exactly.
          async (trx) => {
            await renumber(trx, moved, null);
            await renumber(trx, home, number);
          },
          (trx) => recordUpload(draftId, fields, trx),
        ),
      );

      expect(refusal).toBeInstanceOf(StaleReviewError);
      expect(refusal.fieldErrors.form).toBe(
        "An account number changed while this file was being recorded, and its rows now go to " +
          `${home.name}. Nothing was recorded — check it and record again.`,
      );
      expect(await positionSetCount(database, home.id)).toBe(0);
      expect(await positionSetCount(database, moved.id)).toBe(0);
    },
    20_000,
  );
});

describe("an answered account number at commit", () => {
  it(
    "refuses a number Settings records on another open account while the commit waits to write it, naming that account",
    async () => {
      const database = await testDatabase();
      const { owner, number, name, draftNaming } = await plantNumber(database, "number-taken");
      const answered = await makeFixtures(database).seedAccount({ name: name("answered"), owner });
      const other = await makeFixtures(database).seedAccount({ name: name("other"), owner });
      const draftId = await draftNaming();
      await answerAccountNumbers(
        draftId,
        { "number-0": number, "accountId-0": answered.id },
        database,
      );
      const review = await reviewForDraft(draftId, today(), database);
      const fields = posted(review, { asOf: today() });

      const refusal = await refusalOf(() =>
        behindTheLock(
          database,
          (trx) => renumber(trx, other, number),
          (trx) => recordUpload(draftId, fields, trx),
        ),
      );

      expect(refusal).toBeInstanceOf(RefusedUpload);
      expect(refusal.fieldErrors.form).toBe(
        `${answered.name}: account number "${number}" is already recorded on ${other.name}, ` +
          `owned by ${owner.name}, so nothing was recorded. Choose again for it.`,
      );
      expect(await positionSetCount(database, answered.id)).toBe(0);
      expect((await getAccount(answered.id, database)).externalAccountNumber).toBeNull();
    },
    20_000,
  );
});
