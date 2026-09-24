// The accounts step of a multi-account upload (spec 0023 decision 2, ADR-0015): each number no
// account records is given to an open account recording none, or skipped. The risk is a number
// given to the wrong account, which the commit then writes onto it for every later file to route
// by, or rows silently dropped. The commit's own rules are multi-account-upload.test.ts's.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import UploadDraftLayout from "../../app/routes/upload/draft.tsx";
import Accounts, { action, loader } from "../../app/routes/upload/accounts.tsx";
import {
  action as reviewAction,
  loader as reviewLoader,
} from "../../app/routes/upload/review.tsx";
import { reviewedFields } from "~/lib/review-form";
import { STALE_REVIEW_MESSAGE, rememberMapping } from "~/lib/uploads.server";

import { closeTestDatabase, withDatabase } from "../support/database.ts";
import { renumber } from "../support/fixtures.ts";
import { renderRoute } from "../support/render.tsx";
import { args, get, post, redirectTo } from "../support/routes.ts";

import type { TestContext } from "../support/database.ts";
import type { SeededAccount } from "../support/fixtures.ts";
import type { StatementMapping } from "~/lib/statement";

afterAll(closeTestDatabase);

const spreadsheet = (): Uint8Array =>
  readFileSync(fileURLToPath(new URL("../fixtures/statements/multi-account.csv", import.meta.url)));

const MULTI: StatementMapping = {
  headerRow: 0,
  delimiter: ",",
  columns: {
    instrument: "Holding",
    name: "Description",
    quantity: "Quantity",
    costBasis: "Cost Basis",
    asOf: "As Of",
    accountNumber: "Account Number",
  },
  costBasisIs: "per_share",
  owedAsPositive: false,
  combineDuplicateRows: true,
  multiAccount: true,
};

const ROTH = "Z98-765432";
const MORTGAGE = "0045501234";

/** multi-account.csv's accounts: only the first records its number; one closed account besides. */
async function seedHousehold(ctx: Pick<TestContext, "seedAccount">) {
  return {
    individual: await ctx.seedAccount({
      name: "Individual brokerage",
      externalAccountNumber: "Z12-345678",
    }),
    roth: await ctx.seedAccount({ name: "Roth IRA", kind: "ira", taxTreatment: "tax_free" }),
    mortgage: await ctx.seedAccount({ name: "Home mortgage", kind: "liability" }),
    old: await ctx.seedAccount({ name: "Old brokerage", closedAt: "2026-01-01" }),
  };
}

async function resolveEveryString(
  ctx: Pick<TestContext, "seedInstrument" | "seedInstrumentAlias">,
) {
  for (const rawString of ["VTI", "AAPL", "FXAIX", "Home mortgage"]) {
    const instrument = await ctx.seedInstrument({ name: rawString });
    await ctx.seedInstrumentAlias({ instrument, rawString });
  }
}

/** multi-account.csv, or `csv` under its header, past its columns step. */
async function stage(
  ctx: Pick<TestContext, "db" | "seedUploadDraft">,
  csv?: string,
): Promise<string> {
  const draft = await ctx.seedUploadDraft({
    account: null,
    filename: "all-accounts.csv",
    bytes:
      csv === undefined
        ? spreadsheet()
        : new TextEncoder().encode(
            `Holding,Description,Quantity,Cost Basis,As Of,Account Number\n${csv}`,
          ),
  });
  const outcome = await rememberMapping(draft.id, MULTI, ctx.db);
  if ("problems" in outcome) throw new Error(outcome.problems[0]?.message);
  return draft.id;
}

async function screen(draftId: string, search = "") {
  const outcome = await loader(args(get(`/upload/${draftId}/accounts${search}`), { draftId }));
  if (outcome instanceof Response) {
    throw new Error(`Expected Accounts, and it sent ${outcome.headers.get("Location")}.`);
  }
  return outcome;
}

function answer(draftId: string, fields: Record<string, string>) {
  return action(args(post(`/upload/${draftId}/accounts`, fields), { draftId }));
}

/** The form as drawn for multi-account.csv, with the Roth and mortgage numbers answered. */
function answers(roth: string, mortgage: string): Record<string, string> {
  return { "number-0": ROTH, "accountId-0": roth, "number-1": MORTGAGE, "accountId-1": mortgage };
}

async function refusalOf(run: ReturnType<typeof answer>) {
  const outcome = await run;
  if (outcome instanceof Response) {
    throw new Error(`Expected a refusal, and it sent ${outcome.headers.get("Location")}.`);
  }
  return outcome;
}

async function answersOf(db: TestContext["db"], draftId: string) {
  return db
    .selectFrom("upload_draft_account_answer")
    .select(["account_number", "account_id"])
    .where("draft_id", "=", draftId)
    .orderBy("account_number")
    .execute();
}

/** The option a select renders chosen. */
function chosen(markup: string, field: string): string | undefined {
  const select = new RegExp(`<select[^>]*name="${field}"[\\s\\S]*?</select>`).exec(markup)?.[0];
  return /<option value="([^"]*)" selected=""/.exec(select ?? "")?.[1];
}

describe("the accounts step's screen", () => {
  it(
    "asks about each number no account records, offering only open accounts that record none, plus skip",
    withDatabase(async (ctx) => {
      const { roth, mortgage } = await seedHousehold(ctx);
      const draftId = await stage(ctx);

      const page = await screen(draftId);

      expect(
        page.screen.questions.map(({ number, lines, instruments }) => [number, lines, instruments]),
      ).toEqual([
        [ROTH, 2, ["VTI", "FXAIX"]],
        [MORTGAGE, 1, ["Home mortgage"]],
      ]);
      expect(
        page.screen.choices.flatMap((group) => group.options.map((option) => option.id)).sort(),
      ).toEqual([roth.id, mortgage.id].sort());

      const markup = renderRoute(Accounts, `/upload/${draftId}/accounts`, page);
      expect(markup).toContain("all-accounts.csv</strong> · several accounts");
      expect(markup).toContain(">Roth IRA</option>");
      expect(markup).toContain(">Home mortgage</option>");
      expect(markup).not.toContain("Individual brokerage");
      expect(markup).not.toContain("Old brokerage");
      expect(markup).toContain(">Skip these rows</option>");
    }),
  );

  it(
    "is never drawn for a file whose every number is recorded, nor for a single-account draft",
    withDatabase(async (ctx) => {
      const { roth, mortgage } = await seedHousehold(ctx);
      await resolveEveryString(ctx);
      await renumber(ctx.db, roth, ROTH);
      await renumber(ctx.db, mortgage, MORTGAGE);
      const draftId = await stage(ctx);

      expect(
        await redirectTo(() => loader(args(get(`/upload/${draftId}/accounts`), { draftId }))),
      ).toBe(`/upload/${draftId}/review`);

      const single = await ctx.seedUploadDraft({ account: roth });
      expect(
        await redirectTo(() =>
          loader(args(get(`/upload/${single.id}/accounts`), { draftId: single.id })),
        ),
      ).toBe(`/upload/${single.id}/columns`);
    }),
  );
});

describe("answering the accounts step", () => {
  it(
    "writes the answers and moves on to instruments while a string is new",
    withDatabase(async (ctx) => {
      const { roth } = await seedHousehold(ctx);
      const draftId = await stage(ctx);

      expect(await redirectTo(() => answer(draftId, answers(roth.id, "skip")))).toBe(
        `/upload/${draftId}/instruments`,
      );
      expect(await answersOf(ctx.db, draftId)).toEqual([
        { account_number: MORTGAGE, account_id: null },
        { account_number: ROTH, account_id: roth.id },
      ]);
    }),
  );

  it(
    "moves on to review once every string is known, and shows the answers standing on a revisit",
    withDatabase(async (ctx) => {
      const { roth, mortgage } = await seedHousehold(ctx);
      await resolveEveryString(ctx);
      const draftId = await stage(ctx);
      await answer(draftId, answers(roth.id, "skip"));

      // Changed on a second visit: the answers are replaced, a swap included.
      expect(await redirectTo(() => answer(draftId, answers(mortgage.id, roth.id)))).toBe(
        `/upload/${draftId}/review`,
      );

      const markup = renderRoute(Accounts, `/upload/${draftId}/accounts`, await screen(draftId));
      expect(chosen(markup, "accountId-0")).toBe(mortgage.id);
      expect(chosen(markup, "accountId-1")).toBe(roth.id);
    }),
  );

  it(
    "refuses a number left unanswered, on its own field, writing nothing",
    withDatabase(async (ctx) => {
      const { roth } = await seedHousehold(ctx);
      const draftId = await stage(ctx);

      const refused = await refusalOf(answer(draftId, answers(roth.id, "")));

      expect(refused.errors).toEqual({
        "accountId-1": `Choose the account "${MORTGAGE}" belongs to, or skip its rows.`,
      });
      expect(await answersOf(ctx.db, draftId)).toEqual([]);
    }),
  );

  it(
    "refuses one account given two numbers, naming both on both fields",
    withDatabase(async (ctx) => {
      const { roth } = await seedHousehold(ctx);
      const draftId = await stage(ctx);

      const refused = await refusalOf(answer(draftId, answers(roth.id, roth.id)));

      const both =
        `Roth IRA is given account numbers "${ROTH}" and "${MORTGAGE}", and an account records ` +
        "one. Choose one account for each.";
      expect(refused.errors).toEqual({ "accountId-0": both, "accountId-1": both });
      expect(await answersOf(ctx.db, draftId)).toEqual([]);
    }),
  );

  it(
    "refuses an account that recorded a number of its own since the page was drawn",
    withDatabase(async (ctx) => {
      const { roth, mortgage } = await seedHousehold(ctx);
      const draftId = await stage(ctx);
      await renumber(ctx.db, mortgage, "M-1");

      const refused = await refusalOf(answer(draftId, answers(roth.id, mortgage.id)));

      expect(refused.errors).toEqual({
        "accountId-1":
          `Only an open account recording no number yet can take "${MORTGAGE}". Choose again.`,
      });
    }),
  );

  it(
    "refuses a form drawn over numbers the file no longer asks about",
    withDatabase(async (ctx) => {
      const { roth, mortgage } = await seedHousehold(ctx);
      const draftId = await stage(ctx);
      // Recorded in Settings while the page sat open: only the mortgage's number is asked now.
      await renumber(ctx.db, roth, ROTH);

      const refused = await refusalOf(answer(draftId, answers("skip", mortgage.id)));

      expect(refused.formError).toMatch(/changed while this page was open/);
      expect(await answersOf(ctx.db, draftId)).toEqual([]);

      // The Roth's posted skip sat at index 0, where the mortgage's number is drawn now.
      const markup = renderRoute(Accounts, `/upload/${draftId}/accounts`, await screen(draftId), {
        actionData: refused,
      });
      expect(chosen(markup, "accountId-0")).toBe("");
    }),
  );

  it(
    "refuses giving an account a number whose rows carry two as-of dates, on its field, and takes skipping it",
    withDatabase(async (ctx) => {
      const { roth } = await seedHousehold(ctx);
      const draftId = await stage(
        ctx,
        "VTI,,1,,2026-07-31,Z12-345678\n" +
          `VTI,,2,,2026-06-30,${ROTH}\n` +
          `FXAIX,,3,,2026-06-29,${ROTH}\n`,
      );

      const refused = await refusalOf(
        answer(draftId, { "number-0": ROTH, "accountId-0": roth.id }),
      );

      expect(refused.errors).toEqual({
        "accountId-0":
          'The file carries two as-of dates for Roth IRA — "2026-06-30" on line 3 and ' +
          '"2026-06-29" on line 4 — and a statement is a photograph of one day. Skip its rows ' +
          "instead.",
      });
      expect(await answersOf(ctx.db, draftId)).toEqual([]);
      expect(
        await redirectTo(() => answer(draftId, { "number-0": ROTH, "accountId-0": "skip" })),
      ).toBe(`/upload/${draftId}/instruments`);
    }),
  );

  it(
    "refuses giving an account a number longer than Settings records, on its field, and takes skipping it",
    withDatabase(async (ctx) => {
      const { roth } = await seedHousehold(ctx);
      const long = "9".repeat(65);
      const draftId = await stage(
        ctx,
        `VTI,,1,,2026-07-31,Z12-345678\nVTI,,2,,2026-07-31,${long}\n`,
      );

      const refused = await refusalOf(
        answer(draftId, { "number-0": long, "accountId-0": roth.id }),
      );

      expect(refused.errors).toEqual({
        "accountId-0":
          `An account number must be 64 characters or fewer. Account number "${long}" is ` +
          "longer — check which column is mapped as the account number. Otherwise its rows can " +
          "only be skipped.",
      });
      expect(await answersOf(ctx.db, draftId)).toEqual([]);
      expect(
        await redirectTo(() => answer(draftId, { "number-0": long, "accountId-0": "skip" })),
      ).toBe(`/upload/${draftId}/instruments`);
    }),
  );

  it(
    "refuses skipping every number when none is recorded, since nothing would be recorded, and takes it when one is",
    withDatabase(async (ctx) => {
      const { individual } = await seedHousehold(ctx);
      const draftId = await stage(ctx);
      await renumber(ctx.db, individual, null);

      const refused = await refusalOf(
        answer(draftId, {
          "number-0": "Z12-345678",
          "accountId-0": "skip",
          "number-1": ROTH,
          "accountId-1": "skip",
          "number-2": MORTGAGE,
          "accountId-2": "skip",
        }),
      );
      expect(refused.formError).toBe(
        "Every account number in the file is skipped, so this upload would record nothing.",
      );
      expect(await answersOf(ctx.db, draftId)).toEqual([]);

      await renumber(ctx.db, individual, "Z12-345678");
      expect(await redirectTo(() => answer(draftId, answers("skip", "skip")))).toBe(
        `/upload/${draftId}/instruments`,
      );
    }),
  );
});

describe("an answer gone stale before the commit", () => {
  it(
    "sends the commit back to the accounts step, recording nothing, and says there which answer went stale",
    withDatabase(async (ctx) => {
      const { individual, roth } = await seedHousehold(ctx);
      await resolveEveryString(ctx);
      const draftId = await stage(ctx);
      await answer(draftId, answers(roth.id, "skip"));
      const review = await reviewLoader(args(get(`/upload/${draftId}/review`), { draftId }));
      if (review instanceof Response || review.diff === null) throw new Error("No review drawn.");

      await renumber(ctx.db, roth, "R-1");

      const fields = reviewedFields(review.diff);
      expect(
        await redirectTo(() =>
          reviewAction(args(post(`/upload/${draftId}/review`, fields), { draftId })),
        ),
      ).toBe(`/upload/${draftId}/accounts?stale=true`);

      for (const account of [individual, roth]) {
        const sets = await ctx.db
          .selectFrom("position_set")
          .select("id")
          .where("account_id", "=", account.id)
          .execute();
        expect(sets).toEqual([]);
      }

      const page = await screen(draftId, "?stale=true");
      expect(page.staleReviewMessage).toBe(STALE_REVIEW_MESSAGE);
      expect(page.screen.questions[0]).toMatchObject({
        number: ROTH,
        answer: "",
        stale:
          `This upload gave account number "${ROTH}" to Roth IRA, which has since recorded ` +
          'account number "R-1". Choose again for it.',
      });
    }),
  );
});

describe("the step strip of a file of several accounts", () => {
  async function strip(draftId: string) {
    const page = await reviewLoader(args(get(`/upload/${draftId}/review`), { draftId }));
    if (page instanceof Response) throw new Error(`Expected Review, got ${page.status}.`);
    return {
      steps: page.steps,
      markup: renderRoute(UploadDraftLayout, `/upload/${draftId}/review`, page),
    };
  }

  const entries = (markup: string) => markup.match(/<li/g)?.length;

  it(
    "draws five steps, linking the accounts step once it was asked",
    withDatabase(async (ctx) => {
      const { roth } = await seedHousehold(ctx);
      await resolveEveryString(ctx);
      const draftId = await stage(ctx);
      await answer(draftId, answers(roth.id, "skip"));

      const { steps, markup } = await strip(draftId);

      expect(steps).toMatchObject({ current: 5, accountsSkipped: false });
      expect(entries(markup)).toBe(5);
      expect(markup).toContain(`href="/upload/${draftId}/accounts"`);
    }),
  );

  it(
    "dims the accounts step as none when every number matched, and leaves it out for one account",
    withDatabase(async (ctx) => {
      const accounts: SeededAccount[] = [];
      for (const number of ["Z12-345678", ROTH, MORTGAGE]) {
        accounts.push(await ctx.seedAccount({ externalAccountNumber: number }));
      }
      await resolveEveryString(ctx);
      const draftId = await stage(ctx);

      const multi = await strip(draftId);
      expect(multi.steps).toMatchObject({ current: 5, accountsSkipped: true });
      expect(entries(multi.markup)).toBe(5);
      expect(multi.markup).toMatch(/Accounts(<!-- -->)? · none/);
      expect(multi.markup).not.toContain(`href="/upload/${draftId}/accounts"`);

      const single = await ctx.seedUploadDraft({
        account: accounts[0] ?? null,
        bytes: new TextEncoder().encode("Holding,Quantity\nVTI,1\n"),
      });
      const outcome = await rememberMapping(
        single.id,
        {
          headerRow: 0,
          delimiter: ",",
          columns: { instrument: "Holding", quantity: "Quantity" },
          costBasisIs: "per_share",
          owedAsPositive: false,
          combineDuplicateRows: true,
        },
        ctx.db,
      );
      if ("problems" in outcome) throw new Error(outcome.problems[0]?.message);
      const one = await strip(single.id);
      expect(one.steps).toMatchObject({ current: 4, accountsSkipped: null });
      expect(entries(one.markup)).toBe(4);
      expect(one.markup).not.toContain("Accounts");
    }),
  );
});
