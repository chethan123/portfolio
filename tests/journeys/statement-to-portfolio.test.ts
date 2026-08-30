/**
 * A statement, from the file landing to the figures on the account page.
 * Every step is tested on its own with directly seeded state — the right
 * shape for one step's rule, and exactly why none can catch a seam: a step
 * writing the right row under the wrong key passes its own test and breaks
 * the flow. So nothing is seeded past the household: the file is posted to
 * the drop screen, every step driven by its own `action`, each redirect
 * followed to whatever the last one actually named. Two journeys, because
 * the second is the point of the first — the design's central promise
 * (§5.1, brief §5) is that the work is paid once, and the second statement
 * asserts it the only honest way: arriving at review without being asked
 * anything.
 */
import { afterAll, describe, expect, it } from "vitest";

// The drop screen asks the configuration for its size limit before it reads a
// byte, so this file needs a valid environment the same way the container does.
// `getConfig()` memoises on first call rather than on import, and nothing here
// calls it until a test body runs, so assigning at module scope is in time.
process.env.DATABASE_URL ??=
  process.env.TEST_DATABASE_URL ?? "postgres://portfolio:portfolio@127.0.0.1:55432/portfolio_test";

import { action as upload } from "../../app/routes/upload.tsx";
import { action as saveColumns } from "../../app/routes/upload/columns.tsx";
import { action as resolveInstruments } from "../../app/routes/upload/instruments.tsx";
import {
  action as commit,
  loader as reviewScreen,
} from "../../app/routes/upload/review.tsx";
import { loader as accountPage } from "../../app/routes/account.tsx";
import { loader as resumeDraft } from "../../app/routes/upload/index.tsx";

import { closeTestDatabase, withDatabase } from "../support/database.ts";
import { args, get, post, postFile, redirectTo, responseOf } from "../support/routes.ts";

import type { TestContext } from "../support/database.ts";

afterAll(closeTestDatabase);

/**
 * A Fidelity export: two holdings, one of them an instrument nobody has named
 * before, and a cost basis column stating one share's cost.
 */
const JANUARY = [
  "Symbol,Description,Quantity,Average Cost Basis",
  "VTI,Vanguard Total Stock Market ETF,100,241.1875",
  "FZROX,Fidelity ZERO Total Market Index,500,12.4400",
].join("\n");

/** The same brokerage's next export: same header, same instruments, new figures. */
const FEBRUARY = [
  "Symbol,Description,Quantity,Average Cost Basis",
  "VTI,Vanguard Total Stock Market ETF,120,243.9000",
  "FZROX,Fidelity ZERO Total Market Index,500,12.4400",
].join("\n");

/** The columns form as the screen posts it, with the header on the first row. */
const COLUMNS_FORM = {
  headerRow: "0",
  instrument: "Symbol",
  name: "Description",
  quantity: "Quantity",
  costBasis: "Average Cost Basis",
  asOf: "",
  accountNumber: "",
  costBasisIs: "per_share",
};

/** `/upload/123/columns` → `123`. The journey never invents a draft id. */
function draftIdFrom(location: string): string {
  const id = /^\/upload\/(\d+)\//.exec(location)?.[1];
  if (id === undefined) throw new Error(`Expected an upload step URL, got ${location}`);
  return id;
}

/** `/accounts/7?uploaded=42` → both halves, as the account page will read them. */
function receiptFrom(location: string): { accountId: string; setId: string } {
  const match = /^\/accounts\/(\d+)\?uploaded=(\d+)$/.exec(location);
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new Error(`Expected a landing receipt URL, got ${location}`);
  }
  return { accountId: match[1], setId: match[2] };
}

/** Answers the resolution screen with a newly created instrument per string. */
function createAnswers(raws: readonly string[]): Record<string, string> {
  const fields: Record<string, string> = {};

  raws.forEach((raw, index) => {
    Object.assign(fields, {
      [`raw-${index}`]: raw,
      [`kind-${index}`]: "create",
      [`symbol-${index}`]: raw,
      [`name-${index}`]: `${raw} fund`,
      [`priceSource-${index}`]: "manual",
      [`classificationId-${index}`]: "__new__",
      [`newClassificationName-${index}`]: `Class ${raw}`,
      [`newClassificationAssetClass-${index}`]: "equity",
    });
  });

  return fields;
}

/**
 * The review screen's data, or a failure naming where it sent the reader.
 *
 * The loader returns a redirect instead of data when the draft is not ready
 * for a review — so a journey that has arrived here legitimately wants the
 * data, and a redirect means the previous step did not leave the draft the way
 * it claimed to. Narrowed rather than cast, so that failure reads as itself.
 */
async function reviewPage(draftId: string) {
  const outcome = await reviewScreen(args(get(`/upload/${draftId}/review`), { draftId }));

  if (outcome instanceof Response) {
    throw new Error(
      `Expected the review screen, but the draft was sent to ${outcome.headers.get("Location")}.`,
    );
  }
  return outcome;
}

/** A household with one open brokerage account and nothing in it yet. */
async function aHouseholdWithAnAccount(ctx: Pick<TestContext, "seedPerson" | "seedAccount">) {
  const owner = await ctx.seedPerson({ name: "Alice" });
  return ctx.seedAccount({
    name: "Fidelity Taxable",
    institution: "Fidelity",
    kind: "brokerage",
    owner,
  });
}

describe("a first statement, from the drop screen to the account page", () => {
  it(
    "carries the file through every step and lands the figures it stated",
    withDatabase(async (ctx) => {
      const account = await aHouseholdWithAnAccount(ctx);

      // --- The drop screen: choose an account, hand over a file ------------
      const toColumns = await redirectTo(() =>
        upload(
          args(
            postFile("/upload", { name: "January.csv", content: JANUARY }, {
              accountId: account.id,
            }),
          ),
        ),
      );
      const draftId = draftIdFrom(toColumns);
      expect(toColumns).toBe(`/upload/${draftId}/columns`);

      // --- Columns: say what the file's columns mean -----------------------
      // Both instruments are first sightings, so the mapping step must send
      // this reader on to resolution rather than to review. That routing is
      // the draft's own answer, not this test's assumption.
      const toInstruments = await redirectTo(() =>
        saveColumns(args(post(`/upload/${draftId}/columns`, COLUMNS_FORM), { draftId })),
      );
      expect(toInstruments).toBe(`/upload/${draftId}/instruments`);

      // --- Instruments: name what has never been seen ----------------------
      const toReview = await redirectTo(() =>
        resolveInstruments(
          args(
            post(`/upload/${draftId}/instruments`, createAnswers(["VTI", "FZROX"])),
            { draftId },
          ),
        ),
      );
      expect(toReview).toBe(`/upload/${draftId}/review`);

      // --- Review: what a reader is shown before anything is written -------
      // Nothing has been recorded yet, which is the promise the screen makes.
      const review = await reviewPage(draftId);
      expect(review.diff.added.map((row) => row.symbol).sort()).toEqual(["FZROX", "VTI"]);
      // This export carries no date column, so the screen has to ask for one
      // and the reader types it. A file that dated itself would say so here.
      expect(review.diff.asOf.source).not.toBe("file");
      expect(review.diff.removed).toEqual([]);
      expect(await accountHasAnySet(ctx, account.id)).toBe(false);

      // --- Commit: the flow's one write ------------------------------------
      const landing = await redirectTo(() =>
        commit(
          args(
            post(`/upload/${draftId}/review`, {
              accountId: account.id,
              asOf: "2026-01-31",
            }),
            { draftId },
          ),
        ),
      );
      const receipt = receiptFrom(landing);
      expect(receipt.accountId).toBe(account.id);

      // --- The account page the reader actually lands on -------------------
      const page = await accountPage(
        args(get(landing), { accountId: receipt.accountId }),
      );

      // The receipt describes what was recorded, and the quantities are the
      // file's own — at the column's scale, as decimal strings.
      expect(page.receipt).toMatchObject({ holdingCount: 2 });
      expect(
        page.holdings
          .map((holding) => [holding.symbol, holding.quantity])
          .sort(([a], [b]) => String(a).localeCompare(String(b))),
      ).toEqual([
        ["FZROX", "500.00000000"],
        ["VTI", "100.00000000"],
      ]);

      // The draft is gone: the flow staged it, spent it, and deleted it in the
      // same transaction as the write. Going back to it is a 404 rather than a
      // second chance to commit the same file.
      const spent = await responseOf(() =>
        resumeDraft(args(get(`/upload/${draftId}`), { draftId })),
      );
      expect(spent.status).toBe(404);
    }),
  );
});

describe("the same brokerage's next statement", () => {
  it(
    "asks nothing a second time, which is what the mapping and the aliases are for",
    withDatabase(async (ctx) => {
      const account = await aHouseholdWithAnAccount(ctx);

      // The whole of January's journey, so February meets a system that has
      // genuinely learned rather than one a fixture told.
      const first = await redirectTo(() =>
        upload(
          args(
            postFile("/upload", { name: "January.csv", content: JANUARY }, {
              accountId: account.id,
            }),
          ),
        ),
      );
      const firstDraft = draftIdFrom(first);
      await redirectTo(() =>
        saveColumns(args(post(`/upload/${firstDraft}/columns`, COLUMNS_FORM), {
          draftId: firstDraft,
        })),
      );
      await redirectTo(() =>
        resolveInstruments(
          args(post(`/upload/${firstDraft}/instruments`, createAnswers(["VTI", "FZROX"])), {
            draftId: firstDraft,
          }),
        ),
      );
      await redirectTo(() =>
        commit(
          args(
            post(`/upload/${firstDraft}/review`, {
              accountId: account.id,
              asOf: "2026-01-31",
            }),
            { draftId: firstDraft },
          ),
        ),
      );

      // --- February, same header, same instruments -------------------------
      const toColumns = await redirectTo(() =>
        upload(
          args(
            postFile("/upload", { name: "February.csv", content: FEBRUARY }, {
              accountId: account.id,
            }),
          ),
        ),
      );
      const draftId = draftIdFrom(toColumns);

      // The columns screen still opens — the reader confirms the remembered
      // mapping rather than being written past it — but submitting it now goes
      // straight to review, because the file raises no first sighting. The
      // instruments step is skipped by the flow itself, not by this test
      // declining to call it.
      const next = await redirectTo(() =>
        saveColumns(args(post(`/upload/${draftId}/columns`, COLUMNS_FORM), { draftId })),
      );
      expect(next).toBe(`/upload/${draftId}/review`);

      // And the strip records it as skipped rather than passed, which is the
      // only surviving trace once the aliases are indistinguishable from any
      // other vocabulary (brief §7.5).
      const review = await reviewPage(draftId);
      expect(review.steps).toMatchObject({ current: 4, instrumentsSkipped: true });

      // February states a change in VTI and no change in FZROX, so the diff a
      // reader is shown is one changed row rather than two added ones.
      expect(review.diff.added).toEqual([]);
      expect(review.diff.removed).toEqual([]);
      expect(review.diff.updated.map((row) => row.symbol)).toEqual(["VTI"]);

      const landing = await redirectTo(() =>
        commit(
          args(
            post(`/upload/${draftId}/review`, {
              accountId: account.id,
              asOf: "2026-02-28",
            }),
            { draftId },
          ),
        ),
      );

      // --- The account now reads February, and January is history ----------
      const page = await accountPage(
        args(get(landing), { accountId: receiptFrom(landing).accountId }),
      );

      expect(
        page.holdings.find((holding) => holding.symbol === "VTI")?.quantity,
      ).toBe("120.00000000");
      // The immutable spine: committing never edited January, it superseded it.
      expect(await positionSetCount(ctx, account.id)).toBe(2);
    }),
  );
});

async function accountHasAnySet(ctx: TestContext, accountId: string): Promise<boolean> {
  return (await positionSetCount(ctx, accountId)) > 0;
}

/** How many statements this account carries, history included. */
async function positionSetCount(ctx: TestContext, accountId: string): Promise<number> {
  const rows = await ctx.db
    .selectFrom("position_set")
    .select("id")
    .where("account_id", "=", accountId)
    .execute();

  return rows.length;
}
