/**
 * `isMarketOpen` and `isScheduledQuoteWindow` (the poller's own gate, padded ±15 minutes around the
 * session, §6.2) are both a cost optimisation (§10): nothing downstream trusts either, so a stale
 * holiday table only wastes requests. `marketDateOf` is correctness — it decides which `price_daily`
 * row a quote becomes (§6.2) — and never consults the calendar; it reads the provider's own stamp.
 */

/** A calendar date as Postgres hands one back — `YYYY-MM-DD`. */
export type IsoDate = string;

// Regular NYSE session, market-local minutes from midnight. Pre/post-market excluded (§6.2).
const SESSION_OPENS = 9 * 60 + 30;
const SESSION_CLOSES = 16 * 60;
const QUOTE_WINDOW_PADDING_MINUTES = 15;

/**
 * NYSE full-day closures, market-local. Hardcoded five years (DESIGN.md §10); past the last year
 * listed, holidays count as weekdays — wasted requests, nothing wrong. Half-days omitted: the
 * extra poll re-fetches an unchanged quote and rewrites its row with the same values.
 */
const NYSE_HOLIDAYS: ReadonlySet<IsoDate> = new Set([
  "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25",
  "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
  "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31",
  "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24",
  "2028-01-17", "2028-02-21", "2028-04-14", "2028-05-29", "2028-06-19",
  "2028-07-04", "2028-09-04", "2028-11-23", "2028-12-25",
  "2029-01-01", "2029-01-15", "2029-02-19", "2029-03-30", "2029-05-28",
  "2029-06-19", "2029-07-04", "2029-09-03", "2029-11-22", "2029-12-25",
  "2030-01-01", "2030-01-21", "2030-02-18", "2030-04-19", "2030-05-27",
  "2030-06-19", "2030-07-04", "2030-09-02", "2030-11-28", "2030-12-25",
]);

/**
 * Wall clock in a named zone, as parts. `Intl`, not epoch arithmetic: the offset moves twice a
 * year. `en-CA` gives zero-padded ISO-ordered numerics, so the parts reassemble as `YYYY-MM-DD`.
 */
function partsIn(instant: Date, timeZone: string): Record<string, string> {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    // `h23`, not `hour12: false` — that formats midnight as "24" on some engines.
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
 * Trading date in the market's own zone; pass `regularMarketTime`, not now. A naive UTC date breaks
 * here: a quote stamped after 19:00 New York is already tomorrow in UTC, filing an evening NAV a day late.
 */
export function marketDateOf(instant: Date, timeZone: string): IsoDate {
  const parts = partsIn(instant, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** `HH:MM` on the market clock, not the reader's — server render and hydration must agree. */
export function marketTimeOf(instant: Date, timeZone: string): string {
  const parts = partsIn(instant, timeZone);
  return `${parts.hour}:${parts.minute}`;
}

/** "29 Aug 2026, 4:00 PM EDT". Own formatter: `partsIn` is pinned `h23` for minute arithmetic. */
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

function sessionMinute(instant: Date, timeZone: string): number | null {
  const parts = partsIn(instant, timeZone);

  if (parts.weekday === "Sat" || parts.weekday === "Sun") return null;
  if (NYSE_HOLIDAYS.has(`${parts.year}-${parts.month}-${parts.day}`)) return null;

  return Number(parts.hour) * 60 + Number(parts.minute);
}

export function isMarketOpen(instant: Date, timeZone: string): boolean {
  const minutes = sessionMinute(instant, timeZone);
  return minutes !== null && minutes >= SESSION_OPENS && minutes < SESSION_CLOSES;
}

/** Pads the regular session to recover the prior close before open and a delayed close after it. */
export function isScheduledQuoteWindow(instant: Date, timeZone: string): boolean {
  const minutes = sessionMinute(instant, timeZone);
  return (
    minutes !== null &&
    minutes >= SESSION_OPENS - QUOTE_WINDOW_PADDING_MINUTES &&
    minutes <= SESSION_CLOSES + QUOTE_WINDOW_PADDING_MINUTES
  );
}
