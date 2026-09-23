// Step two's loader (ingest brief §4, §5.3): the header row's three-step precedence, and preselects resolved against
// that row's cells. Both fail quietly if wrong — wrong precedence leaves a preambled file unmappable with no error;
// preselects resolving by position instead of column name would map quantity onto cost basis and read as correct.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import Columns, { action, loader } from "../../app/routes/upload/columns.tsx";
import {
  NOT_IN_FILE,
  findMapping,
  headerFingerprint,
  upsertMapping,
} from "~/lib/column-mapping.server";
import { rememberMapping, requireDraft } from "~/lib/uploads.server";

import { closeTestDatabase, withDatabase } from "../support/database.ts";
import { renderRoute } from "../support/render.tsx";
import { args, get, post, redirectTo } from "../support/routes.ts";

import type { TestContext } from "../support/database.ts";
import type { StatementMapping } from "~/lib/statement";

afterAll(closeTestDatabase);

const encode = (text: string) => new TextEncoder().encode(text);

// First row is shaped exactly like a header and isn't — detection picks it since its cells are unique and its width
// matches the rows below; the real header is the row after it.
const CSV = [
  "Fund,Units,Basis",
  "Symbol,Quantity,Cost Basis",
  "VTI,100,50.25",
  "VXUS,50,40.10",
].join("\n");

/** The mapping a reader saved after choosing the second row as the header. */
const MAPPING: StatementMapping = {
  headerRow: 1,
  delimiter: ",",
  columns: { instrument: "Symbol", quantity: "Quantity", costBasis: "Cost Basis" },
  costBasisIs: "per_share",
  owedAsPositive: false,
  combineDuplicateRows: true,
};

type StageOptions = {
  /** False leaves the draft where the drop screen leaves it: bytes and nothing else. */
  mapped?: boolean;
  /** Scopes the remembered mapping, so one test's draft cannot prefill another's. */
  institution?: string;
};

/** A draft over {@link CSV}, with the columns step passed unless `mapped` is false. */
async function stageDraft(
  ctx: Pick<TestContext, "db" | "seedAccount" | "seedUploadDraft">,
  { mapped = true, institution = "Fidelity" }: StageOptions = {},
): Promise<string> {
  const account = await ctx.seedAccount({ kind: "brokerage", institution });
  const draft = await ctx.seedUploadDraft({
    account,
    filename: "Positions.csv",
    bytes: encode(CSV),
  });

  if (mapped) {
    const outcome = await rememberMapping(draft.id, MAPPING, ctx.db);
    if ("problems" in outcome) {
      throw new Error("This fixture's mapping does not parse its own file.");
    }
  }

  return draft.id;
}

/** The screen as this request would draw it. */
function screen(draftId: string, query = "") {
  return loader(args(get(`/upload/${draftId}/columns${query}`), { draftId }));
}

describe("the header row the screen opens on", () => {
  it(
    "takes the search param first, then the draft's saved mapping, then detection",
    withDatabase(async (ctx) => {
      // Detection's own (wrong) answer, nothing saved to outrank it.
      const fresh = await stageDraft(ctx, { mapped: false, institution: "Schwab" });
      expect((await screen(fresh)).headerRow).toBe(0);

      // Returning from a later step shows what this draft saved, not detection all over again.
      const draftId = await stageDraft(ctx);
      expect((await screen(draftId)).headerRow).toBe(1);

      // Reader's instruction outranks the saved row, or "Re-read with this header row" does nothing on a mapped draft.
      const reread = await screen(draftId, "?header=0");
      expect(reread.headerRow).toBe(0);
      expect(reread.headerCells).toEqual(["Fund", "Units", "Basis"]);
    }),
  );

  it(
    "ignores a header param that names no row of this file, rather than mapping against nothing",
    withDatabase(async (ctx) => {
      // A hand-edited or bookmarked URL — falling through to the saved row keeps the screen mappable; taking the
      // number would resolve every select against an undefined header.
      const draftId = await stageDraft(ctx);

      const past = await screen(draftId, "?header=9");
      expect(past.headerRow).toBe(1);
      expect(past.defaults.instrument).toBe("Symbol");

      expect((await screen(draftId, "?header=abc")).headerRow).toBe(1);
    }),
  );
});

describe("the preselected columns", () => {
  it(
    "come back chosen, with the deliberate-absence option where the mapping stored no column",
    withDatabase(async (ctx) => {
      const draftId = await stageDraft(ctx);

      const { defaults, missingColumns } = await screen(draftId);

      expect(defaults).toMatchObject({
        instrument: "Symbol",
        quantity: "Quantity",
        costBasis: "Cost Basis",
        costBasisIs: "per_share",
      });
      // Not the empty placeholder — "unset" and "not in this file" are different answers, only the deliberate one survives a save.
      expect(defaults.name).toBe(NOT_IN_FILE);
      expect(defaults.asOf).toBe(NOT_IN_FILE);
      expect(defaults.accountNumber).toBe(NOT_IN_FILE);

      expect(missingColumns).toEqual([]);
    }),
  );

  it(
    "leave a saved column the header on screen lacks unselected, and name it rather than take the column beside it",
    withDatabase(async (ctx) => {
      // The saved mapping's three columns are all absent from row 0, and each sits at the position its replacement
      // occupies — resolving by position would silently map the wrong columns.
      const draftId = await stageDraft(ctx);

      const { defaults, missingColumns } = await screen(draftId, "?header=0");

      expect(defaults.instrument).toBe("");
      expect(defaults.quantity).toBe("");
      expect(defaults.costBasis).toBe("");

      // Named — the reader's next move (remap, or mark not-in-file) depends on knowing the column disappeared.
      expect(missingColumns).toEqual(["Symbol", "Quantity", "Cost Basis"]);
    }),
  );
});

describe("saving a mapping", () => {
  it(
    "stays on Columns and names a blank-instrument row's populated mapped cells",
    withDatabase(async (ctx) => {
      const account = await ctx.seedAccount({ kind: "brokerage" });
      const draft = await ctx.seedUploadDraft({
        account,
        filename: "blank-instrument.csv",
        bytes: encode(
          [
            "Instrument,Quantity,Cost Basis,As Of,Account",
            "VTI,282.144455,165.4961,2026-09-13,Z12-345678",
            ",139.153103,108.2561,2026-09-13,Z12-345678",
          ].join("\n"),
        ),
      });

      const result = await action(
        args(
          post(`/upload/${draft.id}/columns`, {
            headerRow: "0",
            instrument: "Instrument",
            quantity: "Quantity",
            costBasis: "Cost Basis",
            asOf: "As Of",
            accountNumber: "Account",
            costBasisIs: "per_share",
          }),
          { draftId: draft.id },
        ),
      );

      if (result instanceof Response) throw new Error("The invalid mapping left Columns.");
      expect(result.problems).toHaveLength(1);
      expect(result.problems[0]).toMatch(/Line 3/);
      expect(result.problems[0]).toMatch(/"Quantity" and "Cost Basis"/);
      expect(result.problems[0]).not.toMatch(/"As Of"|"Account"/);
      expect(result.problemFields).toEqual(["instrument"]);

      const stored = await ctx.db
        .selectFrom("upload_draft")
        .select(["mapping", "had_first_sightings"])
        .where("id", "=", draft.id)
        .executeTakeFirstOrThrow();
      expect(stored).toEqual({ mapping: null, had_first_sightings: null });
    }),
  );
});

describe("the remembered-mapping note", () => {
  it(
    "names the account when its institution was left blank, which is stored as an empty string",
    withDatabase(async (ctx) => {
      const account = await ctx.seedAccount({ name: "My Brokerage", institution: "" });
      const first = await ctx.seedUploadDraft({ account, bytes: encode(CSV) });
      await rememberMapping(first.id, MAPPING, ctx.db);
      const second = await ctx.seedUploadDraft({ account, bytes: encode(CSV) });

      const page = await loader(
        args(get(`/upload/${second.id}/columns?header=1`), { draftId: second.id }),
      );

      expect(renderRoute(Columns, `/upload/${second.id}/columns`, page)).toContain(
        "a previous My Brokerage statement was uploaded",
      );
    }),
  );
});

// A multi-account draft (spec 0023): the account number column routes every row, so it is
// required here, and everything the router refuses is refused on this screen, before any step
// after it reads the groups.
const readFixture = (name: string): Uint8Array =>
  readFileSync(fileURLToPath(new URL(`../fixtures/statements/${name}`, import.meta.url)));

/** The multi-account fixture's columns, as the screen posts them. */
const SPREADSHEET_FIELDS: Record<string, string> = {
  headerRow: "0",
  instrument: "Holding",
  name: "Description",
  quantity: "Quantity",
  costBasis: "Cost Basis",
  asOf: "As Of",
  accountNumber: "Account Number",
  costBasisIs: "per_share",
};

/** The three accounts multi-account.csv names, each recording its own number. */
async function seedFixtureAccounts(ctx: Pick<TestContext, "seedAccount">) {
  return {
    individual: await ctx.seedAccount({
      name: "Individual brokerage",
      institution: "Fidelity",
      externalAccountNumber: "Z12-345678",
    }),
    roth: await ctx.seedAccount({
      name: "Roth IRA",
      institution: "Fidelity",
      kind: "ira",
      taxTreatment: "tax_free",
      externalAccountNumber: "Z98-765432",
    }),
    mortgage: await ctx.seedAccount({
      name: "Home mortgage",
      institution: "Anytown Credit Union",
      kind: "liability",
      externalAccountNumber: "0045501234",
    }),
  };
}

/** The columns action on a draft, with `fields` over the spreadsheet's own. */
function saveColumns(draftId: string, fields: Record<string, string | undefined> = {}) {
  const posted: Record<string, string> = { ...SPREADSHEET_FIELDS };
  for (const [field, value] of Object.entries(fields)) {
    if (value === undefined) delete posted[field];
    else posted[field] = value;
  }
  return action(args(post(`/upload/${draftId}/columns`, posted), { draftId }));
}

/** The problems a refused columns post shows, or a failure naming where it went instead. */
async function problemsOf(run: ReturnType<typeof saveColumns>) {
  const result = await run;
  if (result instanceof Response) {
    throw new Error(`Expected Columns to refuse, and it sent ${result.headers.get("Location")}.`);
  }
  return result;
}

describe("a multi-account draft's columns step", () => {
  it(
    "requires the account number column, offering no 'not in this file' for it, and saves nothing without it",
    withDatabase(async (ctx) => {
      await seedFixtureAccounts(ctx);
      const draft = await ctx.seedUploadDraft({
        account: null,
        bytes: readFixture("multi-account.csv"),
      });

      for (const accountNumber of [undefined, NOT_IN_FILE]) {
        const refused = await problemsOf(saveColumns(draft.id, { accountNumber }));
        expect(refused.errors.accountNumber).toMatch(/account number/);
      }
      expect((await requireDraft(draft.id, ctx.db)).mapping).toBeNull();

      const page = await loader(args(get(`/upload/${draft.id}/columns`), { draftId: draft.id }));
      const markup = renderRoute(Columns, `/upload/${draft.id}/columns`, page);
      const accountSelect = /<select id="map-accountNumber"[\s\S]*?<\/select>/.exec(markup)?.[0];
      expect(accountSelect).toContain("Account Number");
      expect(accountSelect).not.toContain("Not in this file");
    }),
  );

  it(
    "saves the mapping flagged multi-account under the header alone, prefilling the next such draft and leaving the same header's institution mapping as it was",
    withDatabase(async (ctx) => {
      await seedFixtureAccounts(ctx);
      const bytes = readFixture("multi-account.csv");
      const fingerprint = headerFingerprint(
        "Institution,Account,Account Number,Holding,Description,Quantity,Cost Basis,As Of".split(
          ",",
        ),
      );
      const institutions: StatementMapping = {
        headerRow: 0,
        delimiter: ",",
        columns: { instrument: "Account", quantity: "Quantity" },
        costBasisIs: "total",
        owedAsPositive: true,
        combineDuplicateRows: true,
      };
      await upsertMapping("Fidelity", fingerprint, institutions, ctx.db);

      const draft = await ctx.seedUploadDraft({ account: null, bytes });
      expect(await redirectTo(() => saveColumns(draft.id))).toBe(
        `/upload/${draft.id}/instruments`,
      );

      const saved = { multiAccount: true, columns: { accountNumber: "Account Number" } };
      expect((await requireDraft(draft.id, ctx.db)).mapping).toMatchObject(saved);
      await expect(findMapping(null, fingerprint, ctx.db)).resolves.toMatchObject(saved);
      await expect(findMapping("Fidelity", fingerprint, ctx.db)).resolves.toEqual(institutions);

      const next = await ctx.seedUploadDraft({ account: null, bytes });
      const page = await loader(args(get(`/upload/${next.id}/columns`), { draftId: next.id }));
      expect(page.fromEarlierUpload).toBe(true);
      expect(page.defaults).toMatchObject({
        instrument: "Holding",
        accountNumber: "Account Number",
        costBasisIs: "per_share",
      });
      expect(renderRoute(Columns, `/upload/${next.id}/columns`, page)).toContain(
        "a previous file with this header was uploaded",
      );
    }),
  );

  it(
    "labels the owed box for several accounts and leaves it unticked, where a liability account's draft keeps its own label, ticked",
    withDatabase(async (ctx) => {
      const { mortgage } = await seedFixtureAccounts(ctx);
      const owedBox = (markup: string) => /<input[^>]*name="owedAsPositive"[^>]*>/.exec(markup)?.[0];

      const multi = await ctx.seedUploadDraft({ account: null, bytes: encode(CSV) });
      const multiPage = await loader(
        args(get(`/upload/${multi.id}/columns`), { draftId: multi.id }),
      );
      const multiMarkup = renderRoute(Columns, `/upload/${multi.id}/columns`, multiPage);
      expect(multiMarkup).toContain("Balances owed are listed as positive");
      expect(multiMarkup).not.toContain("This file lists what is owed on");
      expect(owedBox(multiMarkup)).not.toContain("checked");

      const single = await ctx.seedUploadDraft({ account: mortgage, bytes: encode(CSV) });
      const singlePage = await loader(
        args(get(`/upload/${single.id}/columns`), { draftId: single.id }),
      );
      const singleMarkup = renderRoute(Columns, `/upload/${single.id}/columns`, singlePage);
      expect(singleMarkup).toContain(
        "This file lists what is owed on Home mortgage as a positive number",
      );
      expect(singleMarkup).not.toContain("Balances owed are listed as positive");
      expect(owedBox(singleMarkup)).toContain("checked");
    }),
  );
});

describe("a multi-account file the router refuses, on the columns step", () => {
  it(
    "names each line with a blank account number and its instrument, and saves nothing",
    withDatabase(async (ctx) => {
      await seedFixtureAccounts(ctx);
      const draft = await ctx.seedUploadDraft({
        account: null,
        bytes: readFixture("multi-account-blank-number.csv"),
      });

      const refused = await problemsOf(saveColumns(draft.id));

      expect(refused.problems).toEqual([
        'Line 4 ("FXAIX") has no account number, and a file of several accounts routes every ' +
          "row by one.",
      ]);
      expect(refused.problemFields).toEqual(["accountNumber"]);
      expect((await requireDraft(draft.id, ctx.db)).mapping).toBeNull();
    }),
  );

  it(
    "names every line when no row has an account number, rather than calling the instrument column empty",
    withDatabase(async (ctx) => {
      const draft = await ctx.seedUploadDraft({
        account: null,
        bytes: encode(["Account Number,Holding,Quantity", ",VTI,1", ",BND,2"].join("\n")),
      });

      const refused = await problemsOf(
        saveColumns(draft.id, { name: NOT_IN_FILE, costBasis: NOT_IN_FILE, asOf: NOT_IN_FILE }),
      );

      expect(refused.errors).toEqual({});
      expect(refused.problems).toEqual([
        'Lines 2 ("VTI") and 3 ("BND") have no account number, and a file of several accounts ' +
          "routes every row by one.",
      ]);
    }),
  );

  it(
    "names the closed account a number is recorded on, and nothing else",
    withDatabase(async (ctx) => {
      await ctx.seedAccount({ externalAccountNumber: "Z12-345678" });
      await ctx.seedAccount({ externalAccountNumber: "Z98-765432" });
      await ctx.seedAccount({
        name: "Old mortgage",
        kind: "liability",
        externalAccountNumber: "0045501234",
        closedAt: "2026-01-01",
      });
      const draft = await ctx.seedUploadDraft({
        account: null,
        bytes: readFixture("multi-account.csv"),
      });

      const refused = await problemsOf(saveColumns(draft.id));

      expect(refused.problems).toHaveLength(1);
      expect(refused.problems[0]).toContain(
        'Account number "0045501234" is recorded on Old mortgage, which is closed',
      );
    }),
  );

  it(
    "names the account whose rows disagree on the as-of date",
    withDatabase(async (ctx) => {
      await seedFixtureAccounts(ctx);
      const draft = await ctx.seedUploadDraft({
        account: null,
        bytes: encode(
          [
            "Account Number,Holding,Quantity,As Of",
            "Z12-345678,VTI,1,2026-07-31",
            "Z98-765432,VTI,1,2026-06-30",
            "Z12-345678,AAPL,1,2026-06-30",
          ].join("\n"),
        ),
      });

      const refused = await problemsOf(
        saveColumns(draft.id, {
          instrument: "Holding",
          name: NOT_IN_FILE,
          costBasis: NOT_IN_FILE,
        }),
      );

      expect(refused.problems).toEqual([
        'The file carries two as-of dates for Individual brokerage — "2026-07-31" on line 2 and ' +
          '"2026-06-30" on line 4 — and a statement is a photograph of one day.',
      ]);
      expect(refused.problemFields).toEqual(["asOf"]);
    }),
  );

  it(
    "names a number no open account records, pointing at Settings",
    withDatabase(async (ctx) => {
      await ctx.seedAccount({ externalAccountNumber: "Z12-345678" });
      await ctx.seedAccount({ externalAccountNumber: "Z98-765432" });
      await ctx.seedAccount({ kind: "liability" });
      const draft = await ctx.seedUploadDraft({
        account: null,
        bytes: readFixture("multi-account.csv"),
      });

      const refused = await problemsOf(saveColumns(draft.id));

      expect(refused.problems).toEqual([
        'No open account records account number "0045501234". Record it on its account in ' +
          "Settings, then save this mapping again.",
      ]);
    }),
  );
});
