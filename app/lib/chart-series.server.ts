/**
 * The chart's read seam (spec 0015) — the two entry points every chart
 * surface's assembly needs, and the only module that calls
 * `firstRecordedDate`, `netWorthSeries` and `netWorthSessionSeries` on a
 * chart's behalf. `.server.ts` because it reads the database; nothing
 * browser-reachable may value-import it.
 *
 * `ChartScope` is the one value that says which surface is being read *and*
 * what narrows it. The owner filter travels as a required field of a
 * required argument — `chartSeries({ surface: "household", reading },
 * resolved)` names it at the call site, and TypeScript refuses the call
 * without it — so whose money this module reads stays visible in review
 * (ADR-0008), the same property the filter had as a bare argument before
 * three household-scoped reads — `firstRecordedDate`, `netWorthSeries` and
 * `netWorthSessionSeries` — moved from the loader to here. "One module
 * values holdings" is untouched: this module compares cardinalities and
 * values nothing.
 *
 * Two entry points, not one, because the Overview cannot size its window
 * without `manualNetWorth()`'s own first point — a fact this module does not
 * read — so the loader must hold both `manual` and `chartReach(scope)`
 * before either can size a window (`overview.tsx`'s loader spells the
 * `Promise.all` this forces).
 */
import {
  accountFirstRecordedDate,
  accountSeries,
  accountSessionSeries,
  firstRecordedDate,
  latestObservedSession,
  netWorthSeries,
  netWorthSessionSeries,
} from "./valuation.server.ts";

import type { ChartPoint, RangeWindow } from "./chart-range.ts";
import type { OwnerFilter } from "./owner-filter.ts";
import type { IsoDate, NetWorthPoint, SessionPoint } from "./valuation.server.ts";

/**
 * Which surface is being read, and what narrows it — the one value
 * `chartReach` and `chartSeries` take. The account variant carries no
 * `reading`: an account has exactly one owner and takes no filter
 * (ADR-0008).
 */
export type ChartScope =
  | { surface: "household"; reading: OwnerFilter }
  | { surface: "account"; accountId: string };

/** What {@link chartReach} answers — see its own docstring for each field. */
export type ChartReach = { positionSet: IsoDate | null; session: IsoDate | null };

/**
 * How far this surface's chart can reach, in one round trip: how far back —
 * the surface's own earliest recorded date, an account measuring from its
 * own first statement, never the household's, the same rule
 * `surfaceEarliestDate` states for "All" — and whether it can reach into a
 * session at all, from the observation log's own latest instant. `session`
 * takes no filter and is the same value on both surfaces: an account holding
 * nothing the feed quotes still draws its flat line at the household's
 * observed instants (`readSessionSeries`, `valuation.server.ts`, takes its
 * instants from the log as a whole, never from the surface).
 */
export async function chartReach(scope: ChartScope): Promise<ChartReach> {
  const [positionSet, session] = await Promise.all([
    scope.surface === "household"
      ? firstRecordedDate(scope.reading)
      : accountFirstRecordedDate(scope.accountId),
    latestObservedSession(),
  ]);

  return { positionSet, session };
}

/**
 * A day-granularity series in the session shape: two readers, one chart
 * contract. The direction is deliberate — widening a date into the instant
 * field is honest (a date names a moment, coarsely), where narrowing an
 * instant would throw away the time of day the session line exists for.
 */
function asSessionPoints(series: NetWorthPoint[]): SessionPoint[] {
  return series.map((point) => ({ at: point.date, amount: point.amount, coverage: point.coverage }));
}

/**
 * The 2×2 table a resolved window and a scope together decide: household or
 * account, dated or session. `resolved.session === undefined` is what says
 * which reader a window implies — decided once, here, rather than inferred
 * from it by each loader in turn.
 */
async function readPoints(scope: ChartScope, resolved: RangeWindow): Promise<SessionPoint[]> {
  if (scope.surface === "household") {
    return resolved.session === undefined
      ? netWorthSeries(scope.reading, resolved.dates).then(asSessionPoints)
      : netWorthSessionSeries(scope.reading, resolved.session);
  }

  return resolved.session === undefined
    ? accountSeries(scope.accountId, resolved.dates).then(asSessionPoints)
    : accountSessionSeries(scope.accountId, resolved.session);
}

/**
 * Plottable points for one surface's window — the coverage rule stated once
 * (ARCHITECTURE.md §6.3): "An account with no position set at or before a
 * date contributes **no rows** — not a zero." A date before the first
 * upload sums to `0.0000` over zero rows, which is "nothing was recorded
 * yet", not "there was nothing" — drawing it would put a fictional climb out
 * of zero at the head of every chart (DESIGN.md §7), so callers read
 * `coverage.total` rather than the amount to decide where a line begins.
 * `at` is renamed to `date` here — the one place a `SessionPoint` becomes
 * the `ChartPoint` the component reads.
 */
export async function chartSeries(scope: ChartScope, resolved: RangeWindow): Promise<ChartPoint[]> {
  const points = await readPoints(scope, resolved);

  return points
    .filter((point) => point.coverage.total > 0)
    .map((point) => ({ date: point.at, amount: point.amount }));
}
