// A statement, file to account-page figures. Every step is unit-tested against directly seeded state, which is exactly why
// none can catch a seam (a step writing the right row under the wrong key passes its own test and breaks the flow) — so
// nothing here is seeded past the household; every redirect is followed for real. Two journeys: the second proves the
// design's central promise (§5.1, brief §5) that the work is paid once — it arrives at review asking nothing.
import { afterAll, describe, expect, it } from "vitest";

// Drop screen reads its size limit from config before any byte; getConfig() memoises on first call, not on import, so this is in time.
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

/** The review screen's data, or a failure naming where it redirected instead — a redirect here means a prior step lied about the draft's state. */
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

      // Both instruments are first sightings, so the routing below (the draft's own answer) must go to resolution, not review.
      const toInstruments = await redirectTo(() =>
        saveColumns(args(post(`/upload/${draftId}/columns`, COLUMNS_FORM), { draftId })),
      );
      expect(toInstruments).toBe(`/upload/${draftId}/instruments`);

      const toReview = await redirectTo(() =>
        resolveInstruments(
          args(
            post(`/upload/${draftId}/instruments`, createAnswers(["VTI", "FZROX"])),
            { draftId },
          ),
        ),
      );
      expect(toReview).toBe(`/upload/${draftId}/review`);

      const review = await reviewPage(draftId);
      expect(review.diff.added.map((row) => row.symbol).sort()).toEqual(["FZROX", "VTI"]);
      // No date column in this export, so the screen must ask for one.
      expect(review.diff.asOf.source).not.toBe("file");
      expect(review.diff.removed).toEqual([]);
      expect(await accountHasAnySet(ctx, account.id)).toBe(false);

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

      const page = await accountPage(
        args(get(landing), { accountId: receipt.accountId }),
      );

      // Quantities are the file's own, at the column's scale, as decimal strings.
      expect(page.receipt).toMatchObject({ holdingCount: 2 });
      expect(
        page.holdings
          .map((holding) => [holding.symbol, holding.quantity])
          .sort(([a], [b]) => String(a).localeCompare(String(b))),
      ).toEqual([
        ["FZROX", "500.00000000"],
        ["VTI", "100.00000000"],
      ]);

      // Draft deleted in the same transaction as the write — going back is a 404, not a second commit.
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

      // The whole of January's journey, so February meets a system that genuinely learned, not one a fixture told.
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

      // Columns still opens (confirms the remembered mapping) but goes straight to review — the flow itself skips instruments, not this test.
      const next = await redirectTo(() =>
        saveColumns(args(post(`/upload/${draftId}/columns`, COLUMNS_FORM), { draftId })),
      );
      expect(next).toBe(`/upload/${draftId}/review`);

      // instrumentsSkipped is the only surviving trace once aliases are indistinguishable from any other vocabulary (brief §7.5).
      const review = await reviewPage(draftId);
      expect(review.steps).toMatchObject({ current: 4, instrumentsSkipped: true });

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

      const page = await accountPage(
        args(get(landing), { accountId: receiptFrom(landing).accountId }),
      );

      expect(
        page.holdings.find((holding) => holding.symbol === "VTI")?.quantity,
      ).toBe("120.00000000");
      // Immutable spine: committing superseded January, never edited it.
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
