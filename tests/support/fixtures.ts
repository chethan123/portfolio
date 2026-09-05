/**
 * A fixture builder that speaks the domain: tests seed a person, an
 * account, a position set, a quote — DESIGN.md §4's vocabulary — and never
 * write an `INSERT` in a test body; when a column moves, this file changes
 * and no test does. The one piece of test code allowed to know the schema —
 * everything else knows only the domain and the query module. Money and
 * quantity are handed in as **decimal strings**, exactly as they cross the
 * driver boundary the other way: `quantity: 0.1` would introduce the float
 * this design spent a migration keeping out, so the types refuse it.
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
   * One row of the observation log (ADR-0006) — a price the feed reported for
   * one instrument at one instant.
   *
   * `marketDate` defaults to the calendar day inside `asOf`, which is what the
   * refresh stamps for a market in UTC and what a test wanting the ordinary
   * case means. A test about the instant-to-day rule itself — an evening NAV
   * belonging to the previous session — states it.
   *
   * Append-only in production; upserting here for the same reason `seedQuote`
   * does, so a test may re-price an instant it has already seeded.
   */
  seedObservation(options: {
    instrument: SeededInstrument;
    /** The provider's own instant. Half of the primary key. */
    asOf: Date | string;
    /** Decimal string. The only column anything may compute from. */
    price: string;
    /** `YYYY-MM-DD`. Defaults to the UTC day inside `asOf`. */
    marketDate?: string;
    /** When we learned it. Defaults to `asOf`. */
    fetchedAt?: Date | string;
    /** The provider's raw entry. Absent unless a test is about the archive. */
    payload?: unknown;
  }): Promise<void>;

  /**
   * One recorded refresh attempt (ADR-0006) — what tells a quiet market apart
   * from a server that was not running.
   */
  seedPoll(options: {
    startedAt: Date | string;
    requested?: number;
    priced?: number;
    stale?: number;
  }): Promise<void>;

  /**
   * One recorded backfill attempt (ADR-0011) — what keeps an unfillable gap to
   * one request a day, and what Settings → Prices reads a reason out of.
   *
   * Nothing is defaulted from `outcome`: the ledger's `check` constraints tie
   * the count and the error text to it, and a builder that filled them in would
   * make the tests about those constraints unwritable.
   */
  seedBackfillAttempt(options: {
    instrument: SeededInstrument;
    /** When the fetch began, not when the row committed. The retry clock reads this. */
    startedAt: Date | string;
    outcome: BackfillOutcome;
    /** `YYYY-MM-DD`. Defaults to a range most tests are not about. */
    rangeFrom?: string;
    /** `YYYY-MM-DD`, exclusive. Must be later than `rangeFrom`. */
    rangeUntil?: string;
    /** Closes the spine did not already hold. Positive exactly for `filled`. */
    written?: number;
    /** The provider's text. Present exactly for `provider_failed`. */
    error?: string;
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

  /**
   * A passkey the household has enrolled (docs/adr/0012, `passkey`).
   *
   * The public key is required rather than defaulted, so the test that
   * verifies a signature (ticket 02's) can never be handed a default key its
   * signature was not made against.
   */
  seedPasskey(options: {
    /** Base64url text, exactly as the library would return it. */
    credentialId?: string;
    /** The credential's public half. Whatever the verifier checks a signature against. */
    publicKey: Uint8Array;
    label?: string;
    /** The signature counter. Defaults to a fresh credential's initial 0. */
    counter?: number;
    backupEligible?: boolean;
    /** What registration reported. Stored comma-joined; omitted means none reported. */
    transports?: string[];
    /** True marks this as the household's one bootstrap enrolment (`passkey_bootstrap_idx`). */
    bootstrap?: boolean;
    enrolledAt?: Date | string;
    /** Nullable until first use; a test about staleness or ordering sets this. */
    lastUsedAt?: Date | string;
  }): Promise<SeededPasskey>;

  /**
   * One browser's current unlock (docs/adr/0012, `unlock_grant`).
   *
   * `passkeyId` is a plain string rather than a `SeededPasskey`, so a test
   * about the foreign key — a grant naming a passkey that does not exist —
   * can hand it one directly.
   */
  seedUnlockGrant(options: {
    /** Defaults to a long opaque-looking token, shaped like what the domain module mints. */
    id?: string;
    passkeyId: string;
    /**
     * Defaults an hour out — comfortably in the future, and deliberately
     * not the lock's idle window: that figure is ticket 02's domain module
     * to name in exactly one place, and a fixture restating it would only
     * be able to silently disagree with it later. Set an already-past
     * instant for a test about an expired grant.
     */
    expiresAt?: Date | string;
  }): Promise<SeededUnlockGrant>;
};

/**
 * Distinguishes generated names within a run. `classification.name` is unique,
 * so two defaulted classifications in one test must not collide.
 */
let sequence = 0;
const next = (): number => ++sequence;

/**
 * The bootstrap race's three statements, over a raw `pg` handle rather than
 * the Kysely transaction every builder above writes through.
 *
 * `withDatabase` hands a test one transaction, and the thing
 * `passkey_bootstrap_idx` exists to make atomic is precisely what one
 * transaction cannot exercise: two connections racing, neither able to see
 * the other's uncommitted row. So the race needs raw connections — but the
 * schema knowledge still belongs here rather than in the test, for the reason
 * this whole file exists. A column added to `passkey` changes this file and
 * no test.
 *
 * Typed on the shape `Pool` and `PoolClient` share, because the race issues
 * its inserts on two pinned clients and its cleanup on the pool.
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

/**
 * Remove every passkey the race planted. Run at both ends of it: the race has
 * to commit one row to unblock the other connection, and a run killed between
 * that commit and its cleanup would otherwise leave the row behind for every
 * later run to trip over.
 */
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
      // The UTC day inside the instant, which is `marketDateOf` for a market in
      // UTC. Spelled out rather than borrowed from `market-hours.ts` so that a
      // test seeding a session cannot be quietly re-dated by a change to the
      // rule it is not testing.
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
    // Fixed dates rather than dates derived from the clock: the range is not
    // what most of these tests are about, and a moving default would make the
    // ones that do assert on it depend on when they ran.
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
        // `app/lib/lock.ts`'s writer, shared with `lock.server.ts` so the
        // encoding rule is written once (the migration's `transports`
        // comment states the rule itself).
        transports: joinTransports(transports),
        backup_eligible: backupEligible,
        label,
        bootstrap,
        // Left to the column default when a test does not care, exactly as
        // `seedPositionSet` leaves its `created_at`.
        ...(enrolledAt === undefined ? {} : { enrolled_at: enrolledAt }),
        last_used_at: lastUsedAt ?? null,
      })
      .returning(["credential_id", "label"])
      .executeTakeFirstOrThrow();

    return { credentialId: row.credential_id, label: row.label };
  };

  const seedUnlockGrant: Fixtures["seedUnlockGrant"] = async ({
    // A long opaque-looking token, shaped like what the domain module mints —
    // base64url text, well past the `length(id) >= 32` check — rather than a
    // short counted string. Hashed from the counter instead of drawn from a
    // cryptographic source: this is a fixture, not the security boundary, and
    // hashing keeps the default deterministic per call.
    id = createHash("sha256").update(`unlock-grant-${next()}`).digest("base64url"),
    passkeyId,
    // Comfortably in the future — see the option's doc comment for why this
    // is not the lock's idle window.
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
      // The seeded row, which is the oldest — a test that creates a second
      // `USD` (the instruments step does, report `ING-8`) would otherwise
      // assert against whichever one the plan happened to return.
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
