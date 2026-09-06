// Chart read seam (spec 0015): only caller of firstRecordedDate/netWorthSeries/netWorthSessionSeries.
// OwnerFilter is a required field of ChartScope so review sees whose money is read (ADR-0008).
// Two entry points because Overview also sizes its window from manualNetWorth()'s own first point.
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

// account variant carries no reading: one owner, no filter needed (ADR-0008).
export type ChartScope =
  | { surface: "household"; reading: OwnerFilter }
  | { surface: "account"; accountId: string };

export type ChartReach = { positionSet: IsoDate | null; session: IsoDate | null };

// positionSet: this surface's own earliest date (account = own first statement, not household's).
// session: latest observed instant, same value on both surfaces — read from the log as a whole,
// never filtered by surface, so an unquoted account still draws its flat line at observed instants.
export async function chartReach(scope: ChartScope): Promise<ChartReach> {
  const [positionSet, session] = await Promise.all([
    scope.surface === "household"
      ? firstRecordedDate(scope.reading)
      : accountFirstRecordedDate(scope.accountId),
    latestObservedSession(),
  ]);

  return { positionSet, session };
}

// Widen date->instant (honest, a date is just a coarse instant); never narrow instant->date (loses time-of-day).
function asSessionPoints(series: NetWorthPoint[]): SessionPoint[] {
  return series.map((point) => ({ at: point.date, amount: point.amount, coverage: point.coverage }));
}

// resolved.session undefined => dated reader, else session reader; decided once here, not per loader.
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

// Drop coverage.total===0 points: no position set yet is not a zero balance, and plotting it would
// put a fictional climb from zero at the head of every chart (ARCHITECTURE.md §6.3, DESIGN.md §7).
export async function chartSeries(scope: ChartScope, resolved: RangeWindow): Promise<ChartPoint[]> {
  const points = await readPoints(scope, resolved);

  return points
    .filter((point) => point.coverage.total > 0)
    .map((point) => ({ date: point.at, amount: point.amount }));
}
