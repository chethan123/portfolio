/**
 * The coverage gap, as a question about rows.
 *
 * A backfill exists because a statement describes its own date: the first
 * upload of any instrument new to the system predates that instrument's first
 * close, so `holding_valued_at` finds nothing to price it with and the chart
 * draws cash minus loans for the whole era before the instance was installed
 * (ADR-0011). What decides which instruments are in that state is a query, and
 * a query is only testable against a real database — which is where the risk
 * is, in the `numeric` and `date` handling a mock would erase.
 *
 * The ledger's `check` constraints are tested the same way and for the same
 * reason: they are the only thing that stops a count and an outcome disagreeing
 * years later, and TypeScript cannot enforce a rule Postgres holds.
 */
import { afterAll, describe, expect, it } from "vitest";

import {
  BACKFILL_OUTCOMES,
  selectBackfillCandidates,
  type BackfillOutcome,
} from "~/lib/prices.server";

import { closeTestDatabase, withDatabase } from "./support/database.ts";

afterAll(closeTestDatabase);

/** Two days ago — older than the retry interval, whatever the clock says. */
const LONG_AGO = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);

describe("which instruments carry a coverage gap", () => {
  it(
    "names an instrument that is held and has no close at all",
    withDatabase(async ({ db, seedAccount, seedInstrument, seedPositionSet }) => {
      const account = await seedAccount();
      const instrument = await seedInstrument({ symbol: "VTI", priceSource: "feed" });
      await seedPositionSet({
        account,
        asOf: "2024-03-29",
        holdings: [{ instrument, quantity: "10.00000000" }],
      });

      const candidates = await selectBackfillCandidates(db);

      expect(candidates.map((candidate) => candidate.id)).toEqual([instrument.id]);
    }),
  );

  it(
    "names an instrument whose spine starts later than its position history does",
    withDatabase(
      async ({ db, seedAccount, seedInstrument, seedPositionSet, seedDailyClose }) => {
        const account = await seedAccount();
        const instrument = await seedInstrument({ symbol: "VTI", priceSource: "feed" });
        await seedPositionSet({
          account,
          asOf: "2024-03-29",
          holdings: [{ instrument, quantity: "10.00000000" }],
        });
        // The poller started here — a year after the statement it is asked about.
        await seedDailyClose({ instrument, date: "2025-04-01", close: "250.0000" });

        const candidates = await selectBackfillCandidates(db);

        expect(candidates.map((candidate) => candidate.id)).toEqual([instrument.id]);
      },
    ),
  );

  it(
    "leaves alone an instrument whose spine already reaches its first-held date",
    withDatabase(
      async ({ db, seedAccount, seedInstrument, seedPositionSet, seedDailyClose }) => {
        const account = await seedAccount();
        const instrument = await seedInstrument({ symbol: "VTI", priceSource: "feed" });
        await seedPositionSet({
          account,
          asOf: "2024-03-29",
          holdings: [{ instrument, quantity: "10.00000000" }],
        });
        await seedDailyClose({ instrument, date: "2024-03-28", close: "250.0000" });

        expect(await selectBackfillCandidates(db)).toEqual([]);
      },
    ),
  );

  it(
    "leaves alone an instrument whose earliest close falls on its first-held date",
    withDatabase(
      async ({ db, seedAccount, seedInstrument, seedPositionSet, seedDailyClose }) => {
        const account = await seedAccount();
        const instrument = await seedInstrument({ symbol: "VTI", priceSource: "feed" });
        await seedPositionSet({
          account,
          asOf: "2024-03-29",
          holdings: [{ instrument, quantity: "10.00000000" }],
        });
        await seedDailyClose({ instrument, date: "2024-03-29", close: "250.0000" });

        expect(await selectBackfillCandidates(db)).toEqual([]);
      },
    ),
  );

  it(
    "never names a fixed, a manual, or a symbol-less instrument, whatever their positions",
    withDatabase(async ({ db, seedAccount, seedInstrument, seedPositionSet, usdInstrument }) => {
      const account = await seedAccount();
      // The seeded USD row: asking a feed what a dollar costs would overwrite
      // the constant cash and every liability are valued against.
      const usd = await usdInstrument();
      const trust = await seedInstrument({
        symbol: "CIT2045",
        name: "Target 2045 Trust II",
        priceSource: "manual",
      });
      const unnamed = await seedInstrument({ symbol: null, priceSource: "feed" });

      await seedPositionSet({
        account,
        asOf: "2024-03-29",
        holdings: [
          { instrument: usd, quantity: "1000.00000000" },
          { instrument: trust, quantity: "10.00000000" },
          { instrument: unnamed, quantity: "10.00000000" },
        ],
      });

      expect(await selectBackfillCandidates(db)).toEqual([]);
    }),
  );

  it(
    "never names an instrument nobody holds, because a gap is a property of the positions",
    withDatabase(async ({ db, seedInstrument }) => {
      // Created at resolution, before any position set exists — which is why
      // "new instrument" is the wrong trigger.
      await seedInstrument({ symbol: "VTI", priceSource: "feed" });

      expect(await selectBackfillCandidates(db)).toEqual([]);
    }),
  );

  it(
    "starts the range exactly seven days before the earliest position set",
    withDatabase(async ({ db, seedAccount, seedInstrument, seedPositionSet }) => {
      const account = await seedAccount();
      const instrument = await seedInstrument({ symbol: "VTI", priceSource: "feed" });
      // A Saturday. The lead is what finds a close to carry forward onto it.
      await seedPositionSet({
        account,
        asOf: "2024-03-30",
        holdings: [{ instrument, quantity: "10.00000000" }],
      });
      // A later set must not move the range's start.
      await seedPositionSet({
        account,
        asOf: "2024-06-28",
        holdings: [{ instrument, quantity: "12.00000000" }],
      });

      const candidates = await selectBackfillCandidates(db);

      expect(candidates[0]?.rangeFrom).toBe("2024-03-23");
    }),
  );

  it(
    "hands back the symbol as stored, uncorrected",
    withDatabase(async ({ db, seedAccount, seedInstrument, seedPositionSet }) => {
      const account = await seedAccount();
      const instrument = await seedInstrument({ symbol: "vti", priceSource: "feed" });
      await seedPositionSet({
        account,
        asOf: "2024-03-29",
        holdings: [{ instrument, quantity: "10.00000000" }],
      });

      const candidates = await selectBackfillCandidates(db);

      expect(candidates[0]?.symbol).toBe("vti");
    }),
  );
});

describe("the order a batch works in", () => {
  it(
    "puts the deepest gap first, not the first symbol alphabetically",
    withDatabase(async ({ db, seedAccount, seedInstrument, seedPositionSet }) => {
      const account = await seedAccount();
      // Sorted by symbol these come back the other way round, which is what
      // makes the assertion mean something.
      const shallow = await seedInstrument({ symbol: "AAPL", priceSource: "feed" });
      const deep = await seedInstrument({ symbol: "ZM", priceSource: "feed" });

      await seedPositionSet({
        account,
        asOf: "2025-01-31",
        holdings: [{ instrument: shallow, quantity: "1.00000000" }],
      });
      await seedPositionSet({
        account,
        asOf: "2019-06-28",
        holdings: [{ instrument: deep, quantity: "1.00000000" }],
      });

      const candidates = await selectBackfillCandidates(db);

      expect(candidates.map((candidate) => candidate.symbol)).toEqual(["ZM", "AAPL"]);
    }),
  );

  it(
    "breaks a tie on id, so two ticks agree on what next means",
    withDatabase(async ({ db, seedAccount, seedInstrument, seedPositionSet }) => {
      const account = await seedAccount();

      // Enough instruments sharing one date that the grouping's own output
      // order is a hash order rather than the scan order: with two, Postgres
      // happens to emit them by id and the tie-break asserts nothing.
      const instruments = [];
      for (let index = 0; index < 12; index += 1) {
        instruments.push(await seedInstrument({ symbol: `TIE${index}`, priceSource: "feed" }));
      }

      await seedPositionSet({
        account,
        asOf: "2024-03-29",
        holdings: instruments.map((instrument) => ({
          instrument,
          quantity: "1.00000000",
        })),
      });

      const candidates = await selectBackfillCandidates(db);
      const ids = instruments.map((instrument) => instrument.id);

      expect(candidates.map((candidate) => candidate.id)).toEqual(ids.slice(0, candidates.length));
    }),
  );

  it(
    "returns no more than the batch bound, and returns the first in that order",
    withDatabase(async ({ db, seedAccount, seedInstrument, seedPositionSet }) => {
      const account = await seedAccount();

      // More than any plausible bound, so the assertion never names its value:
      // what is fixed is that the bound holds and that it cuts the tail, not
      // the number a module constant happens to carry.
      const ordered: string[] = [];
      for (let index = 0; index < 12; index += 1) {
        const instrument = await seedInstrument({
          symbol: `SYM${index}`,
          priceSource: "feed",
        });
        await seedPositionSet({
          account,
          // Ascending, so the seeding order is the batch order.
          asOf: `2024-0${1 + Math.floor(index / 6)}-${String(1 + (index % 6)).padStart(2, "0")}`,
          holdings: [{ instrument, quantity: "1.00000000" }],
        });
        ordered.push(instrument.id);
      }

      const candidates = await selectBackfillCandidates(db);

      expect(candidates.length).toBeLessThan(ordered.length);
      expect(candidates.map((candidate) => candidate.id)).toEqual(
        ordered.slice(0, candidates.length),
      );
    }),
  );
});

describe("the daily retry clock", () => {
  it(
    "drops the instrument that was attempted and keeps the one that was not",
    withDatabase(
      async ({ db, seedAccount, seedInstrument, seedPositionSet, seedBackfillAttempt }) => {
        const account = await seedAccount();
        const attempted = await seedInstrument({ symbol: "DELISTED", priceSource: "feed" });
        // The second instrument is the assertion: an attempt is a fact about
        // one instrument, and a skip that did not correlate would suppress the
        // whole batch on one delisted ticker.
        const untouched = await seedInstrument({ symbol: "VTI", priceSource: "feed" });

        await seedPositionSet({
          account,
          asOf: "2024-03-29",
          holdings: [
            { instrument: attempted, quantity: "10.00000000" },
            { instrument: untouched, quantity: "10.00000000" },
          ],
        });
        await seedBackfillAttempt({
          instrument: attempted,
          startedAt: new Date(),
          outcome: "no_history",
        });

        const candidates = await selectBackfillCandidates(db);

        expect(candidates.map((candidate) => candidate.id)).toEqual([untouched.id]);
      },
    ),
  );

  it(
    "measures the interval in days, so an unfillable gap costs one request a day",
    withDatabase(
      async ({ db, seedAccount, seedInstrument, seedPositionSet, seedBackfillAttempt }) => {
        const account = await seedAccount();
        const justInside = await seedInstrument({ symbol: "INSIDE", priceSource: "feed" });
        const justOutside = await seedInstrument({ symbol: "OUTSIDE", priceSource: "feed" });

        await seedPositionSet({
          account,
          asOf: "2024-03-29",
          holdings: [
            { instrument: justInside, quantity: "1.00000000" },
            { instrument: justOutside, quantity: "1.00000000" },
          ],
        });

        // An hour either side of the day, which is what pins the interval to a
        // day rather than to any value that merely separates "now" from "long
        // ago" — ADR-0011 promises one request a day for a gap that cannot be
        // filled, and nothing else here asserts the number.
        await seedBackfillAttempt({
          instrument: justInside,
          startedAt: new Date(Date.now() - 23 * 60 * 60 * 1000),
          outcome: "no_history",
        });
        await seedBackfillAttempt({
          instrument: justOutside,
          startedAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
          outcome: "no_history",
        });

        const candidates = await selectBackfillCandidates(db);

        expect(candidates.map((candidate) => candidate.id)).toEqual([justOutside.id]);
      },
    ),
  );

  it(
    "keeps an instrument whose last attempt is older than that",
    withDatabase(
      async ({ db, seedAccount, seedInstrument, seedPositionSet, seedBackfillAttempt }) => {
        const account = await seedAccount();
        const instrument = await seedInstrument({ symbol: "DELISTED", priceSource: "feed" });
        await seedPositionSet({
          account,
          asOf: "2024-03-29",
          holdings: [{ instrument, quantity: "10.00000000" }],
        });
        await seedBackfillAttempt({
          instrument,
          startedAt: LONG_AGO,
          outcome: "no_history",
        });

        const candidates = await selectBackfillCandidates(db);

        expect(candidates.map((candidate) => candidate.id)).toEqual([instrument.id]);
      },
    ),
  );
});

describe("what the ledger will and will not record", () => {
  it(
    "accepts every outcome the vocabulary declares",
    withDatabase(async ({ db, seedInstrument, seedBackfillAttempt }) => {
      const instrument = await seedInstrument({ symbol: "VTI", priceSource: "feed" });

      // Iterated over the exported object rather than written out, which is
      // what makes this catch drift in the direction that actually happens: a
      // literal added to `BACKFILL_OUTCOMES` and not to the migration's
      // `check`. The two are kept in step by hand, and this is what notices.
      const outcomes = Object.values(BACKFILL_OUTCOMES);

      for (const outcome of outcomes) {
        await seedBackfillAttempt({
          instrument,
          startedAt: LONG_AGO,
          outcome,
          // The two constraints that tie a row's counts to its outcome; a new
          // literal writing neither is the ordinary case.
          written: outcome === BACKFILL_OUTCOMES.filled ? 3 : 0,
          error:
            outcome === BACKFILL_OUTCOMES.providerFailed ? "429 Too Many Requests" : undefined,
        });
      }

      const rows = await db
        .selectFrom("price_backfill")
        .select("outcome")
        .where("instrument_id", "=", instrument.id)
        .execute();

      expect(rows.map((row) => row.outcome).sort()).toEqual([...outcomes].sort());
    }),
  );

  it(
    "refuses an outcome the vocabulary does not know",
    withDatabase(async ({ seedInstrument, seedBackfillAttempt }) => {
      const instrument = await seedInstrument({ symbol: "VTI", priceSource: "feed" });

      await expect(
        seedBackfillAttempt({
          instrument,
          startedAt: LONG_AGO,
          // The cast is the point: TypeScript refuses this too, and the
          // assertion is that the constraint refuses it independently — the
          // vocabularies are kept in step by hand, and this is what notices.
          outcome: "backfilled" as BackfillOutcome,
        }),
      ).rejects.toThrow(/price_backfill_outcome_valid/);
    }),
  );

  // One `withDatabase` body per refusal: a constraint refusal aborts the
  // transaction the body runs in, so a second refusal in the same body would
  // fail on the aborted transaction rather than on the rule it states.
  it(
    "refuses a filled attempt that wrote nothing",
    withDatabase(async ({ seedInstrument, seedBackfillAttempt }) => {
      const instrument = await seedInstrument({ symbol: "VTI", priceSource: "feed" });

      await expect(
        seedBackfillAttempt({ instrument, startedAt: LONG_AGO, outcome: "filled", written: 0 }),
      ).rejects.toThrow(/price_backfill_filled_wrote/);
    }),
  );

  it(
    "refuses an attempt that wrote something and says it had nothing to write",
    withDatabase(async ({ seedInstrument, seedBackfillAttempt }) => {
      const instrument = await seedInstrument({ symbol: "VTI", priceSource: "feed" });

      await expect(
        seedBackfillAttempt({
          instrument,
          startedAt: LONG_AGO,
          outcome: "nothing_to_write",
          written: 1,
        }),
      ).rejects.toThrow(/price_backfill_filled_wrote/);
    }),
  );

  it(
    "refuses a provider failure with no text to read",
    withDatabase(async ({ seedInstrument, seedBackfillAttempt }) => {
      const instrument = await seedInstrument({ symbol: "VTI", priceSource: "feed" });

      await expect(
        seedBackfillAttempt({ instrument, startedAt: LONG_AGO, outcome: "provider_failed" }),
      ).rejects.toThrow(/price_backfill_error_reported/);
    }),
  );

  it(
    "refuses error text on an attempt that did not fail",
    withDatabase(async ({ seedInstrument, seedBackfillAttempt }) => {
      const instrument = await seedInstrument({ symbol: "VTI", priceSource: "feed" });

      await expect(
        seedBackfillAttempt({
          instrument,
          startedAt: LONG_AGO,
          outcome: "no_history",
          error: "nothing failed",
        }),
      ).rejects.toThrow(/price_backfill_error_reported/);
    }),
  );
});
