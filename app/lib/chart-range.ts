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

// Distinct from earliestRecordableDate (input.server.ts): that's a floor on writes, this a
// floor on reads — the same date "All" and the disabled rule measure against.
export function customRangeMin(surface: Surface, earliest: SurfaceEarliest): IsoDate | null {
  return surfaceEarliestDate(surface, earliest);
}

export const RANGE_COOKIE = "chart_range";

// A year, unconditional — unlike masking's policy-dependent lifetime, this has nothing to
// protect by forgetting itself.
const RANGE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export function encodeRangeCookieValue(range: RangeKey, custom?: CustomSpan): string {
  if (range === "custom" && custom) return `custom:${custom.start}:${custom.end}`;
  return range;
}

export function rangeCookie(value: string): string {
  return `${RANGE_COOKIE}=${encodeURIComponent(value)}; Path=/; SameSite=Lax; Max-Age=${RANGE_COOKIE_MAX_AGE}`;
}

// null when the value names no range this control offers, rather than a guess.
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

export function readRangeCookie(request: Request): string | undefined {
  const value = readCookie(request, RANGE_COOKIE);
  return value === undefined ? undefined : decodeURIComponent(value);
}

export interface RequestedRange {
  range: RangeKey;
  custom?: CustomSpan;
  // Whether the URL itself named a range — tells a loader whether to write the cookie back.
  explicit: boolean;
}

// Precedence URL > cookie > default, written once for both routes. Object.hasOwn, not `in`
// (which walks the prototype chain): a hand-edited "?range=toString" must not match RANGES.toString.
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

// The payload block a loader spreads into its return — both routes assembled this by hand
// before spec 0015. Every field but custom/customMax is derived from a type this file already
// declares, so none can drift from what actually produces it.
export type ChartControls = Pick<RangeWindow, "range"> & {
  // Required, not optional: always undefined off a non-custom range, never an omittable key
  // (route tests assert toBeUndefined()).
  custom: RangeWindow["custom"];
  // Null on every range but 1D — tells the chart which axis it's drawing (§7).
  session: SessionAxis | null;
  rangeOptions: ReturnType<typeof rangeOptions>;
  customMin: ReturnType<typeof customRangeMin>;
  customMax: IsoDate;
};

// The window a surface's chart draws, plus the control block a loader spreads into its
// return (spec 0015). Pure: timeZone arrives as an option rather than read off configuration.
// `resolved` is returned, not folded away, because the Overview loader still needs
// resolved.since (netWorthChange) and resolved.session (whether its manual prefix is drawn).
export function chartWindow(
  surface: Surface,
  opts: {
    request: Request;
    today: IsoDate;
    earliest: SurfaceEarliest;
    session: IsoDate | null; // from latestObservedSession; see resolveRange
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

// The three parameters this control owns; kept beside readChartRange so read/write can't drift.
const RANGE_PARAMS = ["range", "start", "end"];

// The address stripped of this control's own vocabulary, in its existing order.
export function carriedParams(params: URLSearchParams): [string, string][] {
  return [...params].filter(([name]) => !RANGE_PARAMS.includes(name));
}

// Rest of the query plus this preset's own "?range=". A whole search string, not React
// Router's relative resolution: a `to` starting with "?" replaces the entire query, which
// silently dropped "?uploaded=" when a range was picked. start/end dropped, not carried —
// a preset never reads them.
export function rangeSearch(params: URLSearchParams, range: RangeKey): string {
  const next = new URLSearchParams(carriedParams(params));
  next.set("range", range);

  return `?${next.toString()}`;
}

// Remembers an explicit range choice in the cookie (spec 0008). A middleware, not a header
// on the loader's return, so each loader keeps one plain-object return shape for its tests.
// Remembers the request's own "?range=", not a database-resolved effective value — a
// middleware never sees what the loader returned.
export function chartRangeMiddleware() {
  // Untyped against react-router's MiddlewareFunction: it and the routes' generated
  // Route.MiddlewareFunction disagree on next's return type and aren't mutually assignable.
  return async ({ request }: { request: Request }, next: () => Promise<unknown>): Promise<Response> => {
    const response = (await next()) as Response;
    const requested = readChartRange(request);

    // Not onto a redirect: a cookie on a response that isn't the page is a header nobody
    // reads, and every redirect lands somewhere this middleware also runs.
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
