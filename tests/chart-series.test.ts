/**
 * The chart's read seam (spec 0015) — three things nothing else in the suite
 * asserts: that the coverage rule (ARCHITECTURE.md §6.3) fires at the
 * assembly seam and not merely inside the reader beneath it, that an account
 * scope dispatches to the account reader rather than the household one, and
 * that a resolved window's own shape — dated or session — decides which
 * reader answers, rather than being read off by a caller. The narrowing
 * rules and 1D's own resolution are already tested at their own seams
 * (`valuation-owner-filter.test.ts`, `chart-range.test.ts`); that an
 * account's series prices only its own positions, at both the dated and
 * session tier, is already tested in `tests/account-queries.test.ts` — none
 * of that is restated here.
 */
import { afterAll, describe, expect, it } from "vitest";

import { chartSeries, type ChartScope } from "~/lib/chart-series.server";

import { closeTestDatabase, withDatabase } from "./support/database.ts";
import { ALL_OWNERS } from "../app/lib/owner-filter.ts";

import type { RangeWindow } from "~/lib/chart-range";

afterAll(closeTestDatabase);

/**
 * A dated window naming exactly the given calendar dates. `chartSeries`
 * reads only `dates` and `session` off a `RangeWindow`, so the rest of the
 * shape — `range`, `since` — is filler no test here needs to vary.
 */
function datedWindow(dates: string[]): RangeWindow {
  return { range: "all", since: dates[0] ?? "1970-01-01", dates };
}

/** A session window naming exactly the given session. */
function sessionWindow(session: string): RangeWindow {
  return { range: "1d", since: session, dates: [], session };
}

describe("the coverage rule, at the assembly seam rather than only inside the reader beneath it", () => {
  it(
    "drops a date before the first position set on both scopes, and keeps the reader's own amount for the date that survives",
    withDatabase(async ({ seedPerson, seedAccount, seedPositionSet, usdInstrument }) => {
      const alice = await seedPerson({ name: "Alice" });
      const usd = await usdInstrument();
      const account = await seedAccount({ name: "Alice Savings", owner: alice, kind: "bank" });

      await seedPositionSet({
        account,
        asOf: "2026-01-15",
        holdings: [{ instrument: usd, quantity: "5000.00000000" }],
      });

      const resolved = datedWindow(["2026-01-10", "2026-01-15"]);

      // "2026-01-10" is before the account's first statement — no rows, not a
      // zero (§6.3) — so only "2026-01-15" survives, on both scopes.
      expect(await chartSeries({ surface: "household", reading: ALL_OWNERS }, resolved)).toEqual([
        { date: "2026-01-15", amount: "5000.0000" },
      ]);
      expect(await chartSeries({ surface: "account", accountId: account.id }, resolved)).toEqual([
        { date: "2026-01-15", amount: "5000.0000" },
      ]);
    }),
  );
});

describe("an account scope", () => {
  it(
    "reaches the account reader, not the household one",
    withDatabase(async ({ seedPerson, seedAccount, seedPositionSet, usdInstrument }) => {
      const alice = await seedPerson({ name: "Alice" });
      const bob = await seedPerson({ name: "Bob" });
      const usd = await usdInstrument();

      const hers = await seedAccount({ name: "Alice Savings", owner: alice, kind: "bank" });
      const his = await seedAccount({ name: "Bob Savings", owner: bob, kind: "bank" });

      await seedPositionSet({
        account: hers,
        asOf: "2026-01-15",
        holdings: [{ instrument: usd, quantity: "5000.00000000" }],
      });
      await seedPositionSet({
        account: his,
        asOf: "2026-01-15",
        holdings: [{ instrument: usd, quantity: "9000.00000000" }],
      });

      // 5000, not 14000: dispatched to the household reader under
      // `ALL_OWNERS` this would sum both accounts. That an account's own
      // series prices only its own positions is already covered, at both
      // tiers, in `tests/account-queries.test.ts` ("prices each date
      // against that account's own positions", "one account's 1D series");
      // what this adds is that the assembly's own dispatch reaches that
      // reader at all, off nothing but `scope.surface`.
      expect(
        await chartSeries({ surface: "account", accountId: hers.id }, datedWindow(["2026-01-15"])),
      ).toEqual([{ date: "2026-01-15", amount: "5000.0000" }]);
    }),
  );
});

describe("the window decides the reader", () => {
  it(
    "reads the dated tier off a dated window and the session tier off a session window, for the same account on the same day",
    withDatabase(
      async ({ seedPerson, seedAccount, seedInstrument, seedPositionSet, seedDailyClose, seedObservation }) => {
        const alice = await seedPerson({ name: "Alice" });
        const vti = await seedInstrument({ symbol: "VTI", name: "VTI" });
        const account = await seedAccount({ name: "Alice Brokerage", owner: alice });

        await seedPositionSet({
          account,
          asOf: "2026-06-04",
          holdings: [{ instrument: vti, quantity: "10.00000000" }],
        });

        // The two tiers disagree on purpose: the finished day's close carries
        // forward at $100 (`holding_valued_at`), and the session observed a
        // different price entirely (`readSessionSeries`) — so the dated and
        // session readers would answer differently if either were asked the
        // other's question, and only the window says which is being asked.
        await seedDailyClose({ instrument: vti, date: "2026-06-04", close: "100.0000" });
        await seedObservation({ instrument: vti, asOf: "2026-06-05T13:30:00Z", price: "150.0000" });

        const scope: ChartScope = { surface: "account", accountId: account.id };

        expect(await chartSeries(scope, datedWindow(["2026-06-05"]))).toEqual([
          { date: "2026-06-05", amount: "1000.0000" },
        ]);
        expect(await chartSeries(scope, sessionWindow("2026-06-05"))).toEqual([
          { date: "2026-06-05T13:30:00.000Z", amount: "1500.0000" },
        ]);
      },
    ),
  );
});
