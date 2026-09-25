// Resolving first sightings, and the writes that remember them (spec 0004 step 04; issue #291
// scopes them to the draft until its statement is recorded). Real Postgres — byte-exact collate
// "C" lookup, unique classification name, vocabulary gained mid-draft, a draft's own double
// submit. Probe is always a stub (no test touches the network); stubs count calls since "probed
// once per created feed instrument" is a rule, not an implementation detail.
import { afterAll, describe, expect, it } from "vitest";

import { NotFoundError } from "~/lib/input.server";
import {
  NEW_CLASSIFICATION,
  aliasesFor,
  resolutionFieldsAt,
  resolveAll,
  resolutionScreen,
  unresolvedStrings,
  type ResolutionFields,
} from "~/lib/instrument-resolution.server";
import { sameRawStrings } from "~/lib/raw-string";

import { closeTestDatabase, withDatabase } from "./support/database.ts";
import { refusalOf } from "./support/refusal.ts";

import type { TestContext } from "./support/database.ts";
import type { ProbeSymbols } from "~/lib/price-provider.server";

afterAll(closeTestDatabase);

/** Probe answering ok for every symbol, counting calls — each call carries every symbol asked in
 * one go, so "probed once" is checked on the call list, not a count. quoteType mirrors what a
 * provider says (§4.4) — null here would pass while telling the screen everything is unclassifiable. */
function okProbe(quoteType: string | null = "EQUITY"): { probe: ProbeSymbols; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    probe: async (symbols) => {
      calls.push(symbols);
      return new Map(symbols.map((symbol) => [symbol, { status: "ok", quoteType } as const]));
    },
  };
}

const unavailableProbe: ProbeSymbols = async (symbols) =>
  new Map(symbols.map((symbol) => [symbol, { status: "unavailable" } as const]));

const foreignProbe =
  (currency: string): ProbeSymbols =>
  async (symbols) =>
    new Map(symbols.map((symbol) => [symbol, { status: "non-usd", currency } as const]));

const forbiddenProbe: ProbeSymbols = async (symbols) => {
  throw new Error(`The probe was called for ${symbols.join(", ")}, and this path must not probe.`);
};

/** A complete, valid "create" answer; override per test. */
const createFields = (overrides: Partial<ResolutionFields> = {}): ResolutionFields => ({
  kind: "create",
  symbol: "VXUS",
  name: "Vanguard Total International Stock ETF",
  priceSource: "feed",
  classificationId: NEW_CLASSIFICATION,
  newClassificationName: "International blend",
  newClassificationAssetClass: "equity",
  ...overrides,
});

/** The draft an answer belongs to — every resolution is one draft's own until its statement is recorded. */
async function aDraft(ctx: Pick<TestContext, "seedAccount" | "seedUploadDraft">): Promise<string> {
  return (await ctx.seedUploadDraft({ account: await ctx.seedAccount() })).id;
}

describe("resolveAll — pointing at an existing instrument", () => {
  it(
    "writes the draft's answer and nothing else, and this draft's next lookup is silent",
    withDatabase(async (ctx) => {
      const { db, seedInstrument } = ctx;
      const draftId = await aDraft(ctx);
      const vti = await seedInstrument({ symbol: "VTI", name: "Vanguard Total Stock" });
      const before = await db.selectFrom("instrument").select("id").execute();

      const resolved = await resolveAll(
        draftId,
        [
          {
            raw: "VANGUARD TOTAL STK MKT ETF",
            fields: { kind: "existing", instrumentId: vti.id },
          },
        ],
        { probe: forbiddenProbe },
        db,
      );

      expect(resolved).toEqual([
        { raw: "VANGUARD TOTAL STK MKT ETF", instrumentId: vti.id },
      ]);

      const answer = await db
        .selectFrom("upload_draft_answer")
        .selectAll()
        .where("raw_string", "=", "VANGUARD TOTAL STK MKT ETF")
        .executeTakeFirstOrThrow();
      expect(answer).toMatchObject({ draft_id: draftId, instrument_id: vti.id });

      // Vocabulary waits for the commit.
      const vocabulary = await db
        .selectFrom("instrument_alias")
        .select("raw_string")
        .where("raw_string", "=", "VANGUARD TOTAL STK MKT ETF")
        .execute();
      expect(vocabulary).toHaveLength(0);

      const after = await db.selectFrom("instrument").select("id").execute();
      expect(after).toHaveLength(before.length);
      await expect(
        unresolvedStrings(["VANGUARD TOTAL STK MKT ETF"], draftId, db),
      ).resolves.toEqual([]);
    }),
  );

  it(
    "keeps the answer to the draft that gave it: the same string is a first sighting for another",
    withDatabase(async (ctx) => {
      const { db, seedInstrument } = ctx;
      const draftId = await aDraft(ctx);
      const vti = await seedInstrument({ symbol: "VTI" });

      // The audit's QAALIAS: matched to VTI in a draft that is then abandoned.
      await resolveAll(
        draftId,
        [{ raw: "QAALIAS", fields: { kind: "existing", instrumentId: vti.id } }],
        { probe: forbiddenProbe },
        db,
      );

      const another = await aDraft(ctx);
      await expect(unresolvedStrings(["QAALIAS"], another, db)).resolves.toEqual(["QAALIAS"]);
      await expect(aliasesFor(["QAALIAS"], another, db)).resolves.toEqual(new Map());
    }),
  );

  it(
    "reads vocabulary over the draft's own answer for the same string",
    withDatabase(async (ctx) => {
      const { db, seedInstrument, seedInstrumentAlias } = ctx;
      const draftId = await aDraft(ctx);
      const vti = await seedInstrument({ symbol: "VTI" });
      const vxus = await seedInstrument({ symbol: "VXUS" });

      await resolveAll(
        draftId,
        [{ raw: "TOTAL MARKET", fields: { kind: "existing", instrumentId: vxus.id } }],
        { probe: forbiddenProbe },
        db,
      );
      // Another upload recorded the string meanwhile — everyone reads its row, this draft included.
      await seedInstrumentAlias({ instrument: vti, rawString: "TOTAL MARKET" });

      await expect(aliasesFor(["TOTAL MARKET"], draftId, db)).resolves.toEqual(
        new Map([["TOTAL MARKET", vti.id]]),
      );
    }),
  );

  it(
    "answers the expired page, writing nothing, when the draft was swept under the form",
    withDatabase(async (ctx) => {
      const { db, seedInstrument } = ctx;
      const draftId = await aDraft(ctx);
      const vti = await seedInstrument({ symbol: "VTI" });
      await db.deleteFrom("upload_draft").where("id", "=", draftId).execute();

      await expect(
        resolveAll(
          draftId,
          [{ raw: "VTI", fields: { kind: "existing", instrumentId: vti.id } }],
          { probe: forbiddenProbe },
          db,
        ),
      ).rejects.toThrow(NotFoundError);

      const answers = await db.selectFrom("upload_draft_answer").select("draft_id").execute();
      expect(answers).toHaveLength(0);
    }),
  );

  it(
    "resolves byte-exact: an alias written with a trailing space leaves the bare spelling unresolved",
    withDatabase(async (ctx) => {
      const { db, seedInstrument } = ctx;
      const draftId = await aDraft(ctx);
      const vti = await seedInstrument({ symbol: "VTI" });

      await resolveAll(
        draftId,
        [{ raw: "VTI ", fields: { kind: "existing", instrumentId: vti.id } }],
        { probe: forbiddenProbe },
        db,
      );

      await expect(unresolvedStrings(["VTI ", "VTI", "vti "], draftId, db)).resolves.toEqual([
        "VTI",
        "vti ",
      ]);
    }),
  );
});

describe("resolveAll — creating an instrument", () => {
  it(
    "stores what the provider calls the instrument",
    withDatabase(async (ctx) => {
      const { db } = ctx;
      const draftId = await aDraft(ctx);
      const { probe } = okProbe("ETF");
      await resolveAll(draftId, [{ raw: "VXUS", fields: createFields() }], { probe }, db);

      const created = await db
        .selectFrom("instrument")
        .select("quote_type")
        .where("symbol", "=", "VXUS")
        .executeTakeFirstOrThrow();

      expect(created.quote_type).toBe("ETF");
    }),
  );

  it(
    "stores null when the provider named no type, rather than guessing one",
    withDatabase(async (ctx) => {
      const { db } = ctx;
      const draftId = await aDraft(ctx);
      const { probe } = okProbe(null);
      await resolveAll(draftId, [{ raw: "VXUS", fields: createFields() }], { probe }, db);

      const created = await db
        .selectFrom("instrument")
        .select("quote_type")
        .where("symbol", "=", "VXUS")
        .executeTakeFirstOrThrow();

      expect(created.quote_type).toBeNull();
    }),
  );

  it(
    "writes the classification first when new, then the instrument, then the draft's answer",
    withDatabase(async (ctx) => {
      const { db } = ctx;
      const draftId = await aDraft(ctx);
      const { probe, calls } = okProbe();

      const resolved = await resolveAll(
        draftId,
        [{ raw: "VXUS", fields: createFields() }],
        { probe },
        db,
      );

      const classification = await db
        .selectFrom("classification")
        .selectAll()
        .where("name", "=", "International blend")
        .executeTakeFirstOrThrow();
      expect(classification.asset_class).toBe("equity");

      const instrument = await db
        .selectFrom("instrument")
        .selectAll()
        .where("symbol", "=", "VXUS")
        .executeTakeFirstOrThrow();
      expect(instrument.name).toBe("Vanguard Total International Stock ETF");
      expect(instrument.price_source).toBe("feed");
      expect(instrument.classification_id).toBe(classification.id);
      expect(instrument.quote_type).toBe("EQUITY");

      const answer = await db
        .selectFrom("upload_draft_answer")
        .selectAll()
        .where("draft_id", "=", draftId)
        .where("raw_string", "=", "VXUS")
        .executeTakeFirstOrThrow();
      expect(answer.instrument_id).toBe(instrument.id);
      expect(resolved).toEqual([{ raw: "VXUS", instrumentId: instrument.id }]);

      expect(calls).toEqual([["VXUS"]]);
    }),
  );

  it(
    "creates a classification typed twice in one submit once, shared, never refused against itself",
    withDatabase(async (ctx) => {
      const { db } = ctx;
      const draftId = await aDraft(ctx);
      const { probe } = okProbe();

      await resolveAll(
        draftId,
        [
          { raw: "VXUS", fields: createFields() },
          {
            raw: "VEA",
            fields: createFields({ symbol: "VEA", name: "Vanguard Developed Markets" }),
          },
        ],
        { probe },
        db,
      );

      const rows = await db
        .selectFrom("classification")
        .select("id")
        .where("name", "=", "International blend")
        .execute();
      expect(rows).toHaveLength(1);

      const instruments = await db
        .selectFrom("instrument")
        .select(["symbol", "classification_id"])
        .where("symbol", "in", ["VXUS", "VEA"])
        .execute();
      expect(instruments).toHaveLength(2);
      expect(new Set(instruments.map((row) => row.classification_id)).size).toBe(1);
    }),
  );

  it(
    "refuses a feed instrument with no symbol — there is nothing to quote without one",
    withDatabase(async (ctx) => {
      const { db, seedClassification } = ctx;
      const draftId = await aDraft(ctx);
      const classification = await seedClassification();

      const refusal = await refusalOf(() =>
        resolveAll(
          draftId,
          [
            {
              raw: "MYSTERY FUND",
              fields: createFields({
                symbol: "",
                priceSource: "feed",
                classificationId: classification.id,
              }),
            },
          ],
          { probe: forbiddenProbe },
          db,
        ),
      );

      expect(refusal.fieldErrors["symbol-0"]).toMatch(/feed needs a symbol/i);
    }),
  );

  it(
    "allows manual with no symbol — the collective investment trust case",
    withDatabase(async (ctx) => {
      const { db, seedClassification } = ctx;
      const draftId = await aDraft(ctx);
      const classification = await seedClassification();

      await resolveAll(
        draftId,
        [
          {
            raw: "VANG TARGET RET 2045",
            fields: createFields({
              symbol: "",
              name: "Vanguard Target Retirement 2045 Trust II",
              priceSource: "manual",
              classificationId: classification.id,
              newClassificationName: "",
              newClassificationAssetClass: "",
            }),
          },
        ],
        { probe: forbiddenProbe },
        db,
      );

      const instrument = await db
        .selectFrom("instrument")
        .selectAll()
        .where("name", "=", "Vanguard Target Retirement 2045 Trust II")
        .executeTakeFirstOrThrow();
      expect(instrument.symbol).toBeNull();
      expect(instrument.price_source).toBe("manual");

      const answer = await db
        .selectFrom("upload_draft_answer")
        .select("instrument_id")
        .where("draft_id", "=", draftId)
        .where("raw_string", "=", "VANG TARGET RET 2045")
        .executeTakeFirstOrThrow();
      expect(answer.instrument_id).toBe(instrument.id);
    }),
  );

  it(
    "refuses a new classification name that already exists, naming it",
    withDatabase(async (ctx) => {
      const { db, seedClassification } = ctx;
      const draftId = await aDraft(ctx);
      await seedClassification({ name: "Growth", assetClass: "equity" });

      const refusal = await refusalOf(() =>
        resolveAll(
          draftId,
          [
            {
              raw: "VXUS",
              fields: createFields({ newClassificationName: "Growth" }),
            },
          ],
          { probe: forbiddenProbe },
          db,
        ),
      );

      expect(refusal.fieldErrors["newClassificationName-0"]).toMatch(
        /"Growth" is already a classification/,
      );

      const answers = await db
        .selectFrom("upload_draft_answer")
        .select("raw_string")
        .where("raw_string", "=", "VXUS")
        .execute();
      expect(answers).toHaveLength(0);
    }),
  );
});

describe("resolveAll — the USD probe", () => {
  it(
    "refuses a non-USD quote naming the symbol and the currency, writing nothing for that string",
    withDatabase(async (ctx) => {
      const { db, seedInstrument } = ctx;
      const draftId = await aDraft(ctx);
      const usd = await seedInstrument({ symbol: "USDX", name: "Cash-like" });
      const instrumentsBefore = await db.selectFrom("instrument").select("id").execute();

      const refusal = await refusalOf(() =>
        resolveAll(
          draftId,
          [
            { raw: "FCASH", fields: { kind: "existing", instrumentId: usd.id } },
            {
              raw: "VWRL",
              fields: createFields({ symbol: "VWRL", name: "Vanguard FTSE All-World" }),
            },
          ],
          { probe: foreignProbe("GBP") },
          db,
        ),
      );

      expect(refusal.fieldErrors["symbol-1"]).toBe(
        "VWRL is quoted in GBP. This instance holds USD only, so it was not created.",
      );

      // Atomic across the submission — FCASH's alias waits too.
      const instrumentsAfter = await db.selectFrom("instrument").select("id").execute();
      expect(instrumentsAfter).toHaveLength(instrumentsBefore.length);
      const answers = await db
        .selectFrom("upload_draft_answer")
        .select("raw_string")
        .where("raw_string", "in", ["VWRL", "FCASH"])
        .execute();
      expect(answers).toHaveLength(0);
      const classifications = await db
        .selectFrom("classification")
        .select("id")
        .where("name", "=", "International blend")
        .execute();
      expect(classifications).toHaveLength(0);
    }),
  );

  it(
    "creates anyway when the provider cannot answer — the next refresh marks it stale",
    withDatabase(async (ctx) => {
      const { db } = ctx;
      const draftId = await aDraft(ctx);
      await resolveAll(
        draftId,
        [{ raw: "VXUS", fields: createFields() }],
        { probe: unavailableProbe },
        db,
      );

      const instrument = await db
        .selectFrom("instrument")
        .select(["symbol", "price_source"])
        .where("symbol", "=", "VXUS")
        .executeTakeFirstOrThrow();
      expect(instrument.price_source).toBe("feed");

      await expect(unresolvedStrings(["VXUS"], draftId, db)).resolves.toEqual([]);
    }),
  );

  it(
    "writes each created instrument the quote type its own symbol was answered with",
    withDatabase(async (ctx) => {
      const { db, seedClassification } = ctx;
      const draftId = await aDraft(ctx);
      const classification = await seedClassification();
      const probe: ProbeSymbols = async () =>
        new Map([
          ["VTI", { status: "ok", quoteType: "ETF" }],
          ["MSFT", { status: "ok", quoteType: "EQUITY" }],
        ]);

      const answerFor = (symbol: string) =>
        createFields({
          symbol,
          name: `${symbol} holding`,
          classificationId: classification.id,
          newClassificationName: "",
          newClassificationAssetClass: "",
        });

      const resolved = await resolveAll(
        draftId,
        [
          { raw: "VTI", fields: answerFor("VTI") },
          { raw: "MSFT", fields: answerFor("MSFT") },
        ],
        { probe },
        db,
      );

      const rows = await db
        .selectFrom("instrument")
        .select(["symbol", "quote_type"])
        .where(
          "id",
          "in",
          resolved.map((alias) => alias.instrumentId),
        )
        .orderBy("symbol")
        .execute();

      expect(rows).toEqual([
        { symbol: "MSFT", quote_type: "EQUITY" },
        { symbol: "VTI", quote_type: "ETF" },
      ]);
    }),
  );

  it(
    "refuses a lower-case symbol the probe answered non-USD for",
    withDatabase(async (ctx) => {
      const { db, seedClassification } = ctx;
      const draftId = await aDraft(ctx);
      const classification = await seedClassification();
      const probe: ProbeSymbols = async (symbols) =>
        new Map(symbols.map((symbol) => [symbol, { status: "non-usd", currency: "GBP" } as const]));

      const refusal = await refusalOf(() =>
        resolveAll(
          draftId,
          [
            {
              raw: "vwrl",
              fields: createFields({
                symbol: "vwrl",
                name: "Vanguard FTSE All-World",
                classificationId: classification.id,
                newClassificationName: "",
                newClassificationAssetClass: "",
              }),
            },
          ],
          { probe },
          db,
        ),
      );

      expect(refusal.fieldErrors["symbol-0"]).toContain("quoted in GBP");
    }),
  );

  it(
    "refuses only the feed plan when a manual plan names the same refused ticker",
    withDatabase(async (ctx) => {
      const { db, seedClassification } = ctx;
      const draftId = await aDraft(ctx);
      const classification = await seedClassification();
      const probe: ProbeSymbols = async (symbols) =>
        new Map(symbols.map((symbol) => [symbol, { status: "non-usd", currency: "GBP" } as const]));

      const answerFor = (priceSource: "feed" | "manual") =>
        createFields({
          symbol: "VWRL",
          name: `Vanguard FTSE All-World (${priceSource})`,
          priceSource,
          classificationId: classification.id,
          newClassificationName: "",
          newClassificationAssetClass: "",
        });

      const refusal = await refusalOf(() =>
        resolveAll(
          draftId,
          [
            { raw: "VWRL FEED", fields: answerFor("feed") },
            { raw: "VWRL MANUAL", fields: answerFor("manual") },
          ],
          { probe },
          db,
        ),
      );

      expect(Object.keys(refusal.fieldErrors)).toEqual(["symbol-0"]);
    }),
  );

  it(
    "never probes a manual instrument, even one carrying a symbol",
    withDatabase(async (ctx) => {
      const { db, seedClassification } = ctx;
      const draftId = await aDraft(ctx);
      const classification = await seedClassification();

      await resolveAll(
        draftId,
        [
          {
            raw: "VWRL",
            fields: createFields({
              symbol: "VWRL",
              name: "Vanguard FTSE All-World",
              priceSource: "manual",
              classificationId: classification.id,
              newClassificationName: "",
              newClassificationAssetClass: "",
            }),
          },
        ],
        { probe: forbiddenProbe },
        db,
      );
    }),
  );

  it(
    "probes three tickers named by six strings in one call carrying three symbols, landing each verdict on the right plans",
    withDatabase(async (ctx) => {
      const { db, seedClassification } = ctx;
      const draftId = await aDraft(ctx);
      const classification = await seedClassification();
      const calls: string[][] = [];
      const probe: ProbeSymbols = async (symbols) => {
        calls.push(symbols);
        return new Map([
          ["VTI", { status: "ok", quoteType: "ETF" }],
          ["VWRL", { status: "non-usd", currency: "GBP" }],
          ["ZZZZ", { status: "unavailable" }],
        ]);
      };

      const answerFor = (symbol: string, label: string) =>
        createFields({
          symbol,
          name: `${symbol} fund ${label}`,
          classificationId: classification.id,
          newClassificationName: "",
          newClassificationAssetClass: "",
        });

      const refusal = await refusalOf(() =>
        resolveAll(
          draftId,
          [
            { raw: "VTI A", fields: answerFor("VTI", "A") },
            { raw: "VTI B", fields: answerFor("VTI", "B") },
            { raw: "VWRL A", fields: answerFor("VWRL", "A") },
            { raw: "VWRL B", fields: answerFor("VWRL", "B") },
            { raw: "ZZZZ A", fields: answerFor("ZZZZ", "A") },
            { raw: "ZZZZ B", fields: answerFor("ZZZZ", "B") },
          ],
          { probe },
          db,
        ),
      );

      expect(calls).toEqual([["VTI", "VWRL", "ZZZZ"]]);

      expect(Object.keys(refusal.fieldErrors)).toEqual(["symbol-2", "symbol-3"]);
      expect(refusal.fieldErrors["symbol-2"]).toBe(
        "VWRL is quoted in GBP. This instance holds USD only, so it was not created.",
      );
      expect(refusal.fieldErrors["symbol-3"]).toBe(
        "VWRL is quoted in GBP. This instance holds USD only, so it was not created.",
      );
    }),
  );

  it(
    "creates the instrument when the probe answered nothing about its symbol",
    withDatabase(async (ctx) => {
      const { db, seedClassification } = ctx;
      const draftId = await aDraft(ctx);
      // Not hypothetical — a symbol failing the worker's pattern check is dropped before the call.
      const classification = await seedClassification();
      const silentProbe: ProbeSymbols = async () => new Map();

      const resolved = await resolveAll(
        draftId,
        [
          {
            raw: "VTI",
            fields: createFields({
              symbol: "VTI",
              name: "Vanguard Total Stock Market ETF",
              priceSource: "feed",
              classificationId: classification.id,
              newClassificationName: "",
              newClassificationAssetClass: "",
            }),
          },
        ],
        { probe: silentProbe },
        db,
      );

      const instrument = await db
        .selectFrom("instrument")
        .select(["symbol", "quote_type"])
        .where("id", "=", resolved[0]!.instrumentId)
        .executeTakeFirstOrThrow();

      expect(instrument.symbol).toBe("VTI");
      expect(instrument.quote_type).toBeNull();
    }),
  );

  it(
    "resolves a manual-only submission with a probe stub that was never called",
    withDatabase(async (ctx) => {
      const { db, seedClassification } = ctx;
      const draftId = await aDraft(ctx);
      // Zero-symbol ask over the socket is a round trip the worker refuses anyway.
      const classification = await seedClassification();
      const calls: string[][] = [];
      const probe: ProbeSymbols = async (symbols) => {
        calls.push(symbols);
        return new Map();
      };

      await resolveAll(
        draftId,
        [
          {
            raw: "VANG TARGET RET 2045",
            fields: createFields({
              symbol: "",
              name: "Vanguard Target Retirement 2045 Trust II",
              priceSource: "manual",
              classificationId: classification.id,
              newClassificationName: "",
              newClassificationAssetClass: "",
            }),
          },
        ],
        { probe },
        db,
      );

      expect(calls).toHaveLength(0);
    }),
  );
});

describe("resolveAll — the whole submission", () => {
  it(
    "refuses a submit that leaves one string unanswered — there is no skip",
    withDatabase(async (ctx) => {
      const { db, seedInstrument } = ctx;
      const draftId = await aDraft(ctx);
      const vti = await seedInstrument({ symbol: "VTI" });

      const refusal = await refusalOf(() =>
        resolveAll(
          draftId,
          [
            { raw: "VTI", fields: { kind: "existing", instrumentId: vti.id } },
            { raw: "CASH & CASH INVESTMENTS", fields: {} },
          ],
          { probe: forbiddenProbe },
          db,
        ),
      );

      expect(refusal.fieldErrors["kind-1"]).toMatch(/silently missing/);

      // Answered string is not written either — refusal is atomic across the submission.
      const answers = await db
        .selectFrom("upload_draft_answer")
        .select("raw_string")
        .where("raw_string", "=", "VTI")
        .execute();
      expect(answers).toHaveLength(0);
    }),
  );

  it(
    "defers to vocabulary gained meanwhile: its row answers, nothing lands on the draft, no duplicate is left",
    withDatabase(async (ctx) => {
      const { db, seedInstrument, seedInstrumentAlias } = ctx;
      const draftId = await aDraft(ctx);
      const cash = await seedInstrument({ symbol: "USDY", name: "Cash" });
      await seedInstrumentAlias({ instrument: cash, rawString: "CASH & CASH INVESTMENTS" });
      const before = await db.selectFrom("instrument").select("id").execute();

      const resolved = await resolveAll(
        draftId,
        [
          {
            raw: "CASH & CASH INVESTMENTS",
            fields: createFields({
              symbol: "",
              name: "Cash sweep",
              priceSource: "manual",
              classificationId: NEW_CLASSIFICATION,
              newClassificationName: "Sweep",
              newClassificationAssetClass: "cash",
            }),
          },
        ],
        { probe: forbiddenProbe },
        db,
      );

      expect(resolved).toEqual([
        { raw: "CASH & CASH INVESTMENTS", instrumentId: cash.id },
      ]);
      const alias = await db
        .selectFrom("instrument_alias")
        .select("instrument_id")
        .where("raw_string", "=", "CASH & CASH INVESTMENTS")
        .executeTakeFirstOrThrow();
      expect(alias.instrument_id).toBe(cash.id);
      const answers = await db
        .selectFrom("upload_draft_answer")
        .select("raw_string")
        .where("draft_id", "=", draftId)
        .execute();
      expect(answers).toHaveLength(0);
      const after = await db.selectFrom("instrument").select("id").execute();
      expect(after).toHaveLength(before.length);
    }),
  );

  it(
    "lets a draft's own second submit find its first answer, deleting the instrument it just created",
    withDatabase(async (ctx) => {
      const { db } = ctx;
      const draftId = await aDraft(ctx);
      const { probe } = okProbe();

      const first = await resolveAll(draftId, [{ raw: "VXUS", fields: createFields() }], { probe }, db);
      const before = await db.selectFrom("instrument").select("id").execute();
      const blend = await db
        .selectFrom("classification")
        .select("id")
        .where("name", "=", "International blend")
        .executeTakeFirstOrThrow();

      // Same draft, same string, a fresh "create" — a double click, or a stale tab.
      const second = await resolveAll(
        draftId,
        [
          {
            raw: "VXUS",
            fields: createFields({
              name: "Typed again",
              classificationId: blend.id,
              newClassificationName: "",
              newClassificationAssetClass: "",
            }),
          },
        ],
        { probe },
        db,
      );

      expect(second).toEqual(first);
      const after = await db.selectFrom("instrument").select("id").execute();
      expect(after).toHaveLength(before.length);
      const answers = await db
        .selectFrom("upload_draft_answer")
        .select("instrument_id")
        .where("draft_id", "=", draftId)
        .execute();
      expect(answers).toEqual([{ instrument_id: first[0]?.instrumentId }]);
    }),
  );

  it(
    "leaves nothing unresolved for this draft, while another draft still meets every string",
    withDatabase(async (ctx) => {
      const { db, seedInstrument, seedClassification } = ctx;
      const draftId = await aDraft(ctx);
      const vti = await seedInstrument({ symbol: "VTI" });
      const classification = await seedClassification();

      await resolveAll(
        draftId,
        [
          { raw: "VANGUARD TOTAL STK MKT ETF", fields: { kind: "existing", instrumentId: vti.id } },
          {
            raw: "VANG TARGET RET 2045",
            fields: createFields({
              symbol: "",
              name: "Vanguard Target Retirement 2045 Trust II",
              priceSource: "manual",
              classificationId: classification.id,
            }),
          },
        ],
        { probe: forbiddenProbe },
        db,
      );

      await expect(
        unresolvedStrings(
          ["VANGUARD TOTAL STK MKT ETF", "VANG TARGET RET 2045", "SOMETHING ELSE"],
          draftId,
          db,
        ),
      ).resolves.toEqual(["SOMETHING ELSE"]);

      // The next upload is silent only once this one is recorded (commit-upload.test.ts).
      await expect(
        unresolvedStrings(
          ["VANGUARD TOTAL STK MKT ETF", "VANG TARGET RET 2045", "SOMETHING ELSE"],
          await aDraft(ctx),
          db,
        ),
      ).resolves.toEqual(["VANGUARD TOTAL STK MKT ETF", "VANG TARGET RET 2045", "SOMETHING ELSE"]);
    }),
  );
});

describe("resolutionScreen", () => {
  it(
    "lists only the first sightings, with the row's name and quantity beside each",
    withDatabase(async (ctx) => {
      const { db, seedInstrument, seedInstrumentAlias, seedClassification } = ctx;
      const draftId = await aDraft(ctx);
      const vti = await seedInstrument({ symbol: "VTI", name: "Vanguard Total Stock" });
      await seedInstrumentAlias({ instrument: vti, rawString: "VTI" });
      const growth = await seedClassification({ name: "Screen Growth", assetClass: "equity" });

      const screen = await resolutionScreen(
        [
          {
            row: 4,
            instrument: "VTI",
            name: "Vanguard Total Stock Market ETF",
            quantity: "120.000",
            costBasisPerShare: null,
            accountNumber: null,
          },
          {
            row: 5,
            instrument: "VXUS",
            name: "Vanguard Total International Stock ETF",
            quantity: "120.000",
            costBasisPerShare: null,
            accountNumber: null,
          },
          {
            row: 6,
            instrument: "CASH & CASH INVESTMENTS",
            name: null,
            quantity: "4210.55",
            costBasisPerShare: null,
            accountNumber: null,
          },
        ],
        draftId,
        db,
      );

      expect(screen.totalPositions).toBe(3);
      expect(screen.unresolved).toEqual([
        {
          raw: "VXUS",
          name: "Vanguard Total International Stock ETF",
          quantity: "120.000",
        },
        { raw: "CASH & CASH INVESTMENTS", name: null, quantity: "4210.55" },
      ]);

      expect(screen.instruments.map((entry) => entry.id)).toContain(vti.id);
      expect(
        screen.classifications.find((entry) => entry.id === growth.id),
      ).toMatchObject({ name: "Screen Growth", assetClass: "equity" });
    }),
  );
});

describe("resolutionFieldsAt", () => {
  it("reads one string's answers out of an indexed form post", () => {
    const fields = resolutionFieldsAt(
      {
        "kind-0": "existing",
        "instrumentId-0": "7",
        "kind-1": "create",
        "symbol-1": "VXUS",
        "name-1": "Vanguard Total International Stock ETF",
        "priceSource-1": "feed",
        "classificationId-1": NEW_CLASSIFICATION,
        "newClassificationName-1": "International blend",
        "newClassificationAssetClass-1": "equity",
      },
      1,
    );

    expect(fields).toEqual({
      kind: "create",
      symbol: "VXUS",
      name: "Vanguard Total International Stock ETF",
      priceSource: "feed",
      classificationId: NEW_CLASSIFICATION,
      newClassificationName: "International blend",
      newClassificationAssetClass: "equity",
    });
  });
});

describe("sameRawStrings", () => {
  it("reads LF, CRLF and bare CR spellings of one cell as the same string", () => {
    // HTML form serialisation rewrites a lone LF/CR to CRLF on submit.
    expect(sameRawStrings("FUND\nCLASS A", "FUND\r\nCLASS A")).toBe(true);
    expect(sameRawStrings("FUND\rCLASS A", "FUND\nCLASS A")).toBe(true);
    expect(sameRawStrings("FUND\r\nCLASS A", "FUND\r\nCLASS A")).toBe(true);
  });

  it("is byte-exact about everything that is not a line ending", () => {
    expect(sameRawStrings("VTI", "VTI ")).toBe(false);
    expect(sameRawStrings("FUND\nCLASS A", "FUND\nCLASS B")).toBe(false);
  });

  it("still separates case, exactly as the alias table does", () => {
    expect(sameRawStrings("VTI", "vti")).toBe(false);
  });
});

/** Moved here from column-mapping.test.ts, which imported it from this module — the lookup is
 * resolution's, not the mapping's. Vocabulary rows, seeded as a recorded upload leaves them. */
describe("unresolvedStrings", () => {
  it(
    "matches byte-exactly, so a case or padding difference is a miss",
    withDatabase(async (ctx) => {
      const { db, seedInstrument, seedInstrumentAlias } = ctx;
      const draftId = await aDraft(ctx);
      const instrument = await seedInstrument({ symbol: "VTI" });
      await seedInstrumentAlias({ instrument, rawString: "VTI" });

      await expect(unresolvedStrings(["VTI", "vti", "VTI ", " VTI"], draftId, db)).resolves.toEqual([
        "vti",
        "VTI ",
        " VTI",
      ]);
    }),
  );

  it(
    "answers nothing for a file whose every string is already vocabulary",
    withDatabase(async (ctx) => {
      const { db, seedInstrument, seedInstrumentAlias } = ctx;
      const draftId = await aDraft(ctx);
      const instrument = await seedInstrument({ symbol: "VTI" });
      await seedInstrumentAlias({ instrument, rawString: "VTI" });
      await seedInstrumentAlias({ instrument, rawString: "Vanguard Total Stock Market ETF" });

      await expect(
        unresolvedStrings(["VTI", "Vanguard Total Stock Market ETF", "VTI"], draftId, db),
      ).resolves.toEqual([]);
      await expect(unresolvedStrings([], draftId, db)).resolves.toEqual([]);
    }),
  );

  it(
    "keeps first-appearance order and collapses repeats, the order the screen asks in",
    withDatabase(async (ctx) => {
      const { db } = ctx;
      const draftId = await aDraft(ctx);
      await expect(unresolvedStrings(["BND", "VTI", "BND", "AAPL", "VTI"], draftId, db)).resolves.toEqual([
        "BND",
        "VTI",
        "AAPL",
      ]);
    }),
  );

  it(
    "reads an alias written for one institution's statement when another's names the same string",
    withDatabase(async (ctx) => {
      const { db, seedInstrument, seedInstrumentAlias } = ctx;
      const draftId = await aDraft(ctx);
      // Replaces a brittle information_schema assertion about the schema file, not what
      // the schema does.
      const usd = await seedInstrument({ symbol: "USD", name: "US Dollar" });
      await seedInstrumentAlias({ instrument: usd, rawString: "CASH" });

      await expect(unresolvedStrings(["CASH"], draftId, db)).resolves.toEqual([]);
    }),
  );
});
