// Coverage beyond the three rewritten repro tests (#181): the four chronological orderings a
// statement's date can take against an account's history, the confirmation's binding to the
// baseline it was drawn against, and the one case that must never loop — a first statement.
import { afterAll, describe, expect, it } from "vitest";

import Review, {
  action as reviewAction,
  loader as reviewLoader,
} from "../../app/routes/upload/review.tsx";
import { lastRecorded } from "~/lib/balances.server";
import { RefusedUpload, commitUpload, diffForDraft, rememberMapping } from "~/lib/uploads.server";

import { closeTestDatabase, withDatabase } from "../support/database.ts";
import { args, get, post } from "../support/routes.ts";
import { renderRoute } from "../support/render.tsx";

import type { StatementMapping } from "~/lib/statement";
import type { SeededAccount } from "../support/fixtures.ts";
import type { TestContext } from "../support/database.ts";

afterAll(closeTestDatabase);

const encode = (text: string) => new TextEncoder().encode(text);

const MAPPING: StatementMapping = {
  headerRow: 0,
  delimiter: ",",
  columns: { instrument: "Symbol", quantity: "Quantity", costBasis: "Basis" },
  costBasisIs: "per_share",
  owedAsPositive: false,
  combineDuplicateRows: true,
};

async function stage(
  { db, seedUploadDraft }: Pick<TestContext, "db" | "seedUploadDraft">,
  account: SeededAccount,
  csv: string,
): Promise<string> {
  const draft = await seedUploadDraft({ account, filename: "Statement.csv", bytes: encode(csv) });

  const outcome = await rememberMapping(draft.id, MAPPING, db);
  if ("problems" in outcome) {
    throw new Error(
      "This fixture's mapping does not parse its own file: " +
        outcome.problems.map((problem) => problem.message).join(" "),
    );
  }

  return draft.id;
}

describe("baseline resolution against an account's history", () => {
  it(
    "reads no baseline for a date before every existing set, and says so as filed behind",
    withDatabase(async (ctx) => {
      const { db, seedAccount, seedInstrument, seedInstrumentAlias, seedPositionSet } = ctx;
      const account = await seedAccount({ kind: "brokerage" });
      const fund = await seedInstrument({ symbol: "ORD", name: "Ordering Fund" });
      await seedInstrumentAlias({ instrument: fund, rawString: "ORD" });
      await seedPositionSet({
        account,
        asOf: "2026-06-30",
        holdings: [{ instrument: fund, quantity: "100" }],
      });

      // Undated: the loader's own view before a date is typed reads the account's current set,
      // exactly as it always has — there is no date yet for the diff to compare against.
      const draftId = await stage(ctx, account, "Symbol,Quantity,Basis\nORD,10,\n");
      const undatedDiff = await diffForDraft(draftId, db);
      expect(undatedDiff.firstStatement).toBe(false);
      expect(undatedDiff.filedBehind).toBeNull();

      // Dated ahead of every set the account holds — the diff the commit actually acts on.
      const refusal = await refusalOf(() =>
        commitUpload(draftId, { accountId: account.id, asOf: "2026-01-01" }, db),
      );
      expect(refusal.diff.baselineSetId).toBeNull();
      expect(refusal.diff.firstStatement).toBe(true);
      expect(refusal.diff.filedBehind).toEqual({ asOf: "2026-01-01", currentAsOf: "2026-06-30" });
    }),
  );

  it(
    "reads the set immediately before the upload's date when it sits between two statements",
    withDatabase(async (ctx) => {
      const { db, seedAccount, seedInstrument, seedInstrumentAlias, seedPositionSet } = ctx;
      const account = await seedAccount({ kind: "brokerage" });
      const fund = await seedInstrument({ symbol: "ORD", name: "Ordering Fund" });
      await seedInstrumentAlias({ instrument: fund, rawString: "ORD" });
      const early = await seedPositionSet({
        account,
        asOf: "2026-06-30",
        holdings: [{ instrument: fund, quantity: "100" }],
      });
      await seedPositionSet({
        account,
        asOf: "2026-09-09",
        holdings: [{ instrument: fund, quantity: "150" }],
      });

      const draftId = await stage(ctx, account, "Symbol,Quantity,Basis\nORD,120,\n");
      const refusal = await refusalOf(() =>
        commitUpload(draftId, { accountId: account.id, asOf: "2026-07-31" }, db),
      );
      expect(refusal.diff.baselineSetId).toBe(early.id);
      expect(refusal.diff.firstStatement).toBe(false);
      expect(refusal.diff.filedBehind).toEqual({ asOf: "2026-07-31", currentAsOf: "2026-09-09" });
    }),
  );

  it(
    "resolves a same-date upload to the set already recorded for it, and lets the new one win the tie once committed",
    withDatabase(async (ctx) => {
      const { db, seedAccount, seedInstrument, seedInstrumentAlias, seedPositionSet } = ctx;
      const account = await seedAccount({ kind: "brokerage" });
      const fund = await seedInstrument({ symbol: "ORD", name: "Ordering Fund" });
      await seedInstrumentAlias({ instrument: fund, rawString: "ORD" });
      // A past, explicit createdAt — never a future one: created_at must stay monotonic, or the
      // tie-break this test pins would not hold.
      const existing = await seedPositionSet({
        account,
        asOf: "2026-06-30",
        createdAt: new Date("2026-06-30T12:00:00Z"),
        holdings: [{ instrument: fund, quantity: "100" }],
      });

      const draftId = await stage(ctx, account, "Symbol,Quantity,Basis\nORD,120,\n");
      // The commit resolves the same date the file's own history already carries.
      const written = await commitUpload(
        draftId,
        { accountId: account.id, asOf: "2026-06-30", baselineSetId: existing.id },
        db,
      );
      expect(written.setId).not.toBe(existing.id);

      // The tie is broken in the new set's favour — it is what the account now reads.
      expect((await lastRecorded(account.id, db))?.id).toBe(written.setId);
    }),
  );

  it(
    "reads the account's own current set as the baseline for a date after every one recorded",
    withDatabase(async (ctx) => {
      const { db, seedAccount, seedInstrument, seedInstrumentAlias, seedPositionSet } = ctx;
      const account = await seedAccount({ kind: "brokerage" });
      const fund = await seedInstrument({ symbol: "ORD", name: "Ordering Fund" });
      await seedInstrumentAlias({ instrument: fund, rawString: "ORD" });
      const existing = await seedPositionSet({
        account,
        asOf: "2026-06-30",
        holdings: [{ instrument: fund, quantity: "100" }],
      });

      const draftId = await stage(ctx, account, "Symbol,Quantity,Basis\nORD,130,\n");
      // The 99% case: forward-dated (but not into the future recordedDate itself refuses), so no
      // filed-behind confirmation is asked for at all.
      const written = await commitUpload(
        draftId,
        { accountId: account.id, asOf: "2026-09-15", baselineSetId: existing.id },
        db,
      );
      expect(written.asOf).toBe("2026-09-15");
    }),
  );
});

describe("the confirmation binds to the baseline it was drawn against", () => {
  it(
    "refuses a confirmed submit and records nothing when the typed date changed after the refusal",
    withDatabase(async (ctx) => {
      const { db, seedAccount, seedInstrument, seedInstrumentAlias, seedPositionSet } = ctx;
      const account = await seedAccount({ kind: "brokerage" });
      const fund = await seedInstrument({ symbol: "ORD", name: "Ordering Fund" });
      await seedInstrumentAlias({ instrument: fund, rawString: "ORD" });
      const early = await seedPositionSet({
        account,
        asOf: "2026-06-30",
        holdings: [{ instrument: fund, quantity: "100" }],
      });
      await seedPositionSet({
        account,
        asOf: "2026-09-09",
        holdings: [{ instrument: fund, quantity: "150" }],
      });

      const draftId = await stage(ctx, account, "Symbol,Quantity,Basis\nORD,120,\n");
      const first = await refusalOf(() =>
        commitUpload(draftId, { accountId: account.id, asOf: "2026-07-31" }, db),
      );
      expect(first.diff.baselineSetId).toBe(early.id);

      // The reader edits the date to one after every statement recorded, but the browser still
      // carries the earlier refusal's hidden baselineSetId — nobody re-rendered in between.
      const second = await refusalOf(() =>
        commitUpload(
          draftId,
          {
            accountId: account.id,
            asOf: "2026-09-14",
            baselineSetId: first.diff.baselineSetId ?? "",
            confirmFiledBehind: "true",
          },
          db,
        ),
      );
      // 2026-09-14 is after every statement recorded, so there is nothing to be filed behind —
      // the refusal is the stale baseline alone, not a fresh filed-behind demand.
      expect(second.diff.filedBehind).toBeNull();
      expect(second.diff.baselineSetId).not.toBe(early.id);
      expect(second.fieldErrors.form).toMatch(/recorded history changed after this review was drawn/);

      const sets = await db
        .selectFrom("position_set")
        .select("id")
        .where("account_id", "=", account.id)
        .execute();
      expect(sets).toHaveLength(2); // exactly what was seeded — nothing landed either time
    }),
  );

  it(
    "refuses a confirmed submit and records nothing when another writer landed a set in the gap",
    withDatabase(async (ctx) => {
      const { db, seedAccount, seedInstrument, seedInstrumentAlias, seedPositionSet } = ctx;
      const account = await seedAccount({ kind: "brokerage" });
      const fund = await seedInstrument({ symbol: "ORD", name: "Ordering Fund" });
      await seedInstrumentAlias({ instrument: fund, rawString: "ORD" });
      const early = await seedPositionSet({
        account,
        asOf: "2026-06-30",
        holdings: [{ instrument: fund, quantity: "100" }],
      });
      await seedPositionSet({
        account,
        asOf: "2026-09-09",
        holdings: [{ instrument: fund, quantity: "150" }],
      });

      const draftId = await stage(ctx, account, "Symbol,Quantity,Basis\nORD,120,\n");
      const first = await refusalOf(() =>
        commitUpload(draftId, { accountId: account.id, asOf: "2026-07-31" }, db),
      );
      expect(first.diff.baselineSetId).toBe(early.id);

      // A second tab lands a statement in the gap, between the refused baseline and the date this
      // draft is dated for — the true baseline for 2026-07-31 has moved without this form knowing.
      await seedPositionSet({
        account,
        asOf: "2026-07-15",
        holdings: [{ instrument: fund, quantity: "110" }],
      });

      const second = await refusalOf(() =>
        commitUpload(
          draftId,
          {
            accountId: account.id,
            asOf: "2026-07-31",
            baselineSetId: first.diff.baselineSetId ?? "",
            confirmFiledBehind: "true",
          },
          db,
        ),
      );
      expect(second.diff.baselineSetId).not.toBe(early.id);
      // The tick this submit carried was real, so a baseline that still moved under it is
      // genuinely stale — unlike an untouched first submission, this one names the sentence.
      expect(second.fieldErrors.form).toMatch(/recorded history changed after this review was drawn/);

      const holdings = await db
        .selectFrom("holding")
        .innerJoin("position_set", "position_set.id", "holding.position_set_id")
        .select("holding.quantity")
        .where("position_set.account_id", "=", account.id)
        .where("position_set.as_of_date", "=", "2026-07-31")
        .execute();
      expect(holdings).toHaveLength(0); // the draft's own statement never landed
    }),
  );

  it(
    "names the true removal once a majority-removal tick given against the undated baseline is superseded by a typed date",
    withDatabase(async (ctx) => {
      const { db, seedAccount, seedInstrument, seedInstrumentAlias, seedPositionSet } = ctx;
      const account = await seedAccount({ kind: "brokerage" });
      const alpha = await seedInstrument({ symbol: "ALPHA", name: "Alpha Fund" });
      const beta = await seedInstrument({ symbol: "BETA", name: "Beta Fund" });
      const gamma = await seedInstrument({ symbol: "GAMMA", name: "Gamma Fund" });
      const delta = await seedInstrument({ symbol: "DELTA", name: "Delta Fund" });
      const epsilon = await seedInstrument({ symbol: "EPSILON", name: "Epsilon Fund" });
      const zeta = await seedInstrument({ symbol: "ZETA", name: "Zeta Fund" });
      const eta = await seedInstrument({ symbol: "ETA", name: "Eta Fund" });
      await seedInstrumentAlias({ instrument: alpha, rawString: "ALPHA" });

      // The true baseline for a statement dated between these: 5 positions, of which the file
      // below keeps only one.
      await seedPositionSet({
        account,
        asOf: "2026-06-30",
        holdings: [
          { instrument: alpha, quantity: "100" },
          { instrument: beta, quantity: "50" },
          { instrument: gamma, quantity: "20" },
          { instrument: delta, quantity: "10" },
          { instrument: epsilon, quantity: "5" },
        ],
      });
      // The account's current set: 3 positions, 2 of which the same file would also drop —
      // this is what the undated loader shows before any date is typed.
      await seedPositionSet({
        account,
        asOf: "2026-09-09",
        holdings: [
          { instrument: alpha, quantity: "150" },
          { instrument: zeta, quantity: "30" },
          { instrument: eta, quantity: "15" },
        ],
      });

      const draftId = await stage(ctx, account, "Symbol,Quantity,Basis\nALPHA,120,\n");

      // The undated review (the loader's own view, before a date is typed) shows the
      // majority-removal box against the account's current set — 2 of its 3 positions.
      const undated = await diffForDraft(draftId, db);
      expect(undated.baselineSetId).not.toBeNull();
      expect(undated.currentCount).toBe(3);
      expect(undated.majorityRemoved).toBe(true);

      // The household ticks that box, types a backdated date, and submits — the review's first
      // POST is the round trip (there is no GET in between to re-render against the real baseline).
      const response = await reviewAction(
        args(
          post(`/upload/${draftId}/review`, {
            accountId: account.id,
            asOf: "2026-07-31",
            baselineSetId: undated.baselineSetId ?? "",
            confirmRemovals: "true",
          }),
          { draftId },
        ),
      );
      if (response instanceof Response) throw new Error("Expected data back, got a redirect.");

      // The dated diff is against 2026-06-30 (5 positions), not the undated one the tick answered
      // for — a tick given against the wrong baseline must not silence the real removal it never
      // actually confirmed.
      expect(response.diff?.baselineSetId).not.toBe(undated.baselineSetId);
      expect(response.diff?.currentCount).toBe(5);
      expect(response.diff?.removed).toHaveLength(4);
      expect(response.formError).toMatch(/removes 4 of the 5 positions recorded on 2026-06-30/);
    }),
  );

  it(
    "renders neither confirmation ticked once the baseline it was given against has moved",
    withDatabase(async (ctx) => {
      const { db, seedAccount, seedInstrument, seedInstrumentAlias, seedPositionSet } = ctx;
      const account = await seedAccount({ kind: "brokerage" });
      const alpha = await seedInstrument({ symbol: "ALPHA", name: "Alpha Fund" });
      const beta = await seedInstrument({ symbol: "BETA", name: "Beta Fund" });
      const gamma = await seedInstrument({ symbol: "GAMMA", name: "Gamma Fund" });
      await seedInstrumentAlias({ instrument: alpha, rawString: "ALPHA" });
      await seedPositionSet({
        account,
        asOf: "2026-06-30",
        holdings: [
          { instrument: alpha, quantity: "100" },
          { instrument: beta, quantity: "50" },
          { instrument: gamma, quantity: "20" },
        ],
      });
      await seedPositionSet({
        account,
        asOf: "2026-09-09",
        holdings: [{ instrument: alpha, quantity: "150" }],
      });

      const draftId = await stage(ctx, account, "Symbol,Quantity,Basis\nALPHA,120,\n");

      // First submit: both the filed-behind and majority-removal confirmations are demanded.
      const firstResponse = await reviewAction(
        args(post(`/upload/${draftId}/review`, { accountId: account.id, asOf: "2026-07-31" }), {
          draftId,
        }),
      );
      if (firstResponse instanceof Response) throw new Error("Expected data back, got a redirect.");
      expect(firstResponse.diff?.filedBehind).not.toBeNull();
      expect(firstResponse.diff?.majorityRemoved).toBe(true);

      // Another tab lands a statement in the gap before the reader ticks and resubmits.
      await seedPositionSet({
        account,
        asOf: "2026-07-15",
        holdings: [{ instrument: alpha, quantity: "110" }],
      });

      // The reader ticks both boxes and resubmits — but against the baseline now superseded.
      const secondResponse = await reviewAction(
        args(
          post(`/upload/${draftId}/review`, {
            accountId: account.id,
            asOf: "2026-07-31",
            baselineSetId: firstResponse.diff?.baselineSetId ?? "",
            confirmFiledBehind: "true",
            confirmRemovals: "true",
          }),
          { draftId },
        ),
      );
      if (secondResponse instanceof Response) throw new Error("Expected data back, got a redirect.");

      const loaderData = await reviewLoader(args(get(`/upload/${draftId}/review`), { draftId }));
      if (loaderData instanceof Response) throw new Error("Expected the review screen, not a redirect.");

      const markup = renderRoute(Review, `/upload/${draftId}/review`, loaderData, {
        actionData: secondResponse,
      });
      // Both boxes still render — proving the checkbox is unticked, not gone.
      expect(markup).toContain('name="confirmFiledBehind"');
      expect(markup).not.toContain("checked");
    }),
  );
});

describe("a first statement", () => {
  it(
    "commits once, with baselineSetId posted as the empty string, and no refusal loop",
    withDatabase(async (ctx) => {
      const { db, seedAccount, seedInstrument, seedInstrumentAlias } = ctx;
      const account = await seedAccount({ kind: "brokerage" });
      const fund = await seedInstrument({ symbol: "NEW", name: "New Account Fund" });
      await seedInstrumentAlias({ instrument: fund, rawString: "NEW" });

      const draftId = await stage(ctx, account, "Symbol,Quantity,Basis\nNEW,10,\n");
      const written = await commitUpload(
        draftId,
        { accountId: account.id, asOf: "2026-06-30", baselineSetId: "" },
        db,
      );
      expect(written.counts).toEqual({ added: 1, updated: 0, unchanged: 0, removed: 0 });

      const sets = await db
        .selectFrom("position_set")
        .select("id")
        .where("account_id", "=", account.id)
        .execute();
      expect(sets).toHaveLength(1); // one submit, one set — no round trip was needed
    }),
  );
});

describe("a removed row against a dated baseline", () => {
  it(
    "is priced from the current quote, never the dated read's own historical close, and null with no quote at all",
    withDatabase(async (ctx) => {
      const {
        db,
        seedAccount,
        seedInstrument,
        seedInstrumentAlias,
        seedPositionSet,
        seedQuote,
        seedDailyClose,
      } = ctx;
      const account = await seedAccount({ kind: "brokerage" });
      const kept = await seedInstrument({ symbol: "KPT", name: "Kept Fund" });
      const priced = await seedInstrument({ symbol: "HST", name: "Historically Priced Fund" });
      const unpriced = await seedInstrument({ symbol: "NVR", name: "Never Priced Fund" });
      await seedInstrumentAlias({ instrument: kept, rawString: "KPT" });

      // The historical close on the baseline's own date disagrees with today's quote — the
      // removed row must use the quote, exactly as an added or updated row would (#181).
      await seedQuote({ instrument: priced, price: "50.00" });
      await seedDailyClose({ instrument: priced, date: "2026-06-30", close: "40.00" });

      await seedPositionSet({
        account,
        asOf: "2026-06-30",
        holdings: [
          { instrument: kept, quantity: "5" },
          { instrument: priced, quantity: "10" },
          { instrument: unpriced, quantity: "3" },
        ],
      });
      await seedPositionSet({
        account,
        asOf: "2026-09-09",
        holdings: [{ instrument: kept, quantity: "5" }],
      });

      // Dated between the two, so the baseline is the 2026-06-30 set — priced and unpriced are
      // both removed against it.
      const draftId = await stage(ctx, account, "Symbol,Quantity,Basis\nKPT,5,\n");
      const refusal = await refusalOf(() =>
        commitUpload(draftId, { accountId: account.id, asOf: "2026-07-31" }, db),
      );

      const removed = new Map(refusal.diff.removed.map((row) => [row.instrumentId, row]));
      // 50.00 x 10, the current quote — never 40.00 x 10, the close on the statement's own date.
      expect(removed.get(priced.id)?.value).toBe("500.0000");
      // No quote at all does not throw; it renders the same "never priced" null every other
      // unpriced row does.
      expect(removed.get(unpriced.id)?.value).toBeNull();
    }),
  );
});

/** The RefusedUpload a call produced, or a failure if it did not refuse that way. */
async function refusalOf(run: () => Promise<unknown>): Promise<RefusedUpload> {
  try {
    await run();
  } catch (error) {
    if (error instanceof RefusedUpload) return error;
    throw error;
  }
  throw new Error("Expected the write to be refused with a diff attached, and it was not.");
}
