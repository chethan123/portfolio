/**
 * When the market is open, and which trading date a timestamp belongs to —
 * two jobs that look alike and are not. **`isMarketOpen` is a cost
 * optimisation** (§10: "a wrongly skipped poll costs nothing; a wrongly
 * attempted one costs one request"); nothing downstream trusts it, so a
 * stale holiday table wastes a few requests and the stored data stays
 * correct. **`marketDateOf` is a correctness mechanism**: it decides which
 * `price_daily` row a quote becomes — wrong means a real price under the
 * wrong date, permanently, in the immutable spine (§6.2). It never consults
 * the calendar; it reads the instant the provider stamped on the quote, so a
 * holiday poll returns Friday's quote carrying Friday's `regularMarketTime`
 * and rewrites Friday's row rather than inventing a holiday one. The
 * calendar can never corrupt the spine, because the spine never asks it.
 *
 * Pure and dependency-free: every function takes the instant and the zone,
 * so a test can state both.
 */

/** A calendar date as Postgres hands one back — `YYYY-MM-DD`. */
export type IsoDate = string;

/**
 * The regular NYSE session, market-local minutes from midnight: 09:30–16:00.
 * Pre- and post-market deliberately outside it — a quote struck at 07:00 is
 * not a close, and mutual funds have no intraday price at all (§6.2).
 */
const SESSION_OPENS = 9 * 60 + 30;
const SESSION_CLOSES = 16 * 60;

/**
 * NYSE full-day closures, market-local `YYYY-MM-DD`. Hardcoded *shallowly*
 * (DESIGN.md §10) — five years, not a rule engine: Good Friday moves with
 * Easter and observed dates shift around weekends, so a computed table is
 * more ways to be subtly wrong than a list checkable against nyse.com in a
 * minute. Running past the last year listed just treats holidays as
 * weekdays — ten wasted requests a year, the cheap side of §10's trade-off.
 * Half-day closures deliberately absent: polling to 16:00 on a half day
 * re-fetches an unchanged quote whose unchanged `regularMarketTime` rewrites
 * the row it already wrote.
 */
const NYSE_HOLIDAYS: ReadonlySet<IsoDate> = new Set([
  // 2026
  "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25",
  "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
  // 2027
  "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31",
  "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24",
  // 2028
  "2028-01-17", "2028-02-21", "2028-04-14", "2028-05-29", "2028-06-19",
  "2028-07-04", "2028-09-04", "2028-11-23", "2028-12-25",
  // 2029
  "2029-01-01", "2029-01-15", "2029-02-19", "2029-03-30", "2029-05-28",
  "2029-06-19", "2029-07-04", "2029-09-03", "2029-11-22", "2029-12-25",
  // 2030
  "2030-01-01", "2030-01-21", "2030-02-18", "2030-04-19", "2030-05-27",
  "2030-06-19", "2030-07-04", "2030-09-02", "2030-11-28", "2030-12-25",
]);

/**
 * The wall clock in a named zone, as parts. `Intl` rather than epoch
 * arithmetic: the UTC↔New York offset moves twice a year, and on those two
 * days an hour of the session lands on the wrong side of any fixed offset —
 * the formatter knows the rules. `en-CA` gives zero-padded ISO-ordered
 * numerics, so the date parts reassemble into `YYYY-MM-DD` without a
 * month-name table.
 */
function partsIn(instant: Date, timeZone: string): Record<string, string> {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    // `h23`, not `hour12: false` — they differ at one instant: `hour12:
    // false` formats midnight as "24" on some engines, putting the small
    // hours after the close rather than before the open. `h23` pins 00–23.
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
  });

  const parts: Record<string, string> = {};
  for (const { type, value } of formatter.formatToParts(instant)) parts[type] = value;
  return parts;
}

/**
 * The trading date an instant belongs to: the calendar date in the market's
 * own zone. The case that breaks a naive UTC date is a quote stamped after
 * 19:00 New York — the next day in UTC — filing a mutual fund's evening NAV
 * under tomorrow, where tomorrow's real close then overwrites it, losing the
 * NAV entirely.
 *
 * @param instant the moment the price was struck — `regularMarketTime`, not now.
 * @param timeZone `MARKET_TIMEZONE`; the caller passes configuration, this
 *                 module holds none.
 */
export function marketDateOf(instant: Date, timeZone: string): IsoDate {
  const parts = partsIn(instant, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/**
 * The time an instant reads on the market's own clock, `HH:MM` — what a 1D
 * chart's axis and readouts say. Market zone, not the reader's: a session is
 * 09:30–16:00 in exactly one zone, and the chart renders on the server and
 * again after hydration — a label from whichever clock happened to render it
 * would disagree with itself. Here beside the other two because this is the
 * only `app/` module that reads a wall clock.
 *
 * @param instant the moment being labelled.
 * @param timeZone `MARKET_TIMEZONE`; the caller passes configuration, this
 *                 module holds none.
 */
export function marketTimeOf(instant: Date, timeZone: string): string {
  const parts = partsIn(instant, timeZone);
  return `${parts.hour}:${parts.minute}`;
}

/**
 * The stamp an "as of" caption carries: `29 Aug 2026, 4:00 PM EDT`. Market
 * time with the zone rendered: pages must work with JavaScript off, so there
 * is no browser clock to ask at render time — and this is the zone
 * `marketDateOf` files a close under, so the caption and the row behind it
 * cannot appear to disagree. Its own formatter, not `partsIn`'s: that one is
 * pinned `h23` for minute arithmetic; this is read by a person, who wants
 * four o'clock to say four.
 */
export function marketStampOf(instant: Date, timeZone: string): string {
  const parts: Record<string, string> = {};
  for (const { type, value } of new Intl.DateTimeFormat("en-US", {
    timeZone,
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short",
  }).formatToParts(instant))
    parts[type] = value;

  return `${parts.day} ${parts.month} ${parts.year}, ${parts.hour}:${parts.minute} ${parts.dayPeriod} ${parts.timeZoneName}`;
}

/**
 * Is the regular session running at this instant? Weekend, then holiday,
 * then the 09:30–16:00 window. Only ever consulted to decide whether to
 * spend a request — nothing that writes to the database asks this question
 * (module comment).
 */
export function isMarketOpen(instant: Date, timeZone: string): boolean {
  const parts = partsIn(instant, timeZone);

  if (parts.weekday === "Sat" || parts.weekday === "Sun") return false;
  if (NYSE_HOLIDAYS.has(`${parts.year}-${parts.month}-${parts.day}`)) return false;

  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  return minutes >= SESSION_OPENS && minutes < SESSION_CLOSES;
}
