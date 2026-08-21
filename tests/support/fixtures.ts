/**
 * A fixture builder that speaks the domain.
 *
 * Tests seed a person, an account, a position set with holdings, a quote — the
 * vocabulary of DESIGN.md §4 — and never write an `INSERT` in a test body. When
 * a column moves, this file changes and no test does.
 *
 * This is the one piece of test code allowed to know the schema. Everything
 * else in a test knows only the domain and the query module, which is what
 * keeps the tests honest about behaviour rather than about column names.
 *
 * Money and quantity are handed in as **decimal strings**, exactly as they
 * cross the driver boundary in the other direction. A test that writes
 * `quantity: 0.1` would be introducing the float this design spent a migration
 * and a type-parser override keeping out, so the types here refuse it.
 */
import type { Kysely } from "kysely";

import type { Database } from "~/lib/db.server";
import type { AccountKind, AssetClass, TaxTreatment } from "~/lib/valuation.server";

export type SeededPerson = { id: string; name: string };
export type SeededAccount = { id: string; name: string; ownerId: string };
export type SeededClassification = { id: string; name: string; assetClass: AssetClass };
export type SeededInstrument = { id: string; symbol: string | null; name: string };
export type SeededPositionSet = { id: string; accountId: string; asOf: string };
export type SeededUploadDraft = { id: string; accountId: string };

/** A line on a statement: how much of what, and what it cost. */
export type HoldingInput = {
  instrument: SeededInstrument;
  /** Decimal string. Negative for a liability — the sign lives here. */
  quantity: string;
  /** Omitted means the statement did not carry one, which is the common case. */
  costBasisPerShare?: string;
};

export type Fixtures = {
  seedPerson(options?: { name?: string }): Promise<SeededPerson>;

  seedAccount(options?: {
    name?: string;
    institution?: string;
    kind?: AccountKind;
    /** Defaults to a freshly seeded person, since every account needs an owner. */
    owner?: SeededPerson;
    taxTreatment?: TaxTreatment;
    externalAccountNumber?: string;
    /** Setting this is how an account is closed; closing never deletes. */
    closedAt?: Date | string;
  }): Promise<SeededAccount>;

  seedClassification(options?: {
    name?: string;
    assetClass?: AssetClass;
  }): Promise<SeededClassification>;

  seedInstrument(options?: {
    symbol?: string | null;
    name?: string;
    quoteType?: string | null;
    priceSource?: "feed" | "fixed" | "manual";
    /** Defaults to a freshly seeded classification. */
    classification?: SeededClassification;
  }): Promise<SeededInstrument>;

  /**
   * An alias row planted as though an earlier upload resolved it — the
   * concurrent-draft row a resolution test collides with, and the "already
   * seen" case a lookup test hits. Byte-exact, like the column it writes.
   */
  seedInstrumentAlias(options: {
    instrument: SeededInstrument;
    rawString: string;
  }): Promise<void>;

  seedPositionSet(options: {
    account: SeededAccount;
    /** `YYYY-MM-DD`. The statement's date, never the upload's. */
    asOf: string;
    source?: "upload" | "manual";
    sourceFilename?: string;
    /**
     * Overrides the insert time. The tie-break between two sets sharing an
     * as-of date reads this before it falls back to id, so a test about
     * corrections needs to control it.
     */
    createdAt?: Date | string;
    /** An empty set is legal: it is how "sold everything" is recorded. */
    holdings?: HoldingInput[];
  }): Promise<SeededPositionSet>;

  /**
   * A half-finished upload, staged but not committed.
   *
   * Bypasses `createDraft` deliberately — the domain function refuses closed
   * accounts and sweeps as a side effect, and a fixture that swept would eat
   * the very rows a sweep test just planted.
   */
  seedUploadDraft(options: {
    account: SeededAccount;
    filename?: string;
    bytes?: Uint8Array;
    /**
     * Overrides the insert time, which is what the 24-hour sweep reads — a
     * test about the sweep backdates a draft through this.
     */
    createdAt?: Date | string;
  }): Promise<SeededUploadDraft>;

  seedQuote(options: {
    instrument: SeededInstrument;
    /** Decimal string. Always positive — a liability is negative quantity. */
    price: string;
    /** A failed refresh keeps the last known price and marks it stale. */
    isStale?: boolean;
    asOf?: Date | string;
    yieldPct?: string;
    annualDividendPerShare?: string;
  }): Promise<void>;

  /**
   * A row on the immutable daily spine — what the as-of reads price from.
   *
   * Deliberately one row per call and never generated in a range: a weekend or
   * a market holiday is represented by the *absence* of a row (DESIGN.md §6.2),
   * so a test asks for a Saturday by seeding Friday and nothing else.
   */
  seedDailyClose(options: {
    instrument: SeededInstrument;
    /** `YYYY-MM-DD`. The trading day, never the day it was fetched. */
    date: string;
    /** Decimal string. Always positive — a liability is negative quantity. */
    close: string;
  }): Promise<void>;

  /**
   * A hand-typed point on the pre-day-zero net worth series (DESIGN.md §7).
   *
   * Has no position set behind it and never gets one: the whole point of the
   * manual series is the stretch of history where no statement exists.
   */
  seedManualNetWorth(options: {
    /** `YYYY-MM-DD`. */
    date: string;
    /** Decimal string, as every money value crossing this boundary is. */
    amount: string;
  }): Promise<void>;

  /**
   * The `USD` instrument seeded by the initial migration, priced at 1.00.
   *
   * Cash and debt are positions in it, which is what lets a bank balance and a
   * share position travel the same code path (DESIGN.md §2).
   */
  usdInstrument(): Promise<SeededInstrument>;
};

/**
 * Distinguishes generated names within a run. `classification.name` is unique,
 * so two defaulted classifications in one test must not collide.
 */
let sequence = 0;
const next = (): number => ++sequence;

export function makeFixtures(db: Kysely<Database>): Fixtures {
  const seedPerson: Fixtures["seedPerson"] = async ({ name = `Person ${next()}` } = {}) => {
    const row = await db
      .insertInto("person")
      .values({ name })
      .returning(["id", "name"])
      .executeTakeFirstOrThrow();
    return { id: row.id, name: row.name };
  };

  const seedClassification: Fixtures["seedClassification"] = async ({
    name = `Classification ${next()}`,
    assetClass = "equity",
  } = {}) => {
    const row = await db
      .insertInto("classification")
      .values({ name, asset_class: assetClass })
      .returning(["id", "name"])
      .executeTakeFirstOrThrow();
    return { id: row.id, name: row.name, assetClass };
  };

  const seedAccount: Fixtures["seedAccount"] = async ({
    name = `Account ${next()}`,
    institution = "Test Institution",
    kind = "brokerage",
    owner,
    taxTreatment = "taxable",
    externalAccountNumber,
    closedAt,
  } = {}) => {
    const ownerId = (owner ?? (await seedPerson())).id;
    const row = await db
      .insertInto("account")
      .values({
        name,
        institution,
        kind,
        owner_id: ownerId,
        tax_treatment: taxTreatment,
        external_account_number: externalAccountNumber ?? null,
        closed_at: closedAt ?? null,
      })
      .returning(["id", "name"])
      .executeTakeFirstOrThrow();
    return { id: row.id, name: row.name, ownerId };
  };

  const seedInstrument: Fixtures["seedInstrument"] = async ({
    symbol = `SYM${next()}`,
    name = `Instrument ${next()}`,
    quoteType = "EQUITY",
    priceSource = "feed",
    classification,
  } = {}) => {
    const classificationId = (classification ?? (await seedClassification())).id;
    const row = await db
      .insertInto("instrument")
      .values({
        symbol,
        name,
        quote_type: quoteType,
        price_source: priceSource,
        classification_id: classificationId,
      })
      .returning(["id", "symbol", "name"])
      .executeTakeFirstOrThrow();
    return { id: row.id, symbol: row.symbol, name: row.name };
  };

  const seedInstrumentAlias: Fixtures["seedInstrumentAlias"] = async ({
    instrument,
    rawString,
  }) => {
    await db
      .insertInto("instrument_alias")
      .values({ raw_string: rawString, instrument_id: instrument.id })
      .execute();
  };

  const seedPositionSet: Fixtures["seedPositionSet"] = async ({
    account,
    asOf,
    source = "upload",
    sourceFilename,
    createdAt,
    holdings = [],
  }) => {
    const row = await db
      .insertInto("position_set")
      .values({
        account_id: account.id,
        as_of_date: asOf,
        source,
        source_filename: sourceFilename ?? null,
        // Left to the column default when a test does not care, which inside a
        // transaction is the transaction's own timestamp — so two sets seeded
        // in one test share it and the id tie-break decides, exactly as it does
        // for two uploads landing in the same instant.
        ...(createdAt === undefined ? {} : { created_at: createdAt }),
      })
      .returning(["id", "as_of_date"])
      .executeTakeFirstOrThrow();

    if (holdings.length > 0) {
      await db
        .insertInto("holding")
        .values(
          holdings.map((holding) => ({
            position_set_id: row.id,
            instrument_id: holding.instrument.id,
            quantity: holding.quantity,
            // Never defaulted to zero, at any layer: that would report a fake
            // gain equal to the entire untracked position.
            cost_basis_per_share: holding.costBasisPerShare ?? null,
          })),
        )
        .execute();
    }

    return { id: row.id, accountId: account.id, asOf: row.as_of_date };
  };

  const seedUploadDraft: Fixtures["seedUploadDraft"] = async ({
    account,
    filename = `statement-${next()}.csv`,
    bytes = new TextEncoder().encode("Symbol,Quantity\n"),
    createdAt,
  }) => {
    const row = await db
      .insertInto("upload_draft")
      .values({
        account_id: account.id,
        filename,
        raw_file: Buffer.from(bytes),
        // Left to the column default when a test does not care, exactly as
        // `seedPositionSet` leaves its `created_at`.
        ...(createdAt === undefined ? {} : { created_at: createdAt }),
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    return { id: row.id, accountId: account.id };
  };

  const seedQuote: Fixtures["seedQuote"] = async ({
    instrument,
    price,
    isStale = false,
    asOf = new Date(),
    yieldPct,
    annualDividendPerShare,
  }) => {
    const values = {
      instrument_id: instrument.id,
      price,
      is_stale: isStale,
      as_of: asOf,
      yield_pct: yieldPct ?? null,
      annual_dividend_per_share: annualDividendPerShare ?? null,
    };

    // Upsert, because the quote table is the intraday tier and is overwritten
    // in place (DESIGN.md §6.2) — and because `USD` already has one.
    await db
      .insertInto("quote")
      .values(values)
      .onConflict((conflict) => conflict.column("instrument_id").doUpdateSet(values))
      .execute();
  };

  const seedDailyClose: Fixtures["seedDailyClose"] = async ({ instrument, date, close }) => {
    const values = { instrument_id: instrument.id, date, close };

    // Upsert for symmetry with `seedQuote`, and because `USD` already carries a
    // 1970-01-01 row from the initial migration — the one a test re-prices when
    // it wants cash to be something other than a dollar.
    await db
      .insertInto("price_daily")
      .values(values)
      .onConflict((conflict) => conflict.columns(["instrument_id", "date"]).doUpdateSet(values))
      .execute();
  };

  const seedManualNetWorth: Fixtures["seedManualNetWorth"] = async ({ date, amount }) => {
    const values = { date, amount };

    await db
      .insertInto("manual_networth")
      .values(values)
      .onConflict((conflict) => conflict.column("date").doUpdateSet(values))
      .execute();
  };

  const usdInstrument: Fixtures["usdInstrument"] = async () => {
    const row = await db
      .selectFrom("instrument")
      .select(["id", "symbol", "name"])
      .where("symbol", "=", "USD")
      .executeTakeFirstOrThrow();
    return { id: row.id, symbol: row.symbol, name: row.name };
  };

  return {
    seedPerson,
    seedAccount,
    seedClassification,
    seedInstrument,
    seedInstrumentAlias,
    seedPositionSet,
    seedUploadDraft,
    seedQuote,
    seedDailyClose,
    seedManualNetWorth,
    usdInstrument,
  };
}
