// Chart time vocabulary (spec 0015): range, resolution, cookie (spec 0008), sampler density
// (spec 0009/ADR-0003), and the window/points/axis a range resolves to. Not .server — both
// routes' components read this again after hydration; no database.
import { readCookie } from "./cookies.ts";
import type { IsoDate } from "./valuation.server.ts";

export type RangeKey = "1d" | "1w" | "1m" | "3m" | "ytd" | "1y" | "5y" | "all" | "custom";

// Identical key for key on Overview and the account page, so a bookmark from one works on
// the other. 1D is the one preset that isn't a span of dates (ADR-0006) — it names the most
// recent trading session and resolves to instants, not days.
export const RANGES: Record<RangeKey, { label: string }> = {
  "1d": { label: "1D" },
  "1w": { label: "1W" },
  "1m": { label: "1M" },
  "3m": { label: "3M" },
  ytd: { label: "YTD" },
  "1y": { label: "1Y" },
  "5y": { label: "5Y" },
  all: { label: "All" },
  custom: { label: "Custom" },
};

export const DEFAULT_RANGE = "1y" as const satisfies RangeKey;

// Most dates a chart checks for one range (spec 0009, issue #74). A span fitting the budget
// samples every calendar day; wider spans get exactly this many, decaying geometrically
// backward from `until`.
export const SAMPLE_BUDGET = 180;

const DAY_MS = 86_400_000;

export type Surface = "household" | "account";

// manual is read only for the household — hand-typed pre-app history was never any one
// account's (CONTEXT.md).
export interface SurfaceEarliest {
  positionSet: IsoDate | null;
  manual?: IsoDate | null;
}

export interface CustomSpan {
  start: IsoDate;
  end: IsoDate;
}

interface Window {
  since: IsoDate;
  dates: IsoDate[];
}

// The effective selection, not necessarily the one asked for: an unusable custom span
// reports as the default preset it fell back to.
export interface RangeWindow extends Window {
  range: RangeKey;
  custom?: CustomSpan;
  // Present only when 1D actually resolved — its presence, not a separate flag, is what
  // tells a loader to read the intra-session series.
  session?: IsoDate;
}

export type ChartPoint = {
  // A calendar date YYYY-MM-DD for every preset but 1D, or a full ISO instant when the
  // window carries a session. How it's labelled is SessionAxis's job, never inferred here.
  date: string;
  amount: string;
};

// What a chart is told about the session it's drawing, or null when drawing days.
export type SessionAxis = {
  timeZone: string; // MARKET_TIMEZONE; a session is 09:30-16:00 in exactly one zone
};

// null (looked, found nothing) and undefined (not passed) both mean "no session" to 1D.
const hasSession = (session?: IsoDate | null): session is IsoDate =>
  session !== undefined && session !== null;

// UTC throughout, deliberately — cannot pick up a server's local zone.
export const isoDate = (ms: number): IsoDate => new Date(ms).toISOString().slice(0, 10);

const parseIso = (date: IsoDate): number => Date.parse(`${date}T00:00:00Z`);

export function addDays(date: IsoDate, days: number): IsoDate {
  return isoDate(parseIso(date) + days * DAY_MS);
}

// Calendar-month arithmetic, not a fixed day count: 1M/3M/1Y/5Y are trailing calendar spans
// back to the same day-of-month. setUTCMonth's month-end rollover (not clamping) is accepted as-is.
function subtractMonths(date: IsoDate, months: number): IsoDate {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString().slice(0, 10);
}

const startOfYear = (date: IsoDate): IsoDate => `${date.slice(0, 4)}-01-01`;

// Excludes "all"/"custom" (need the surface's earliest date) and "1d" (needs the latest
// session) — the compiler then demands a branch for each below instead of a silent fallthrough.
const FIXED_BOUNDARY: Record<Exclude<RangeKey, "1d" | "all" | "custom">, (today: IsoDate) => IsoDate> = {
  "1w": (today) => addDays(today, -7),
  "1m": (today) => subtractMonths(today, 1),
  "3m": (today) => subtractMonths(today, 3),
  ytd: (today) => startOfYear(today),
  "1y": (today) => subtractMonths(today, 12),
  "5y": (today) => subtractMonths(today, 60),
};

// Household: earlier of position-set and manual dates (manual reaches furthest back).
// Account: its own position-set date only — manual history is the household's, not any account's.
export function surfaceEarliestDate(surface: Surface, earliest: SurfaceEarliest): IsoDate | null {
  if (surface === "account") return earliest.positionSet;

  return (
    [earliest.positionSet, earliest.manual ?? null]
      .filter((date): date is IsoDate => date !== null)
      .sort()[0] ?? null
  );
}

// Solves r > 1 in 1 + r + ... + r^(n-1) = target by bisection (ADR-0003): the sum is
// continuous and strictly increasing in r, and callers only ask for target > n.
function solveGrowthRatio(n: number, target: number): number {
  const sumAt = (r: number): number => {
    let sum = 0;
    let term = 1;
    for (let i = 0; i < n; i++) {
      sum += term;
      term *= r;
    }
    return sum;
  };

  // At the shipped budget this loop never runs (179 terms already sum past 1e53); kept for
  // correctness if SAMPLE_BUDGET is retuned far downward.
  let low = 1;
  let high = 2;
  while (sumAt(high) < target) high *= 2;

  // 1e-9: tight enough every downstream day-offset rounds stably.
  while (high - low > 1e-9) {
    const mid = (low + high) / 2;
    if (sumAt(mid) < target) low = mid;
    else high = mid;
  }

  return (low + high) / 2;
}

// Every calendar day when the span fits the budget; otherwise exactly SAMPLE_BUDGET dates
// decaying geometrically backward from `until`, never the wall clock (spec 0009, ADR-0003).
function sampleWindow(since: IsoDate, until: IsoDate): Window {
  const start = parseIso(since);
  const end = parseIso(until);
  const spanDays = Math.round((end - start) / DAY_MS);

  if (spanDays + 1 <= SAMPLE_BUDGET) {
    const dates = Array.from({ length: spanDays + 1 }, (_, index) => addDays(since, index));
    return { since, dates };
  }

  // SAMPLE_BUDGET - 1 gap terms, first fixed at one day, solved to sum exactly to the span.
  const ratio = solveGrowthRatio(SAMPLE_BUDGET - 1, spanDays);

  // Cumulative day-offsets from `until`, nearest first; last equals spanDays by construction.
  const offsets: number[] = [0];
  let offset = 0;
  let gap = 1;
  for (let k = 1; k < SAMPLE_BUDGET; k++) {
    offset += gap;
    offsets.push(offset);
    gap *= ratio;
  }

  // Built nearest-to-until first; reversed into the oldest-first order callers expect.
  const dates = offsets.map((offset) => addDays(until, -Math.round(offset))).reverse();

  return { since, dates };
}

// Refused rather than drawn from a clamp: both ends set, in order, within what the surface can show.
function isDrawableCustomSpan(span: CustomSpan, today: IsoDate, earliest: IsoDate | null): boolean {
  if (span.start > span.end) return false;
  if (span.end > today) return false;
  if (earliest !== null && span.start < earliest) return false;
  return true;
}

// "all"/"custom" need the surface's earliest date rather than a calendar offset; an unusable
// custom span falls back to the default rather than erroring.
export function resolveRange(
  range: RangeKey,
  opts: {
    today: IsoDate;
    earliest: SurfaceEarliest;
    surface: Surface;
    custom?: CustomSpan;
    session?: IsoDate | null; // from latestObservedSession; omitted disables 1D
  },
): RangeWindow {
  const earliestDate = surfaceEarliestDate(opts.surface, opts.earliest);

  if (range === "1d") {
    if (!hasSession(opts.session)) return resolveRange(DEFAULT_RANGE, opts);

    // dates empty on purpose: 1D bypasses the day sampler, plotting the log's own instants.
    // since is the day before the session, not the session's own date — today's price_daily
    // row converges on the last observation, so measuring from it would report a flat session;
    // this is the previous close, "today's change" as a brokerage means it. Known gap
    // (DESIGN.md §14): the change reader compares today's positions against since, while the
    // 1D line holds today's positions constant, so a mid-session upload can disagree with the line.
    return { range, session: opts.session, since: addDays(opts.session, -1), dates: [] };
  }

  if (range === "custom") {
    if (opts.custom && isDrawableCustomSpan(opts.custom, opts.today, earliestDate)) {
      return { range, custom: opts.custom, ...sampleWindow(opts.custom.start, opts.custom.end) };
    }
    return resolveRange(DEFAULT_RANGE, opts);
  }

  if (range === "all") {
    return { range, ...sampleWindow(earliestDate ?? FIXED_BOUNDARY[DEFAULT_RANGE](opts.today), opts.today) };
  }

  return { range, ...sampleWindow(FIXED_BOUNDARY[range](opts.today), opts.today) };
}

// A preset landing exactly on the surface's earliest date is not disabled — that day is a
// real, drawable start. "All"/"Custom" are never disabled.
export function isRangeDisabled(
  range: RangeKey,
  opts: {
    today: IsoDate;
    earliest: SurfaceEarliest;
    surface: Surface;
    session?: IsoDate | null; // see resolveRange; omitted means nothing observed yet
  },
): boolean {
  if (range === "1d") return !hasSession(opts.session);

  if (range === "all" || range === "custom") return false;

  const earliestDate = surfaceEarliestDate(opts.surface, opts.earliest);
  if (earliestDate === null) return false;

  return FIXED_BOUNDARY[range](opts.today) < earliestDate;
}

// The clause a chart's accessible label names the active range with (story 24).
export function rangeDescription(range: RangeKey, custom?: CustomSpan): string {
  if (range === "custom" && custom) return `from ${custom.start} to ${custom.end}`;
  if (range === "1d") return "over the latest trading session";
  return `over the last ${RANGES[range].label}`;
}

export function rangeOptions(opts: {
  today: IsoDate;
  earliest: SurfaceEarliest;
  surface: Surface;
  session?: IsoDate | null;
}): Array<{ key: RangeKey; label: string; disabled: boolean }> {
  return (Object.keys(RANGES) as RangeKey[]).map((key) => ({
    key,
    label: RANGES[key].label,
    disabled: isRangeDisabled(key, opts),
  }));
}

/**
 * The `min` a custom date input carries for this surface. Distinct from
 * `earliestRecordableDate` (`input.server.ts`): that is a floor on writes;
 * this is the earliest date *this surface* has — a floor on reads, the same
 * date "All" and the disabled rule measure against.
 */
export function customRangeMin(surface: Surface, earliest: SurfaceEarliest): IsoDate | null {
  return surfaceEarliestDate(surface, earliest);
}

/** Distinct from `MASKING_COOKIE` so the two cannot be confused in a header. */
export const RANGE_COOKIE = "chart_range";

/**
 * A year, unconditional — unlike masking's policy-dependent lifetime, this is
 * a convenience with nothing to protect by forgetting itself.
 */
const RANGE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/**
 * A fixed preset by its key, or a custom span as both dates — one format, so
 * the reader has exactly one thing to parse.
 */
export function encodeRangeCookieValue(range: RangeKey, custom?: CustomSpan): string {
  if (range === "custom" && custom) return `custom:${custom.start}:${custom.end}`;
  return range;
}

/** The `Set-Cookie` value for a browser that just chose (or was defaulted to) a range. */
export function rangeCookie(value: string): string {
  return `${RANGE_COOKIE}=${encodeURIComponent(value)}; Path=/; SameSite=Lax; Max-Age=${RANGE_COOKIE_MAX_AGE}`;
}

/**
 * What a stored cookie value decodes to, or null when it names no range this
 * control offers — the `Object.hasOwn` guard's refusal, not a guess.
 */
export function decodeRangeCookieValue(
  value: string,
): { range: RangeKey; custom?: CustomSpan } | null {
  if (Object.hasOwn(RANGES, value) && value !== "custom") {
    return { range: value as RangeKey };
  }

  const [key, start, end] = value.split(":");
  if (key === "custom" && start && end) return { range: "custom", custom: { start, end } };

  return null;
}

/**
 * What this browser last chose, or undefined. Matched on the whole cookie
 * name through `cookies.ts`'s shared `readCookie` — this file used to
 * hand-roll the same loop a second time, which is exactly the drift that
 * module's header exists to stop — decoding the one thing `readCookie`
 * deliberately leaves alone: the value.
 */
export function readRangeCookie(request: Request): string | undefined {
  const value = readCookie(request, RANGE_COOKIE);
  return value === undefined ? undefined : decodeURIComponent(value);
}

/** What a request asked for, and whether it asked explicitly. */
export interface RequestedRange {
  range: RangeKey;
  custom?: CustomSpan;
  /**
   * Whether the URL itself named a range — the one flag a loader needs to
   * decide whether to write the cookie: an explicit `?range=` wins and is
   * written back; absent, the cookie; absent both, {@link DEFAULT_RANGE} with
   * nothing written, so a browser that never chose does not have a choice
   * invented for it.
   */
  explicit: boolean;
}

/**
 * The one place both routes read `?range=` (and `?start=`/`?end=`) against
 * the cookie, so the precedence — URL, cookie, default — is written once.
 * `Object.hasOwn`, not `in`: `in` walks the prototype chain, and a
 * hand-edited `?range=toString` must fall through rather than match
 * `RANGES.toString`.
 */
export function readChartRange(request: Request): RequestedRange {
  const params = new URL(request.url).searchParams;
  const requested = params.get("range");

  if (requested !== null && Object.hasOwn(RANGES, requested)) {
    const range = requested as RangeKey;
    if (range !== "custom") return { range, explicit: true };

    const start = params.get("start");
    const end = params.get("end");
    return { range, custom: start && end ? { start, end } : undefined, explicit: true };
  }

  const cookie = readRangeCookie(request);
  const decoded = cookie === undefined ? null : decodeRangeCookieValue(cookie);
  if (decoded !== null) return { ...decoded, explicit: false };

  return { range: DEFAULT_RANGE, explicit: false };
}

/**
 * The payload block a loader spreads into its return — the same six keys,
 * names and values both routes used to assemble by hand before spec 0015:
 * `custom` still `undefined` off a resolved range that is not custom,
 * `customMax` still the `today` the caller passed in. Every field but those
 * two is derived from a type this file already declares rather than
 * restated by hand: `range` and `custom` from `RangeWindow`, `customMin`
 * from `customRangeMin`'s own return type, and `rangeOptions` from
 * {@link rangeOptions}'s — so none of the four can drift from what actually
 * produces them.
 */
export type ChartControls = Pick<RangeWindow, "range"> & {
  /**
   * Required, not optional — `undefined` off a resolved range that is not
   * custom is a value this key always carries, never a key a caller can omit
   * (route tests assert `toBeUndefined()`, not the key's absence).
   */
  custom: RangeWindow["custom"];
  /**
   * Null on every range but 1D, which is how the chart is told which axis it
   * is drawing (§7). The zone travels in, never read from configuration
   * here — see {@link chartWindow}.
   */
  session: SessionAxis | null;
  rangeOptions: ReturnType<typeof rangeOptions>;
  customMin: ReturnType<typeof customRangeMin>;
  customMax: IsoDate;
};

/**
 * The window a surface's chart draws, and the control block a loader spreads
 * into its return — composed entirely from what this file already has, so
 * the pipeline downstream of a resolved range has one home rather than two
 * (spec 0015). Pure, like the rest of this module: the market time zone
 * arrives as `opts.timeZone` rather than read off configuration, which is
 * what keeps this file database-free and both loaders spell
 * `getConfig().MARKET_TIMEZONE` already, for `asOfView`.
 *
 * Takes `Surface`, not `ChartScope` (`chart-series.server.ts`): this reads
 * nothing, so it narrows nothing, and a required `reading` here would claim
 * a narrowing that never happens — the signature saying more than the code
 * does, which is worth less than saying nothing. `resolved` is returned
 * rather than folded away because both loaders still need it — the Overview
 * reads `resolved.since` for `netWorthChange` and bounds its hand-typed
 * prefix by it, and `resolved.session` decides whether that prefix is drawn
 * at all.
 */
export function chartWindow(
  surface: Surface,
  opts: {
    request: Request;
    today: IsoDate;
    earliest: SurfaceEarliest;
    /** From `latestObservedSession`. See {@link resolveRange}. */
    session: IsoDate | null;
    timeZone: string;
  },
): { resolved: RangeWindow; controls: ChartControls } {
  const { request, today, earliest, session, timeZone } = opts;
  const requested = readChartRange(request);

  const resolved = resolveRange(requested.range, {
    today,
    earliest,
    surface,
    custom: requested.custom,
    session,
  });

  return {
    resolved,
    controls: {
      range: resolved.range,
      custom: resolved.custom,
      session: resolved.session === undefined ? null : { timeZone },
      rangeOptions: rangeOptions({ today, earliest, surface, session }),
      customMin: customRangeMin(surface, earliest),
      customMax: today,
    },
  };
}

/**
 * The three parameters this control owns; everything else in the address
 * belongs to the screen and is carried through untouched. Here rather than in
 * the component because these are exactly what {@link readChartRange} reads
 * back, and a vocabulary's read and write sides drift in different files.
 */
const RANGE_PARAMS = ["range", "start", "end"];

/**
 * What a preset link and the Custom form have to re-emit — the address
 * stripped of this control's own vocabulary, in the order it already had.
 */
export function carriedParams(params: URLSearchParams): [string, string][] {
  return [...params].filter(([name]) => !RANGE_PARAMS.includes(name));
}

/**
 * The search string a preset points at: the rest of the query plus its own
 * `?range=` — the emit side of {@link readChartRange}, here for
 * `parseQuery`/`toSearch`'s reason. A whole search string, not React Router's
 * relative resolution: a `to` beginning with `?` replaces the *entire* query,
 * which is what silently dropped the `?uploaded=` receipt when a range was
 * picked. `start`/`end` are dropped, not carried — a preset never reads them,
 * and an address advertising a span nothing draws is worse than none.
 *
 * `next` is plain `URLSearchParams` output, unedited: `toOwnerParam`
 * (`owner-filter.ts`) now spells the owner parameter the same way
 * `URLSearchParams` itself would, so nothing here needs un-encoding.
 */
export function rangeSearch(params: URLSearchParams, range: RangeKey): string {
  const next = new URLSearchParams(carriedParams(params));
  next.set("range", range);

  return `?${next.toString()}`;
}

/**
 * Remembers an explicit range choice in the cookie (spec 0008). A middleware,
 * not a header on the loader's return: both routes' tests call their loader
 * directly and read fields off the plain object, and wrapping in
 * `data(value, { headers })` only sometimes would make the result type a
 * union those tests never asked for. A middleware wraps the *response*,
 * leaving each loader one shape always; one factory so the two routes cannot
 * drift the way the range logic used to.
 *
 * What is remembered is the request's own `?range=`, not a database-resolved
 * effective value (spec 0008's wording; a middleware never sees what the
 * loader returned). An explicit but undrawable custom span persists as asked
 * and re-falls-back identically on every read — {@link resolveRange} applies
 * the same rule every time.
 */
export function chartRangeMiddleware() {
  // Untyped against react-router's `MiddlewareFunction`, deliberately: it and
  // the routes' generated `Route.MiddlewareFunction` disagree on `next`'s
  // return type and are not mutually assignable. Loose typing satisfies both
  // generated types structurally (the reason `args()` in tests/support casts).
  return async ({ request }: { request: Request }, next: () => Promise<unknown>): Promise<Response> => {
    const response = (await next()) as Response;
    const requested = readChartRange(request);

    // Not onto a redirect: since spec 0013 a loader may bounce to a canonical
    // address, and a cookie on a response that is not the page is a header
    // nobody reads. Every redirect lands somewhere this middleware also runs,
    // so it is written for the page actually drawn. (A client-side navigation
    // carries a redirect as a single-fetch 202, not a 3xx — harmless: the
    // followed request writes the same value a moment later.)
    const redirecting = response.status >= 300 && response.status < 400;

    if (requested.explicit && !redirecting) {
      response.headers.append(
        "Set-Cookie",
        rangeCookie(encodeRangeCookieValue(requested.range, requested.custom)),
      );
    }

    return response;
  };
}
