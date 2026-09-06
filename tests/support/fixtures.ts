/**
 * Seeds the domain vocabulary (DESIGN.md §4) directly — a person, an
 * account, a position set, a quote — so no test writes an INSERT and a
 * schema change touches only this file. Money/quantity are decimal strings,
 * exactly as they cross the driver boundary.
 */
import { createHash } from "node:crypto";

import type { Kysely } from "kysely";
import type { Pool, PoolClient } from "pg";

import type { Database } from "~/lib/db.server";
import { joinTransports } from "~/lib/lock";
import type { BackfillOutcome } from "~/lib/prices.server";
import type { AccountKind, AssetClass, TaxTreatment } from "~/lib/valuation.server";

export type SeededPerson = { id: string; name: string };
export type SeededAccount = { id: string; name: string; ownerId: string };
export type SeededClassification = { id: string; name: string; assetClass: AssetClass };
export type SeededInstrument = { id: string; symbol: string | null; name: string };
export type SeededPositionSet = { id: string; accountId: string; asOf: string };
export type SeededUploadDraft = { id: string; accountId: string };
export type SeededPasskey = { credentialId: string; label: string };
export type SeededUnlockGrant = { id: string; passkeyId: string };

export type HoldingInput = {
  instrument: SeededInstrument;
  // Negative for a liability — the sign lives here.
  quantity: string;
  costBasisPerShare?: string;
};

export type Fixtures = {
  seedPerson(options?: { name?: string }): Promise<SeededPerson>;

  seedAccount(options?: {
    name?: string;
    institution?: string;
    kind?: AccountKind;
    owner?: SeededPerson;
    taxTreatment?: TaxTreatment;
    externalAccountNumber?: string;
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
    classification?: SeededClassification;
  }): Promise<SeededInstrument>;

  /** Alias row as if an earlier upload resolved it — byte-exact, like the column it writes. */
  seedInstrumentAlias(options: {
    instrument: SeededInstrument;
    rawString: string;
  }): Promise<void>;

  seedPositionSet(options: {
    account: SeededAccount;
    /** YYYY-MM-DD, the statement's date, never the upload's. */
    asOf: string;
    source?: "upload" | "manual";
    sourceFilename?: string;
    /** Tie-break for two sets sharing as_of reads this before id — corrections tests need control. */
    createdAt?: Date | string;
    /** Empty is legal: how "sold everything" is recorded. */
    holdings?: HoldingInput[];
  }): Promise<SeededPositionSet>;

  /** Bypasses createDraft: it refuses closed accounts and sweeps as a side effect, which would eat rows a sweep test just planted. */
  seedUploadDraft(options: {
    account: SeededAccount;
    filename?: string;
    bytes?: Uint8Array;
    /** What the 24h sweep reads — backdate a draft through this. */
    createdAt?: Date | string;
  }): Promise<SeededUploadDraft>;

  seedQuote(options: {
    instrument: SeededInstrument;
    /** Decimal string, always positive — a liability is negative quantity, not negative price. */
    price: string;
    /** A failed refresh keeps the last known price and marks it stale. */
    isStale?: boolean;
    asOf?: Date | string;
    yieldPct?: string;
    annualDividendPerShare?: string;
  }): Promise<void>;

  /** Immutable daily spine. Weekend/holiday = absent row (DESIGN.md §6.2) — seed Friday for a Saturday ask. */
  seedDailyClose(options: {
    instrument: SeededInstrument;
    /** YYYY-MM-DD, the trading day, never the fetch day. */
    date: string;
    /** Decimal string, always positive. */
    close: string;
  }): Promise<void>;

  /** One row of the observation log (ADR-0006): a price the feed reported for one instrument at one instant. */
  seedObservation(options: {
    instrument: SeededInstrument;
    /** The provider's own instant; half of the primary key. */
    asOf: Date | string;
    /** Decimal string, the only column anything may compute from. */
    price: string;
    /** YYYY-MM-DD. Defaults to the UTC day inside asOf. */
    marketDate?: string;
    fetchedAt?: Date | string;
    /** Provider's raw entry. Absent unless the test is about the archive. */
    payload?: unknown;
  }): Promise<void>;

  /** One recorded refresh attempt (ADR-0006) — tells a quiet market apart from a server that wasn't running. */
  seedPoll(options: {
    startedAt: Date | string;
    requested?: number;
    priced?: number;
    stale?: number;
  }): Promise<void>;

  /**
   * One recorded backfill attempt (ADR-0011) — keeps an unfillable gap to one
   * request a day; Settings → Prices reads a reason from it. Nothing is
   * defaulted from `outcome`: the ledger's check constraints tie count/error
   * to it.
   */
  seedBackfillAttempt(options: {
    instrument: SeededInstrument;
    /** When the fetch began, not when the row committed — the retry clock reads this. */
    startedAt: Date | string;
    outcome: BackfillOutcome;
    rangeFrom?: string;
    rangeUntil?: string; // exclusive, must be later than rangeFrom
    /** Closes the spine didn't already hold. Positive exactly for `filled`. */
    written?: number;
    /** The provider's text. Present exactly for `provider_failed`. */
    error?: string;
  }): Promise<void>;

  /** Pre-day-zero net worth point (DESIGN.md §7) — no position set behind it, ever. */
  seedManualNetWorth(options: {
    date: string;
    amount: string;
  }): Promise<void>;

  /** The USD instrument the initial migration seeds, priced at 1.00 — cash/debt are positions in it (DESIGN.md §2). */
  usdInstrument(): Promise<SeededInstrument>;

  /** A passkey the household enrolled (ADR-0012). publicKey is required, not defaulted, so a signature-verifying test can't get a key its signature wasn't made against. */
  seedPasskey(options: {
    credentialId?: string;
    publicKey: Uint8Array;
    label?: string;
    /** Defaults to a fresh credential's initial 0. */
    counter?: number;
    backupEligible?: boolean;
    /** Stored comma-joined; omitted means none reported. */
    transports?: string[];
    /** Marks the household's one bootstrap enrolment (passkey_bootstrap_idx). */
    bootstrap?: boolean;
    enrolledAt?: Date | string;
    lastUsedAt?: Date | string;
  }): Promise<SeededPasskey>;

  /** One browser's current unlock (ADR-0012). */
  seedUnlockGrant(options: {
    id?: string;
    /** Plain string, not SeededPasskey, so a test can name a passkey that doesn't exist (FK case). */
    passkeyId: string;
    /** Defaults an hour out — deliberately not the lock's idle window (ticket 02 owns that figure). Set a past instant for an expired-grant test. */
    expiresAt?: Date | string;
  }): Promise<SeededUnlockGrant>;
};

/** Distinguishes generated names within a run — two defaulted classifications must not collide. */
let sequence = 0;
const next = (): number => ++sequence;

/**
 * The bootstrap race's three statements, over a raw pg handle rather than
 * the Kysely transaction every builder above writes through — one
 * transaction can't exercise two connections racing on `passkey_bootstrap_idx`
 * (neither sees the other's uncommitted row).
 */
type RawHandle = Pick<Pool | PoolClient, "query">;

/** Insert a passkey flagged as the household's bootstrap enrolment. */
export function insertBootstrapPasskey(
  handle: RawHandle,
  credentialId: string,
): Promise<unknown> {
  return handle.query(
    `insert into passkey (credential_id, public_key, backup_eligible, label, bootstrap)
     values ($1, $2, false, 'Race', true)`,
    [credentialId, Buffer.from([0])],
  );
}

/** Whether that passkey is there — the positive half of the race's assertion. */
export async function bootstrapPasskeyExists(
  handle: RawHandle,
  credentialId: string,
): Promise<boolean> {
  const result = await handle.query("select 1 from passkey where credential_id = $1", [
    credentialId,
  ]);
  return result.rows.length === 1;
}

/** Removes every passkey the race planted. Run at both ends — a run killed right after the unblocking commit would strand rows for the next run otherwise. */
export async function clearRacingPasskeys(handle: RawHandle): Promise<void> {
  await handle.query("delete from passkey where credential_id like $1", ["race-%"]);
}

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
        // Column default (txn's own timestamp) when a test doesn't care.
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
            // Never default to zero — that would report a fake gain equal to the untracked position.
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
        // Same column-default deferral as seedPositionSet's created_at.
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

    // Upsert: quote is the intraday tier, overwritten in place (DESIGN.md §6.2); USD already has one.
    await db
      .insertInto("quote")
      .values(values)
      .onConflict((conflict) => conflict.column("instrument_id").doUpdateSet(values))
      .execute();
  };

  const seedDailyClose: Fixtures["seedDailyClose"] = async ({ instrument, date, close }) => {
    const values = { instrument_id: instrument.id, date, close };

    // Upsert for symmetry with seedQuote; USD carries a 1970-01-01 row from the initial migration to re-price.
    await db
      .insertInto("price_daily")
      .values(values)
      .onConflict((conflict) => conflict.columns(["instrument_id", "date"]).doUpdateSet(values))
      .execute();
  };

  const seedObservation: Fixtures["seedObservation"] = async ({
    instrument,
    asOf,
    price,
    marketDate,
    fetchedAt,
    payload,
  }) => {
    const instant = typeof asOf === "string" ? new Date(asOf) : asOf;

    const values = {
      instrument_id: instrument.id,
      as_of: instant,
      // UTC day inside the instant — spelled out rather than borrowed from market-hours.ts, so a change there can't silently re-date this.
      market_date: marketDate ?? instant.toISOString().slice(0, 10),
      price,
      fetched_at: fetchedAt ?? instant,
      payload: payload === undefined ? null : JSON.stringify(payload),
    };

    await db
      .insertInto("price_observation")
      .values(values)
      .onConflict((conflict) =>
        conflict.columns(["instrument_id", "as_of"]).doUpdateSet(values),
      )
      .execute();
  };

  const seedPoll: Fixtures["seedPoll"] = async ({
    startedAt,
    requested = 1,
    priced = 1,
    stale = 0,
  }) => {
    await db
      .insertInto("price_poll")
      .values({ started_at: startedAt, requested, priced, stale })
      .execute();
  };

  const seedBackfillAttempt: Fixtures["seedBackfillAttempt"] = async ({
    instrument,
    startedAt,
    outcome,
    // Fixed, not clock-derived — a moving default would make the assertions that care depend on when they ran.
    rangeFrom = "2024-01-01",
    rangeUntil = "2024-02-01",
    written = 0,
    error,
  }) => {
    await db
      .insertInto("price_backfill")
      .values({
        instrument_id: instrument.id,
        started_at: startedAt,
        range_from: rangeFrom,
        range_until: rangeUntil,
        written,
        outcome,
        error: error ?? null,
      })
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

  const seedPasskey: Fixtures["seedPasskey"] = async ({
    credentialId = `credential-${next()}`,
    publicKey,
    label = `Passkey ${next()}`,
    counter = 0,
    backupEligible = false,
    transports,
    bootstrap = false,
    enrolledAt,
    lastUsedAt,
  }) => {
    const row = await db
      .insertInto("passkey")
      .values({
        credential_id: credentialId,
        public_key: Buffer.from(publicKey),
        counter,
        // joinTransports: shared writer with lock.server.ts; migration's transports comment states the encoding rule.
        transports: joinTransports(transports),
        backup_eligible: backupEligible,
        label,
        bootstrap,
        ...(enrolledAt === undefined ? {} : { enrolled_at: enrolledAt }),
        last_used_at: lastUsedAt ?? null,
      })
      .returning(["credential_id", "label"])
      .executeTakeFirstOrThrow();

    return { credentialId: row.credential_id, label: row.label };
  };

  const seedUnlockGrant: Fixtures["seedUnlockGrant"] = async ({
    // Base64url, past the domain's length(id)>=32 check; hashed from the counter for a deterministic default (not the security boundary).
    id = createHash("sha256").update(`unlock-grant-${next()}`).digest("base64url"),
    passkeyId,
    expiresAt = new Date(Date.now() + 60 * 60 * 1000),
  }) => {
    const row = await db
      .insertInto("unlock_grant")
      .values({
        id,
        passkey_id: passkeyId,
        expires_at: expiresAt,
      })
      .returning(["id", "passkey_id"])
      .executeTakeFirstOrThrow();

    return { id: row.id, passkeyId: row.passkey_id };
  };

  const usdInstrument: Fixtures["usdInstrument"] = async () => {
    const row = await db
      .selectFrom("instrument")
      .select(["id", "symbol", "name"])
      .where("symbol", "=", "USD")
      // Oldest row — a second USD (ING-8) would otherwise make this pick whichever the planner returns.
      .orderBy("id")
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
    seedObservation,
    seedPoll,
    seedBackfillAttempt,
    seedManualNetWorth,
    seedPasskey,
    seedUnlockGrant,
    usdInstrument,
  };
}
