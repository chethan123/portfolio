/**
 * Resolving first sightings, and the writes that remember them forever
 * (spec 0004 step 04).
 *
 * Against real Postgres, because what is at risk lives there: the byte-exact
 * `collate "C"` lookup, the unique classification name, and the alias
 * conflict a concurrent draft plants. The USD probe is always a stub — the
 * seam exists so no test touches the network — and the stubs count their
 * calls, because "probed once per created feed instrument" is a rule, not an
 * implementation detail.
 */
import { afterAll, describe, expect, it } from "vitest";

import { ValidationError } from "~/lib/input.server";
import {
  NEW_CLASSIFICATION,
  resolutionFieldsAt,
  resolveAll,
  resolutionScreen,
  sameRawStrings,
  unresolvedStrings,
  type ResolutionFields,
} from "~/lib/instrument-resolution.server";

import { closeTestDatabase, withDatabase } from "./support/database.ts";

import type { ProbeSymbol } from "~/lib/price-provider.server";

afterAll(closeTestDatabase);

/**
 * A probe that answers `ok` and counts how often it was asked.
 *
 * `quoteType` is what the provider would have said, because the created row
 * stores it (§4.4) — a stub answering null here would pass while telling the
 * screen every instrument is unclassifiable.
 */
function okProbe(quoteType: string | null = "EQUITY"): { probe: ProbeSymbol; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    probe: async (symbol) => {
      calls.push(symbol);
      return { status: "ok", quoteType };
    },
  };
}

/** A probe whose provider is having a bad day, whatever the symbol. */
const unavailableProbe: ProbeSymbol = async () => ({ status: "unavailable" });

/** A probe that quotes every symbol in the given currency. */
const foreignProbe =
  (currency: string): ProbeSymbol =>
  async () => ({ status: "non-usd", currency });

/** A probe that must never be reached — pointing at existing, manual creates. */
const forbiddenProbe: ProbeSymbol = async (symbol) => {
  throw new Error(`The probe was called for ${symbol}, and this path must not probe.`);
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

/** The refusal a call produced, or a failure if it did not refuse. */
async function refusalOf(run: () => Promise<unknown>): Promise<ValidationError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof ValidationError) return error;
    throw error;
  }
  throw new Error("Expected the resolution to be refused, and it was not.");
}

describe("resolveAll — pointing at an existing instrument", () => {
  it(
    "writes the alias and nothing else, and the next lookup is silent",
    withDatabase(async ({ db, seedInstrument }) => {
      const vti = await seedInstrument({ symbol: "VTI", name: "Vanguard Total Stock" });
      const before = await db.selectFrom("instrument").select("id").execute();

      const resolved = await resolveAll(
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

      const alias = await db
        .selectFrom("instrument_alias")
        .selectAll()
        .where("raw_string", "=", "VANGUARD TOTAL STK MKT ETF")
        .executeTakeFirstOrThrow();
      expect(alias.instrument_id).toBe(vti.id);

      // No instrument was created, and the string now resolves — the same
      // brokerage's next export passes through silently.
      const after = await db.selectFrom("instrument").select("id").execute();
      expect(after).toHaveLength(before.length);
      await expect(
        unresolvedStrings(["VANGUARD TOTAL STK MKT ETF"], db),
      ).resolves.toEqual([]);
    }),
  );

  it(
    "resolves byte-exact: an alias written with a trailing space leaves the bare spelling unresolved",
    withDatabase(async ({ db, seedInstrument }) => {
      const vti = await seedInstrument({ symbol: "VTI" });

      await resolveAll(
        [{ raw: "VTI ", fields: { kind: "existing", instrumentId: vti.id } }],
        { probe: forbiddenProbe },
        db,
      );

      // The round trip through resolution keeps `collate "C"` honest: the
      // respelling is still a first sighting, the exact bytes are not.
      await expect(unresolvedStrings(["VTI ", "VTI", "vti "], db)).resolves.toEqual([
        "VTI",
        "vti ",
      ]);
    }),
  );
});

describe("resolveAll — creating an instrument", () => {
  it(
    "stores what the provider calls the instrument",
    withDatabase(async ({ db }) => {
      const { probe } = okProbe("ETF");
      await resolveAll([{ raw: "VXUS", fields: createFields() }], { probe }, db);

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
    withDatabase(async ({ db }) => {
      // A quote that came back without the field. The catch-all row that
      // receives this on the Analysis screen is visible and counted; an
      // instrument filed as an equity because nobody said otherwise would not
      // be.
      const { probe } = okProbe(null);
      await resolveAll([{ raw: "VXUS", fields: createFields() }], { probe }, db);

      const created = await db
        .selectFrom("instrument")
        .select("quote_type")
        .where("symbol", "=", "VXUS")
        .executeTakeFirstOrThrow();

      expect(created.quote_type).toBeNull();
    }),
  );

  it(
    "writes the classification first when new, then the instrument, then the alias",
    withDatabase(async ({ db }) => {
      const { probe, calls } = okProbe();

      const resolved = await resolveAll(
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
      // The probe already asked the provider what this is; the created row is
      // where that answer goes, and the Analysis screen's stocks-versus-funds
      // split is what reads it back.
      expect(instrument.quote_type).toBe("EQUITY");

      const alias = await db
        .selectFrom("instrument_alias")
        .selectAll()
        .where("raw_string", "=", "VXUS")
        .executeTakeFirstOrThrow();
      expect(alias.instrument_id).toBe(instrument.id);
      expect(resolved).toEqual([{ raw: "VXUS", instrumentId: instrument.id }]);

      expect(calls).toEqual(["VXUS"]);
    }),
  );

  it(
    "creates a classification typed twice in one submit once, shared, never refused against itself",
    withDatabase(async ({ db }) => {
      const { probe } = okProbe();

      await resolveAll(
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
    withDatabase(async ({ db, seedClassification }) => {
      const classification = await seedClassification();

      const refusal = await refusalOf(() =>
        resolveAll(
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
    withDatabase(async ({ db, seedClassification }) => {
      const classification = await seedClassification();

      await resolveAll(
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
        // A manual instrument has nothing to quote, so the probe must never
        // run — the throwing stub is the assertion.
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

      const alias = await db
        .selectFrom("instrument_alias")
        .select("instrument_id")
        .where("raw_string", "=", "VANG TARGET RET 2045")
        .executeTakeFirstOrThrow();
      expect(alias.instrument_id).toBe(instrument.id);
    }),
  );

  it(
    "refuses a new classification name that already exists, naming it",
    withDatabase(async ({ db, seedClassification }) => {
      await seedClassification({ name: "Growth", assetClass: "equity" });

      const refusal = await refusalOf(() =>
        resolveAll(
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

      // Refused before anything was written.
      const aliases = await db
        .selectFrom("instrument_alias")
        .select("raw_string")
        .where("raw_string", "=", "VXUS")
        .execute();
      expect(aliases).toHaveLength(0);
    }),
  );
});

describe("resolveAll — the USD probe", () => {
  it(
    "refuses a non-USD quote naming the symbol and the currency, writing nothing for that string",
    withDatabase(async ({ db, seedInstrument }) => {
      const usd = await seedInstrument({ symbol: "USDX", name: "Cash-like" });
      const instrumentsBefore = await db.selectFrom("instrument").select("id").execute();

      const refusal = await refusalOf(() =>
        resolveAll(
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

      // The refresh guard's stem wording, with only its tail adapted.
      expect(refusal.fieldErrors["symbol-1"]).toBe(
        "VWRL is quoted in GBP. This instance holds USD only, so it was not created.",
      );

      // Nothing for that string was written — no instrument, no
      // classification, no alias. The refusal is atomic, so the sibling
      // string's alias waits too and the screen re-renders every question.
      const instrumentsAfter = await db.selectFrom("instrument").select("id").execute();
      expect(instrumentsAfter).toHaveLength(instrumentsBefore.length);
      const aliases = await db
        .selectFrom("instrument_alias")
        .select("raw_string")
        .where("raw_string", "in", ["VWRL", "FCASH"])
        .execute();
      expect(aliases).toHaveLength(0);
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
    withDatabase(async ({ db }) => {
      await resolveAll(
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

      await expect(unresolvedStrings(["VXUS"], db)).resolves.toEqual([]);
    }),
  );
});

describe("resolveAll — the whole submission", () => {
  it(
    "refuses a submit that leaves one string unanswered — there is no skip",
    withDatabase(async ({ db, seedInstrument }) => {
      const vti = await seedInstrument({ symbol: "VTI" });

      const refusal = await refusalOf(() =>
        resolveAll(
          [
            { raw: "VTI", fields: { kind: "existing", instrumentId: vti.id } },
            { raw: "CASH & CASH INVESTMENTS", fields: {} },
          ],
          { probe: forbiddenProbe },
          db,
        ),
      );

      expect(refusal.fieldErrors["kind-1"]).toMatch(/silently missing/);

      // The answered string is not written either: the refusal re-renders
      // the same list of questions it was asked about.
      const aliases = await db
        .selectFrom("instrument_alias")
        .select("raw_string")
        .where("raw_string", "=", "VTI")
        .execute();
      expect(aliases).toHaveLength(0);
    }),
  );

  it(
    "tolerates a concurrently-planted alias: the existing row wins and no duplicate is left",
    withDatabase(async ({ db, seedInstrument, seedInstrumentAlias }) => {
      const cash = await seedInstrument({ symbol: "USDY", name: "Cash" });
      await seedInstrumentAlias({ instrument: cash, rawString: "CASH & CASH INVESTMENTS" });
      const before = await db.selectFrom("instrument").select("id").execute();

      const resolved = await resolveAll(
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

      // The result points at the winner, not at what this submit tried to
      // create — and the instrument created for the losing answer is not
      // left behind for the point-at-existing select to offer forever.
      expect(resolved).toEqual([
        { raw: "CASH & CASH INVESTMENTS", instrumentId: cash.id },
      ]);
      const alias = await db
        .selectFrom("instrument_alias")
        .select("instrument_id")
        .where("raw_string", "=", "CASH & CASH INVESTMENTS")
        .executeTakeFirstOrThrow();
      expect(alias.instrument_id).toBe(cash.id);
      const after = await db.selectFrom("instrument").select("id").execute();
      expect(after).toHaveLength(before.length);
    }),
  );

  it(
    "makes the next upload silent: everything resolved here stops being unresolved",
    withDatabase(async ({ db, seedInstrument, seedClassification }) => {
      const vti = await seedInstrument({ symbol: "VTI" });
      const classification = await seedClassification();

      await resolveAll(
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
          db,
        ),
      ).resolves.toEqual(["SOMETHING ELSE"]);
    }),
  );
});

describe("resolutionScreen", () => {
  it(
    "lists only the first sightings, with the row's name and quantity beside each",
    withDatabase(async ({ db, seedInstrument, seedInstrumentAlias, seedClassification }) => {
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
        db,
      );

      // The resolved string is absent; the misses keep file order and carry
      // the context the screen shows — the name value and the quantity.
      expect(screen.totalPositions).toBe(3);
      expect(screen.unresolved).toEqual([
        {
          raw: "VXUS",
          name: "Vanguard Total International Stock ETF",
          quantity: "120.000",
        },
        { raw: "CASH & CASH INVESTMENTS", name: null, quantity: "4210.55" },
      ]);

      // The selects' raw material: every instrument and classification.
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
    // HTML form serialisation rewrites a lone LF or CR inside a posted value
    // to CRLF, so a quoted multi-line cell echoed through a hidden field
    // would fail a byte-exact check on every submit, forever.
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

/**
 * Moved here from `column-mapping.test.ts`, which imported it from this module:
 * the lookup is resolution's, not the mapping's, and a rule tested a file away
 * from the code it governs is a rule nobody finds when that code changes.
 */
describe("unresolvedStrings", () => {
  it(
    "matches byte-exactly, so a case or padding difference is a miss",
    withDatabase(async ({ db, seedInstrument, seedInstrumentAlias }) => {
      const instrument = await seedInstrument({ symbol: "VTI" });
      await seedInstrumentAlias({ instrument, rawString: "VTI" });

      await expect(unresolvedStrings(["VTI", "vti", "VTI ", " VTI"], db)).resolves.toEqual([
        "vti",
        "VTI ",
        " VTI",
      ]);
    }),
  );

  it(
    "answers nothing for a file whose every string is already vocabulary",
    withDatabase(async ({ db, seedInstrument, seedInstrumentAlias }) => {
      const instrument = await seedInstrument({ symbol: "VTI" });
      await seedInstrumentAlias({ instrument, rawString: "VTI" });
      await seedInstrumentAlias({ instrument, rawString: "Vanguard Total Stock Market ETF" });

      await expect(
        unresolvedStrings(["VTI", "Vanguard Total Stock Market ETF", "VTI"], db),
      ).resolves.toEqual([]);
      // An empty file asks nothing, rather than reaching the database to find
      // out that it has nothing to ask.
      await expect(unresolvedStrings([], db)).resolves.toEqual([]);
    }),
  );

  it(
    "keeps first-appearance order and collapses repeats, the order the screen asks in",
    withDatabase(async ({ db }) => {
      await expect(unresolvedStrings(["BND", "VTI", "BND", "AAPL", "VTI"], db)).resolves.toEqual([
        "BND",
        "VTI",
        "AAPL",
      ]);
    }),
  );

  it(
    "reads an alias written for one institution's statement when another's names the same string",
    withDatabase(async ({ db, seedInstrument, seedInstrumentAlias }) => {
      // `instrument_alias` is deliberately global: one `raw_string`, one
      // instrument, no institution column between them. So Fidelity writing
      // `CASH` resolves it for Schwab too, and the second brokerage's first
      // upload asks nothing.
      //
      // This replaces a test that read `information_schema.columns` back and
      // asserted the table had exactly two columns — true, brittle, and about
      // the schema file rather than about what the schema does. Adding a
      // `created_at` would have failed it and changed nothing.
      const usd = await seedInstrument({ symbol: "USD", name: "US Dollar" });
      await seedInstrumentAlias({ instrument: usd, rawString: "CASH" });

      await expect(unresolvedStrings(["CASH"], db)).resolves.toEqual([]);
    }),
  );
});
