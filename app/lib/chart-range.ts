/**
 * The chart-range vocabulary, resolution and cookie, once (spec 0008).
 *
 * `overview.tsx` and `account.tsx` each carried their own `RANGES`/`windowDays`/
 * `sampleWindow` — `ARCHITECTURE.md` named the pair as debt, with one caveat:
 * `windowDays` could not be shared because "All" meant a different earliest
 * date on each screen. This module removes that caveat by taking *which*
 * surface's data-source rule applies as an explicit parameter, so the
 * boundary math, the disabled-state rule and the sampler live here once and
 * both routes call in rather than compute their own.
 *
 * Not a `.server` module, for `masking.ts`'s reason: nothing here touches the
 * database, and both routes' components (rendered again in the browser after
 * hydration) read the vocabulary too.
 *
 * The cookie lives here for the same reason masking's does — the vocabulary,
 * the precedence and the serialisation are one rule seen from several call
 * sites, and splitting them is how they drift. Distinct in name from
 * `MASKING_COOKIE`: this is a remembered convenience, not a household policy,
 * and unlike masking's session-scoped default it has no reason to forget
 * itself between browser sessions.
 */
import type { IsoDate } from "./valuation.server.ts";

/** The eight options the segmented control offers, in display order. */
export type RangeKey = "1w" | "1m" | "3m" | "ytd" | "1y" | "5y" | "all" | "custom";

/**
 * The presets and their order — identical on Overview and the account page,
 * key for key, so a bookmark from one works unchanged on the other.
 *
 * 3M is kept deliberately. It predates the wider set this spec adds and was a
 * live decision to retain it, against a recommendation raised while designing
 * this spec, rather than an oversight of the old four-option control — so a
 * future pass should not read it as leftover debt to clean up.
 */
export const RANGES: Record<RangeKey, { label: string }> = {
  "1w": { label: "1W" },
  "1m": { label: "1M" },
  "3m": { label: "3M" },
  ytd: { label: "YTD" },
  "1y": { label: "1Y" },
  "5y": { label: "5Y" },
  all: { label: "All" },
  custom: { label: "Custom" },
};

/** Left as a literal, not widened to `RangeKey`, so it stays a fixed preset. */
export const DEFAULT_RANGE = "1y" as const satisfies RangeKey;

/**
 * The sampling budget (spec 0009, issue #74): how many dates a chart will
 * ever check for one range.
 *
 * A span whose whole day-count-plus-one fits inside this budget is sampled
 * at every calendar day — no gaps at all. A wider span is sampled at exactly
 * this many dates, spaced by a decay that grows geometrically walking
 * backward from `until`, so the day right next to the anchor is always
 * checked regardless of how wide the range is. Raising or lowering chart
 * density for every long-range preset at once is changing this one number.
 */
export const CAP = 180;

const DAY_MS = 86_400_000;

/** Which surface is asking — the parameter that lets the two routes share this module. */
export type Surface = "household" | "account";

/**
 * The dates a surface's own history reaches back to.
 *
 * `manual` is read only for the household surface — an account's range never
 * considers hand-typed pre-app history, because that history was never any
 * one account's (`CONTEXT.md`'s "chart range" entry).
 */
export interface SurfaceEarliest {
  /** The earliest position-set date, or null on an instance/account with none. */
  positionSet: IsoDate | null;
  /** The earliest hand-typed manual point. Ignored on the account surface. */
  manual?: IsoDate | null;
}

/** A start and end date the reader picked themselves. */
export interface CustomSpan {
  start: IsoDate;
  end: IsoDate;
}

/** Where a window starts, and the dates to draw it from. */
interface Window {
  since: IsoDate;
  dates: IsoDate[];
}

/**
 * The window to report on, and which range actually produced it.
 *
 * `range` and `custom` echo back the *effective* selection rather than the
 * one asked for: "All" always reports itself, since its boundary is the
 * surface's earliest date by definition, but an unusable custom span reports
 * back as the default preset it fell back to — a caller cannot draw a chart
 * captioned "Custom" from a span it never actually used.
 */
export interface RangeWindow extends Window {
  range: RangeKey;
  custom?: CustomSpan;
}

/** UTC throughout, deliberately — the one conversion that cannot pick up a server's zone. */
const isoDate = (ms: number): IsoDate => new Date(ms).toISOString().slice(0, 10);

const parseIso = (date: IsoDate): number => Date.parse(`${date}T00:00:00Z`);

function addDays(date: IsoDate, days: number): IsoDate {
  return isoDate(parseIso(date) + days * DAY_MS);
}

/**
 * Calendar-month arithmetic, not a fixed day count.
 *
 * 1M and 3M are the trailing calendar month/quarter — today back to the same
 * day-of-month one or three months prior — the same shape 1Y and 5Y take at
 * twelve and sixty months. `setUTCMonth` handles the month-end edge (31 March
 * minus one month) the way `Date` always has: it rolls into the next month
 * rather than clamping, which is accepted here rather than special-cased.
 */
function subtractMonths(date: IsoDate, months: number): IsoDate {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString().slice(0, 10);
}

const startOfYear = (date: IsoDate): IsoDate => `${date.slice(0, 4)}-01-01`;

/** Every preset's boundary except "All" and "Custom", which need the surface's earliest date. */
const FIXED_BOUNDARY: Record<Exclude<RangeKey, "all" | "custom">, (today: IsoDate) => IsoDate> = {
  "1w": (today) => addDays(today, -7),
  "1m": (today) => subtractMonths(today, 1),
  "3m": (today) => subtractMonths(today, 3),
  ytd: (today) => startOfYear(today),
  "1y": (today) => subtractMonths(today, 12),
  "5y": (today) => subtractMonths(today, 60),
};

/**
 * Whichever is earlier, on the surface's own terms.
 *
 * Household: the earlier of the earliest position-set date and the earliest
 * hand-typed manual point — the manual series is the part of the chart that
 * reaches furthest back, so ignoring it here would cut off the very history
 * "All", and every preset's disabled state, is supposed to reach. Account: its
 * own earliest position-set date only, never the manual series, which is the
 * household's net worth and not any one account's.
 */
export function surfaceEarliestDate(surface: Surface, earliest: SurfaceEarliest): IsoDate | null {
  if (surface === "account") return earliest.positionSet;

  return (
    [earliest.positionSet, earliest.manual ?? null]
      .filter((date): date is IsoDate => date !== null)
      .sort()[0] ?? null
  );
}

/**
 * The ratio `r > 1` such that `n` geometrically growing terms starting at
 * `r^0 = 1` sum to exactly `target` — i.e. `1 + r + r^2 + ... + r^(n-1) =
 * target`. Solved by bisection rather than in closed form (ADR-0003): the sum
 * is continuous and strictly increasing in `r` for `r > 1`, running from `n`
 * (as `r → 1⁺`) to unbounded, and every caller here only asks for a `target`
 * greater than `n`, so a solution always exists and bisection converges on
 * it reliably.
 */
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

  let low = 1;
  let high = 2;
  while (sumAt(high) < target) high *= 2;

  // A tolerance this tight on `r` itself is what the spec calls for: loose
  // enough to converge in a bounded number of steps, tight enough that every
  // downstream day-offset (up to `CAP - 2` powers of `r`) rounds stably.
  while (high - low > 1e-9) {
    const mid = (low + high) / 2;
    if (sumAt(mid) < target) low = mid;
    else high = mid;
  }

  return (low + high) / 2;
}

/**
 * Every calendar day from `since` to `until` when the span fits the budget;
 * otherwise exactly `CAP` dates, geometrically decaying backward from
 * `until` (spec 0009, issue #74, ADR-0003).
 *
 * The anchor is `until`, never the real current date — every fixed preset's
 * `until` already equals today, so this only matters for a custom range
 * ending in the past, which must decay away from its own end rather than
 * from the wall clock.
 */
function sampleWindow(since: IsoDate, until: IsoDate): Window {
  const start = parseIso(since);
  const end = parseIso(until);
  const spanDays = Math.round((end - start) / DAY_MS);

  if (spanDays + 1 <= CAP) {
    const dates = Array.from({ length: spanDays + 1 }, (_, index) => addDays(since, index));
    return { since, dates };
  }

  // `CAP - 1` gap terms (`r^0` through `r^(CAP-2)`), the first fixed at one
  // calendar day by construction (`r^0 = 1`), solved to sum exactly to the
  // span so the walk backward lands precisely on `since`.
  const ratio = solveGrowthRatio(CAP - 1, spanDays);

  // Cumulative day-offsets from `until`, nearest first: offset(0) = 0,
  // offset(k) = offset(k-1) + ratio^(k-1). `offsets[CAP - 1]` equals
  // `spanDays` by construction of `ratio`, landing exactly on `since`.
  const offsets: number[] = [0];
  let gap = 1;
  for (let k = 1; k < CAP; k++) {
    offsets.push(offsets[k - 1]! + gap);
    gap *= ratio;
  }

  // Built nearest-to-`until` first above; reversed here into the ascending,
  // oldest-first order every other caller of this function returns.
  const dates = offsets.map((offset) => addDays(until, -Math.round(offset))).reverse();

  return { since, dates };
}

/**
 * Is `custom` a span this surface can actually draw?
 *
 * Both ends have to be set, in order, and within what the surface can show —
 * an incomplete pair (one box filled in) or an out-of-bounds one is refused
 * here rather than drawn from a clamp, the same defensive posture the
 * `Object.hasOwn` guard already takes against a hand-edited `range`.
 */
function isDrawableCustomSpan(span: CustomSpan, today: IsoDate, earliest: IsoDate | null): boolean {
  if (span.start > span.end) return false;
  if (span.end > today) return false;
  if (earliest !== null && span.start < earliest) return false;
  return true;
}

/**
 * The window a range resolves to for one surface, on one day.
 *
 * "All" and "Custom" are the two presets that need the surface's earliest
 * date rather than a fixed calendar offset: "All" is measured from it
 * directly, and an unusable custom span falls back to the same default every
 * other unrecognised range does rather than erroring.
 */
export function resolveRange(
  range: RangeKey,
  opts: { today: IsoDate; earliest: SurfaceEarliest; surface: Surface; custom?: CustomSpan },
): RangeWindow {
  const earliestDate = surfaceEarliestDate(opts.surface, opts.earliest);

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

/**
 * Whether a fixed preset's start falls before this surface's earliest date.
 *
 * A preset landing exactly on the earliest date is not disabled — the day an
 * account (or the household) opened is a real, drawable start for every
 * preset that reaches back that far, including YTD on January 1st or 2nd for
 * an instance that new. "All" and "Custom" are never disabled: "All"'s
 * boundary is the earliest date by definition, and "Custom" is a picker
 * rather than a fixed span.
 */
export function isRangeDisabled(
  range: RangeKey,
  opts: { today: IsoDate; earliest: SurfaceEarliest; surface: Surface },
): boolean {
  if (range === "all" || range === "custom") return false;

  const earliestDate = surfaceEarliestDate(opts.surface, opts.earliest);
  if (earliestDate === null) return false;

  return FIXED_BOUNDARY[range](opts.today) < earliestDate;
}

/**
 * The clause a chart's accessible label names the active range with — "over
 * the last 1Y," for a fixed preset, or the actual dates for a custom span, so
 * a screen reader gets an equivalent update for every one of the eight
 * options rather than only the original four (story 24).
 */
export function rangeDescription(range: RangeKey, custom?: CustomSpan): string {
  if (range === "custom" && custom) return `from ${custom.start} to ${custom.end}`;
  return `over the last ${RANGES[range].label}`;
}

/** Every option the segmented control renders, in order, with its disabled state resolved. */
export function rangeOptions(opts: {
  today: IsoDate;
  earliest: SurfaceEarliest;
  surface: Surface;
}): Array<{ key: RangeKey; label: string; disabled: boolean }> {
  return (Object.keys(RANGES) as RangeKey[]).map((key) => ({
    key,
    label: RANGES[key].label,
    disabled: isRangeDisabled(key, opts),
  }));
}

/**
 * The `min` a custom date input should carry for this surface — its own
 * earliest-available date, or none where there is nothing to show yet.
 *
 * Distinct from `earliestRecordableDate` (`input.server.ts`): that is the
 * earliest date the application can price *anything*, a floor on writes. This
 * is the earliest date *this surface* actually has, a floor on what a chart
 * can read back — the same date "All" and the disabled rule above measure
 * against.
 */
export function customRangeMin(surface: Surface, earliest: SurfaceEarliest): IsoDate | null {
  return surfaceEarliestDate(surface, earliest);
}

/**
 * The cookie's name.
 *
 * Distinct from `MASKING_COOKIE`: a different, lower-stakes preference, named
 * so the two cannot be confused in a request's `Cookie` header.
 */
export const RANGE_COOKIE = "chart_range";

/**
 * A year — long enough that a remembered range means what it says on a
 * browser someone opens every few months, and unconditional, unlike
 * masking's policy-dependent lifetime: there is no household policy here to
 * make session-scoping meaningful, only a convenience with nothing to protect
 * by forgetting itself.
 */
const RANGE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/**
 * Serialises what to remember: a fixed preset by its key, or a custom span as
 * both of its dates. One format for both, so the reader has exactly one thing
 * to parse rather than a fixed-key case and a separate custom case.
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
 * What a stored cookie value decodes to, or null if it names no range this
 * control offers — the same refusal, rather than a guess, that the
 * `Object.hasOwn` guard already gives a hand-edited `range` query parameter.
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
 * What this browser last chose, or undefined if it said nothing.
 *
 * Parsed by hand like `readMaskingCookie`, matched on the whole name so a
 * cookie whose name merely ends in this one is never mistaken for it.
 */
export function readRangeCookie(request: Request): string | undefined {
  const header = request.headers.get("Cookie");
  if (header === null) return undefined;

  for (const pair of header.split(";")) {
    const separator = pair.indexOf("=");
    if (separator === -1) continue;

    if (pair.slice(0, separator).trim() === RANGE_COOKIE) {
      return decodeURIComponent(pair.slice(separator + 1).trim());
    }
  }

  return undefined;
}

/** What a request asked for, and whether it asked explicitly. */
export interface RequestedRange {
  range: RangeKey;
  custom?: CustomSpan;
  /**
   * Whether the URL itself named a range, as opposed to falling back to the
   * cookie or the hardcoded default.
   *
   * The one flag a loader needs to decide whether to write the persistence
   * cookie: an explicit `?range=` (or, for Custom, `?start=&end=`) always wins
   * and is what gets written back; its absence falls back to the cookie's
   * stored value, and absence of both falls back to {@link DEFAULT_RANGE}
   * with nothing written, so a browser that has never chosen a range does not
   * have one invented for it.
   */
  explicit: boolean;
}

/**
 * The one place both routes read `?range=` (and, for Custom, `?start=`/
 * `?end=`) against the persistence cookie, so the precedence rule — URL, then
 * cookie, then the hardcoded default — is written once rather than copied
 * into two loaders free to drift on the fallback order.
 *
 * Guarded with the same `Object.hasOwn` check the `RANGES` gate has always
 * used: `in` walks the prototype chain, and a hand-edited `?range=toString`
 * must fall through to the cookie or the default rather than reading
 * `RANGES.toString` as a match.
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
 * Remembers an explicit range choice in the persistence cookie (spec 0008).
 *
 * A middleware rather than a header on the loader's own return, because both
 * routes' test suites call their loader directly and read its fields off the
 * plain object `Route.ComponentProps["loaderData"]` names — including many
 * tests that have nothing to do with this cookie. Wrapping that return in
 * `data(value, { headers })` only when a cookie needs writing would make the
 * loader's result type (and its runtime shape, for a test calling it
 * directly rather than through the router) a union most of those tests never
 * asked for. A middleware wraps the *response* instead, the way the root
 * route's auth gate already does, leaving each loader returning one shape
 * always. One factory here rather than one hand-copied array per route, so
 * the two cannot drift the way the range logic itself used to.
 *
 * What gets remembered is the request's own `?range=` (or `start`/`end`), not
 * some database-resolved effective value — spec 0008's own wording ("an
 * explicit range query parameter... is what gets written back to the
 * cookie") and the fact that a middleware runs around the loader without
 * seeing what it returned. An explicit but undrawable custom span therefore
 * persists as asked and re-falls-back identically on every future read,
 * which costs nothing: {@link resolveRange} applies the same fallback rule
 * every time regardless of where the value came from.
 */
export function chartRangeMiddleware() {
  // Untyped against `react-router`'s own `MiddlewareFunction`, deliberately:
  // that generic type and each route's generated `Route.MiddlewareFunction`
  // disagree on `next`'s return type (`Response` versus `unknown`) and are
  // not assignable to one another. Typed loosely enough to satisfy both
  // `overview.tsx`'s and `account.tsx`'s own generated types by structural
  // subtyping instead — the same reason `tests/support/routes.ts`'s `args()`
  // casts rather than importing a generated `Route.*Args` type.
  return async ({ request }: { request: Request }, next: () => Promise<unknown>): Promise<Response> => {
    const response = (await next()) as Response;
    const requested = readChartRange(request);

    if (requested.explicit) {
      response.headers.append(
        "Set-Cookie",
        rangeCookie(encodeRangeCookieValue(requested.range, requested.custom)),
      );
    }

    return response;
  };
}
