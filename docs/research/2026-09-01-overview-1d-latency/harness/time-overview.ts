/**
 * Times every query the Overview loader (`app/routes/overview.tsx`) runs, in
 * the same two waves, for each range named on the command line. Evidence for
 * the report beside this directory, not part of the application: nothing in
 * `app/`, `server/` or `tests/` imports it and nothing here runs in CI.
 *
 * Run from the repository root, against a throwaway database:
 *
 *   DATABASE_URL=postgres://portfolio:portfolio@127.0.0.1:55432/portfolio_bench \
 *     node docs/research/2026-09-01-overview-1d-latency/harness/time-overview.ts 1d 1y
 *
 * Exits 1 when any range's wall time exceeds BUDGET_MS (default 1000) — red on
 * the reported symptom, green once the session series is cheap.
 */
import { performance } from "node:perf_hooks";

import { sql } from "kysely";

import { chartReach, chartSeries, type ChartScope } from "../../../../app/lib/chart-series.server.ts";
import { chartWindow, isoDate } from "../../../../app/lib/chart-range.ts";
import { getDb } from "../../../../app/lib/db.server.ts";
import { ALL_OWNERS } from "../../../../app/lib/owner-filter.ts";
import { asOfView } from "../../../../app/lib/prices.server.ts";
import {
  accountTotals,
  manualNetWorth,
  netWorthChange,
} from "../../../../app/lib/valuation.server.ts";
import { getConfig } from "../../../../server/config.ts";

const BUDGET_MS = Number(process.env.BUDGET_MS ?? 1000);
const ranges = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ["1d", "1y"];

type Timing = { name: string; ms: number };

async function timed<T>(name: string, run: () => Promise<T>, timings: Timing[]): Promise<T> {
  const start = performance.now();
  const result = await run();
  timings.push({ name, ms: performance.now() - start });
  return result;
}

async function shape(): Promise<void> {
  const db = getDb();
  const row = await sql<{ k: string; v: string }>`
    select 'open accounts' as k, count(*)::text as v from account where closed_at is null
    union all select 'current holdings', count(*)::text from holding_valued
    union all select 'price_observation rows', count(*)::text from price_observation
    union all select 'latest session', max(market_date)::text from price_observation
    union all select 'distinct instants in latest session', count(distinct as_of)::text
      from price_observation where market_date = (select max(market_date) from price_observation)
  `.execute(db);
  for (const { k, v } of row.rows) console.log(`  ${k.padEnd(38)} ${v}`);
}

async function overview(range: string): Promise<number> {
  const timings: Timing[] = [];
  const request = new Request(`http://localhost/?range=${range}`);
  const reading = ALL_OWNERS;
  const scope: ChartScope = { surface: "household", reading };
  const today = isoDate(Date.now());

  const wallStart = performance.now();

  // Wave 1 — exactly the loader's first Promise.all.
  const [manual, reach] = await Promise.all([
    timed("manualNetWorth", () => manualNetWorth(), timings),
    timed("chartReach (firstRecordedDate + latestObservedSession)", () => chartReach(scope), timings),
  ]);

  const earliest = { positionSet: reach.positionSet, manual: manual[0]?.date };
  const { resolved } = chartWindow("household", {
    request,
    today,
    earliest,
    session: reach.session,
    timeZone: getConfig().MARKET_TIMEZONE,
  });

  // Wave 2 — the loader's second Promise.all. Its fifth entry is `null`
  // unless the owner filter is on, and this runs unfiltered.
  const [, , points] = await Promise.all([
    timed(`netWorthChange since ${resolved.since}`, () => netWorthChange(reading, resolved.since), timings),
    timed("accountTotals", () => accountTotals(reading), timings),
    timed(
      resolved.session === undefined
        ? `chartSeries dated (${resolved.dates.length} dates)`
        : `chartSeries session (${resolved.session})`,
      () => chartSeries(scope, resolved),
      timings,
    ),
    timed("asOfView", () => asOfView(getConfig().MARKET_TIMEZONE), timings),
  ]);

  const wall = performance.now() - wallStart;

  console.log(`\nrange=${range}  resolved.range=${resolved.range}  session=${resolved.session ?? "-"}  points=${points.length}`);
  for (const t of timings) console.log(`  ${t.name.padEnd(60)} ${t.ms.toFixed(0).padStart(7)} ms`);
  console.log(`  ${"loader-data bytes for the chart points".padEnd(60)} ${String(Buffer.byteLength(JSON.stringify(points))).padStart(7)}`);
  console.log(`  ${"WALL (both waves, as the loader awaits them)".padEnd(60)} ${wall.toFixed(0).padStart(7)} ms`);
  return wall;
}

async function main(): Promise<void> {
  console.log("data shape");
  await shape();

  let worst = 0;
  for (const range of ranges) worst = Math.max(worst, await overview(range));

  await getDb().destroy();

  const verdict = worst > BUDGET_MS ? "RED" : "GREEN";
  console.log(`\n${verdict}: worst wall ${worst.toFixed(0)} ms against a budget of ${BUDGET_MS} ms`);
  process.exit(verdict === "RED" ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(2);
});
