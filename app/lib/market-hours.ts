/**
 * When the market is open, and which trading date a timestamp belongs to.
 *
 * Two jobs that look alike and are not, and the distinction is the whole
 * reason this module is worth reading:
 *
 * **`isMarketOpen` is a cost optimisation.** DESIGN.md §10 is explicit that "a
 * wrongly skipped poll costs nothing; a wrongly attempted one costs one
 * request". Nothing downstream trusts it. If the holiday table below goes out
 * of date, the poller wastes a handful of requests on Good Friday and the
 * stored data is still correct.
 *
 * **`marketDateOf` is a correctness mechanism.** It decides which `price_daily`
 * row a quote becomes, and getting it wrong writes a real price under the wrong
 * date — a permanent error in the immutable spine (§6.2). It never consults the
 * calendar; it reads the instant the provider itself stamped on the quote.
 *
 * That split is deliberate. A holiday poll returns Friday's quote carrying
 * Friday's `regularMarketTime`, so it rewrites Friday's row rather than
 * inventing a holiday one, and §6.2's "non-trading days get no `price_daily`
 * row" holds even if this table is wrong. The calendar can never corrupt the
 * spine, because the spine does not ask it anything.
 *
 * Pure and dependency-free: no database, no configuration, no clock of its own.
 * Every function takes the instant and the zone, so a test can state both.
 */

/** A calendar date as Postgres hands one back — `YYYY-MM-DD`. */
export type IsoDate = string;

/**
 * The regular NYSE session, in market-local minutes from midnight.
 *
 * 09:30 to 16:00. Pre- and post-market are deliberately outside it: a quote
 * struck at 07:00 is not a close, and mutual funds — the larger part of a
 * workplace plan — have no intraday price at all (§6.2).
 */
const SESSION_OPENS = 9 * 60 + 30;
const SESSION_CLOSES = 16 * 60;

/**
 * NYSE full-day closures, as market-local `YYYY-MM-DD`.
 *
 * Hardcoded, per DESIGN.md §10, and hardcoded *shallowly* — five years, not a
 * rule engine. Good Friday moves with Easter and the observed dates shift
 * around weekends, so a computed table would be more code and more ways to be
 * subtly wrong than a list somebody can check against nyse.com in a minute.
 *
 * Running past the last year listed is not a failure. `isMarketOpen` then
 * treats holidays as ordinary weekdays and the poller spends ten wasted
 * requests a year, which is the cheaper side of §10's trade-off.
 *
 * Half-day closures (1pm on the day after Thanksgiving, and some Christmas
 * Eves) are deliberately absent. Polling until 16:00 on a half day costs a few
 * requests that return an unchanged quote, and an unchanged quote carries an
 * unchanged `regularMarketTime`, so it rewrites the row it already wrote.
 * Modelling them would buy nothing but a second thing to keep current.
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
 * The wall clock in a named zone, as parts.
 *
 * `Intl` rather than arithmetic on the epoch, because the offset between UTC
 * and `America/New_York` is not a constant — it moves twice a year, and on the
 * two days it moves, an hour of the session would land on the wrong side of any
 * fixed offset. The formatter knows the rules; nothing here should try to.
 *
 * `en-CA` gives zero-padded ISO-ordered numerics, so the date parts reassemble
 * into `YYYY-MM-DD` without a lookup table of month names.
 */
function partsIn(instant: Date, timeZone: string): Record<string, string> {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    // `h23`, not `hour12: false`. They differ at exactly one instant: with
    // `hour12: false` alone, midnight formats as "24" on some engines, and
    // 24 * 60 would put the small hours after the close rather than before the
    // open. `h23` pins it to 00–23.
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
 * The trading date an instant belongs to, as the market reckons it.
 *
 * Simply the calendar date in the market's own zone. A New York close at 16:00
 * on the 5th is 21:00 UTC on the 5th, but in December it is the 5th at 21:00
 * and in June the 5th at 20:00 — and a naive UTC date would still say the 5th.
 * The case that breaks a UTC reading is the provider stamping a quote after
 * 19:00 New York time, which is the next day in UTC: a mutual fund NAV struck
 * in the evening would file itself under tomorrow, and tomorrow's row would
 * then be overwritten by tomorrow's real close, losing the NAV entirely.
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
 * The wall-clock time an instant reads as on the market's own clock, `HH:MM`.
 *
 * What a 1D chart's axis and readouts say. The market's zone rather than the
 * reader's, for two reasons: a session is 09:30 to 16:00 in exactly one zone,
 * and the chart is rendered on the server and again in the browser after
 * hydration — a label derived from whichever clock happened to render it would
 * disagree with itself between the two.
 *
 * Formatting rather than computing, so it belongs beside the other two: this is
 * the only module in `app/` that uses `Intl`, and one place that knows how to
 * read a wall clock is the point.
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
 * Is the regular session running at this instant?
 *
 * Weekend, then holiday, then the 09:30–16:00 window — cheapest test first,
 * though at one call every fifteen minutes that ordering is for the reader
 * rather than the CPU.
 *
 * Only ever consulted to decide whether to spend a request. Nothing that writes
 * to the database asks this question; see the module comment.
 */
export function isMarketOpen(instant: Date, timeZone: string): boolean {
  const parts = partsIn(instant, timeZone);

  if (parts.weekday === "Sat" || parts.weekday === "Sun") return false;
  if (NYSE_HOLIDAYS.has(`${parts.year}-${parts.month}-${parts.day}`)) return false;

  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  return minutes >= SESSION_OPENS && minutes < SESSION_CLOSES;
}
