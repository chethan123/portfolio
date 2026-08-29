/**
 * The range-resolution math both routes' loaders read (spec 0008), including
 * the sampler's density rule since spec 0009 / ADR-0003.
 *
 * Pure — no Postgres and no render — for `masking.test.ts`'s reason: this is
 * the domain rule itself, `AGENTS.md` asks for a domain rule to be tested as
 * itself, and exhausting nine presets and their edge cases through
 * database-backed renders would be slow and would prove less.
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_RANGE,
  RANGE_COOKIE,
  RANGES,
  SAMPLE_BUDGET,
  customRangeMin,
  decodeRangeCookieValue,
  encodeRangeCookieValue,
  isRangeDisabled,
  rangeCookie,
  rangeDescription,
  rangeOptions,
  readChartRange,
  carriedParams,
  rangeSearch,
  readRangeCookie,
  resolveRange,
  surfaceEarliestDate,
  type RangeKey,
  type RangeWindow,
  type Surface,
} from "~/lib/chart-range";

/** A Wednesday, chosen for no reason but to be a fixed, ordinary "today". */
const TODAY = "2026-08-26";

describe("each preset's boundary against a fixed today", () => {
  const NO_DATA = { earliest: { positionSet: null }, surface: "household" as Surface, today: TODAY };

  // 1D is excluded: it is the one preset whose boundary is not a calendar
  // offset from today but the session the observation log last carried.
  const BOUNDARIES: Record<Exclude<RangeKey, "1d" | "all" | "custom">, string> = {
    "1w": "2026-08-19",
    "1m": "2026-07-26",
    "3m": "2026-05-26",
    ytd: "2026-01-01",
    "1y": "2025-08-26",
    "5y": "2021-08-26",
  };

  for (const [range, since] of Object.entries(BOUNDARIES) as [RangeKey, string][]) {
    it(`resolves ${range} to ${since}`, () => {
      expect(resolveRange(range, NO_DATA).since).toBe(since);
    });
  }

  it("resolves YTD to January 1st even one day into the year", () => {
    expect(resolveRange("ytd", { ...NO_DATA, today: "2026-01-02" }).since).toBe("2026-01-01");
  });

  it("rolls a month-end trailing boundary into the next month, rather than clamping", () => {
    // 31 March minus one month: `Date` has no 31 February, so this is the
    // accepted edge rather than a special case.
    expect(resolveRange("1m", { ...NO_DATA, today: "2026-03-31" }).since).toBe("2026-03-03");
  });

  it("3M resolves as an ordinary, first-class preset", () => {
    // Not dead code left over from the old four-option set: it appears in the
    // vocabulary, and it resolves like every other calendar-offset preset.
    expect(RANGES["3m"]).toEqual({ label: "3M" });
    expect(resolveRange("3m", NO_DATA).since).toBe("2026-05-26");
  });
});

describe("the per-surface data-source rule, applied to every preset", () => {
  const EARLIEST = {
    positionSet: "2026-06-01" as const,
    manual: "2020-01-01" as const,
  };

  it("reaches into the household's hand-typed pre-app history on every preset, not only All", () => {
    for (const range of ["all", "5y", "1y"] as RangeKey[]) {
      const window = resolveRange(range, { today: TODAY, earliest: EARLIEST, surface: "household" });

      // "All" is measured from the earlier date directly; the fixed presets'
      // own boundary is unaffected, but the same earlier date is what the
      // disabled rule below measures every one of them against.
      if (range === "all") expect(window.since).toBe(EARLIEST.manual);
    }

    expect(surfaceEarliestDate("household", EARLIEST)).toBe(EARLIEST.manual);
  });

  it("never considers the manual series on the account surface", () => {
    expect(surfaceEarliestDate("account", EARLIEST)).toBe(EARLIEST.positionSet);
    expect(resolveRange("all", { today: TODAY, earliest: EARLIEST, surface: "account" }).since).toBe(
      EARLIEST.positionSet,
    );
  });

  it("falls back to the default preset's width when a surface has no data at all, while still reporting All", () => {
    const empty = { positionSet: null };
    const household = resolveRange("all", { today: TODAY, earliest: empty, surface: "household" });
    const defaulted = resolveRange(DEFAULT_RANGE, { today: TODAY, earliest: empty, surface: "household" });

    // The width matches the default preset's, but the identity does not: "All"
    // never degrades into reporting itself as "1Y" the way an unusable custom
    // span does below — it is a real, explicit selection either way.
    expect(household.since).toBe(defaulted.since);
    expect(household.dates).toEqual(defaulted.dates);
    expect(household.range).toBe("all");
  });
});

describe("the disabled-state rule", () => {
  const earliest = { positionSet: "2026-06-01" as const };

  it("disables a preset whose start falls before the surface's earliest date", () => {
    // 5Y's boundary (2021-08-26) is well before an account eight months old.
    expect(isRangeDisabled("5y", { today: TODAY, earliest, surface: "account" })).toBe(true);
  });

  it("does not disable a preset whose start lands exactly on the earliest date", () => {
    // YTD opened on January 1st or 2nd: an account or household whose data
    // starts that same day must show thin data, not a disabled control.
    expect(
      isRangeDisabled("ytd", { today: "2026-01-02", earliest: { positionSet: "2026-01-01" }, surface: "household" }),
    ).toBe(false);
    expect(
      isRangeDisabled("ytd", { today: "2026-01-01", earliest: { positionSet: "2026-01-01" }, surface: "household" }),
    ).toBe(false);
  });

  const NO_DATA = { earliest: { positionSet: null }, surface: "household" as Surface, today: TODAY };

  it("does not disable a preset whose start falls after the earliest date", () => {
    expect(isRangeDisabled("1w", { today: TODAY, earliest, surface: "account" })).toBe(false);
  });

  it("never disables All or Custom", () => {
    const ancient = { positionSet: "1970-01-01" as const };
    expect(isRangeDisabled("all", { today: TODAY, earliest: ancient, surface: "household" })).toBe(false);
    expect(isRangeDisabled("custom", { today: TODAY, earliest, surface: "account" })).toBe(false);
  });

  it("disables nothing but 1D on an instance with no data at all", () => {
    // The empty state renders instead of a chart, so this is academic for the
    // date-bounded presets — but one must not read as disabled before there is
    // anything to compare it against. 1D is the exception because it is not
    // bounded by a date at all: with an empty observation log there is no
    // session to draw, which is a different claim from "your history is short".
    const noData = { today: TODAY, earliest: { positionSet: null }, surface: "account" as Surface };

    for (const range of Object.keys(RANGES) as RangeKey[]) {
      expect(isRangeDisabled(range, noData)).toBe(range === "1d");
    }
  });

  it("offers 1D once anything at all has been observed, however little", () => {
    // One observation is not two points and the panel says so in words — but
    // the chip is not the place to say it. Story 13 disables it only where the
    // log is empty outright.
    const observed = { ...NO_DATA, session: "2026-08-26" };

    expect(isRangeDisabled("1d", observed)).toBe(false);
    expect(isRangeDisabled("1d", { ...NO_DATA, session: null })).toBe(true);
    expect(isRangeDisabled("1d", NO_DATA)).toBe(true);
  });

  it("lists every option in order, each carrying its own disabled state", () => {
    const options = rangeOptions({ today: TODAY, earliest, surface: "account" });

    expect(options.map((option) => option.key)).toEqual(Object.keys(RANGES));
    expect(options.find((option) => option.key === "5y")?.disabled).toBe(true);
    expect(options.find((option) => option.key === "1w")?.disabled).toBe(false);
  });
});

describe("1D, the preset that is a session rather than a span", () => {
  const HOUSEHOLD = { earliest: { positionSet: "2020-01-01" }, surface: "household" as Surface, today: TODAY };

  it("resolves to the session the observation log last carried, and to no dates at all", () => {
    const window = resolveRange("1d", { ...HOUSEHOLD, session: "2026-08-25" });

    expect(window.range).toBe("1d");
    expect(window.session).toBe("2026-08-25");
    // Empty on purpose: the points come from the log's own instants, and the
    // day-granularity sampler is bypassed entirely. A loader that missed
    // `session` and read the day series draws nothing rather than the wrong
    // thing.
    expect(window.dates).toEqual([]);
  });

  it("measures its change from the day before the session, never from the session itself", () => {
    // Today's own `price_daily` row converges on the last observation of the
    // day, so measuring against it would report every session as flat. The day
    // before, carried forward, is the previous close.
    expect(resolveRange("1d", { ...HOUSEHOLD, session: "2026-08-25" }).since).toBe("2026-08-24");
  });

  it("names the latest session it was given, whatever today is", () => {
    // A Sunday. 1D shows Friday's session because Friday is what was observed —
    // the session comes from the log, never from the calendar.
    const window = resolveRange("1d", { ...HOUSEHOLD, today: "2026-08-30", session: "2026-08-28" });

    expect(window.session).toBe("2026-08-28");
    expect(window.since).toBe("2026-08-27");
  });

  it("falls back to the default preset when nothing has been observed", () => {
    // The same fallback an undrawable custom span takes, and reported back the
    // same way: a caller cannot caption a chart "1D" from a session it never had.
    for (const session of [null, undefined]) {
      const window = resolveRange("1d", { ...HOUSEHOLD, session });

      expect(window.range).toBe(DEFAULT_RANGE);
      expect(window.session).toBeUndefined();
      expect(window.dates.length).toBeGreaterThan(1);
    }
  });

  it("describes itself as a session rather than as a span", () => {
    expect(rangeDescription("1d")).toBe("over the latest trading session");
  });

  it("is remembered and re-read like any other preset key", () => {
    // The whole of what 1D inherits unchanged: the URL parameter, the cookie
    // and the segmented control know it as one more key.
    expect(encodeRangeCookieValue("1d")).toBe("1d");
    expect(decodeRangeCookieValue("1d")).toEqual({ range: "1d" });
    expect(readChartRange(new Request("https://x/?range=1d"))).toEqual({ range: "1d", explicit: true });

    const request = new Request("https://x/", { headers: { Cookie: "chart_range=1d" } });
    expect(readChartRange(request)).toEqual({ range: "1d", explicit: false });
  });

  it("leaves every other preset resolving exactly as it did", () => {
    // The new key must not reach a range that is already history.
    const withSession = resolveRange("1m", { ...HOUSEHOLD, session: "2026-08-25" });
    const without = resolveRange("1m", HOUSEHOLD);

    expect(withSession).toEqual(without);
  });
});

/**
 * `until` minus `days` calendar days, for building spans of an exact `D`.
 *
 * Deliberately its own arithmetic rather than the module's `addDays`, which is
 * not exported: a test that measured spans with the same helper the code under
 * test builds them from could not catch that helper being wrong.
 */
function daysBefore(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/** A custom span with no earliest-date floor, so `D` is under this test's own control. */
function spanOf(since: string, until: string): RangeWindow {
  return resolveRange("custom", {
    today: until,
    earliest: { positionSet: null },
    surface: "household",
    custom: { start: since, end: until },
  });
}

/** Whole calendar days between two ISO dates (UTC, matching the module's own arithmetic). */
function dayGap(a: string, b: string): number {
  return Math.round(
    (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000,
  );
}

/**
 * The gaps between consecutive sampled dates, in the order `dates` runs —
 * ascending, so `gaps[0]` is the oldest gap and `gaps.at(-1)` the one at the
 * anchor. Walked with a carried `previous` rather than by index, so no element
 * access has to be asserted non-null past `noUncheckedIndexedAccess`.
 */
function gapsOf(dates: readonly string[]): number[] {
  const gaps: number[] = [];
  let previous: string | undefined;

  for (const date of dates) {
    if (previous !== undefined) gaps.push(dayGap(previous, date));
    previous = date;
  }

  return gaps;
}

describe("sampling: every calendar day inside the budget, geometric decay beyond it", () => {
  it("returns every calendar day, ascending, both ends included, for a short window", () => {
    const { dates } = resolveRange("1w", { today: TODAY, earliest: { positionSet: null }, surface: "household" });

    // A week is 8 distinct calendar days, all of them, exactly — no decay and
    // nothing deduped away, unlike the fixed-count sampler this replaces.
    expect(dates).toEqual([
      "2026-08-19",
      "2026-08-20",
      "2026-08-21",
      "2026-08-22",
      "2026-08-23",
      "2026-08-24",
      "2026-08-25",
      "2026-08-26",
    ]);
  });

  it("holds at the budget boundary itself: a span of exactly 180 days-plus-one is every calendar day, not decayed", () => {
    const since = daysBefore(TODAY, SAMPLE_BUDGET - 1);
    const { dates } = spanOf(since, TODAY);

    expect(dates.length).toBe(SAMPLE_BUDGET);
    expect(dates[0]).toBe(since);
    expect(dates.at(-1)).toBe(TODAY);
    // Every calendar day, so every gap is exactly one — no off-by-one at the
    // seam from this side of it.
    expect(gapsOf(dates)).toEqual(Array(SAMPLE_BUDGET - 1).fill(1));
  });

  it("crosses into decay exactly one day past the boundary, with no gap or duplicate at the seam", () => {
    const since = daysBefore(TODAY, SAMPLE_BUDGET);
    const { dates } = spanOf(since, TODAY);

    // Still exactly the budget's worth of dates — one more day of span did
    // not add an extra sample, it triggered decay instead.
    expect(dates.length).toBe(SAMPLE_BUDGET);
    expect(new Set(dates).size).toBe(SAMPLE_BUDGET);
    expect(dates).toEqual([...dates].sort());
    expect(dates[0]).toBe(since);
    expect(dates.at(-1)).toBe(TODAY);
    expect(gapsOf(dates).at(-1)).toBe(1);
  });

  it("returns exactly the budget's worth of dates for a span that exceeds it, decaying from `until`", () => {
    const { dates } = resolveRange("5y", { today: TODAY, earliest: { positionSet: null }, surface: "household" });

    expect(dates.length).toBe(SAMPLE_BUDGET);
    expect(new Set(dates).size).toBe(SAMPLE_BUDGET);
    expect(dates).toEqual([...dates].sort());
    // The earliest sample lands exactly on `since` — the ratio was solved so
    // the accumulated gaps sum to precisely the span, not merely close to it.
    expect(dates[0]).toBe("2021-08-26");
    expect(dates.at(-1)).toBe(TODAY);

    const gaps = gapsOf(dates);

    // The gap right at the anchor is fixed at one calendar day, for every
    // budget-exceeding span, regardless of how wide it is.
    expect(gaps.at(-1)).toBe(1);

    // Growth is asserted as a trend across quarters of the span, NOT pair by
    // adjacent pair, and the difference is deliberate. Spec 01's acceptance
    // criterion says "gaps strictly increasing walking backward"; that is not
    // what a solved ratio of ~1.02 does once each offset is rounded to a whole
    // day. Measured on this very span, only 56 of 178 adjacent pairs strictly
    // increase, 100 are equal, and 22 actually decrease by a day — rounding a
    // smooth curve to integers is not monotonic step to step. The property the
    // chart actually depends on, and the one the spec was reaching for, is
    // that resolution is dense near the anchor and coarse far from it. That is
    // what this asserts. See the PR discussion: the criterion's literal wording
    // is unachievable for any budget/span where the ratio is near one.
    const bucket = (from: number, to: number) =>
      gaps.slice(from, to).reduce((sum, gap) => sum + gap, 0) / (to - from);
    const quarter = Math.floor(gaps.length / 4);
    expect(bucket(0, quarter)).toBeGreaterThan(bucket(quarter, 2 * quarter));
    expect(bucket(quarter, 2 * quarter)).toBeGreaterThan(bucket(2 * quarter, 3 * quarter));
    expect(bucket(2 * quarter, 3 * quarter)).toBeGreaterThan(bucket(3 * quarter, gaps.length));
  });

  it("decays from `until` itself, not from the real current date, for a window ending in the past", () => {
    const pastUntil = "2020-06-15";
    const since = daysBefore(pastUntil, 900); // well over the budget

    const { dates } = spanOf(since, pastUntil);

    expect(dates.length).toBe(SAMPLE_BUDGET);
    expect(dates[0]).toBe(since);
    expect(dates.at(-1)).toBe(pastUntil);
    // The one-day anchor gap holds relative to `pastUntil`, proving the decay
    // took no implicit dependency on the wall clock beyond what was passed in.
    expect(gapsOf(dates).at(-1)).toBe(1);
  });

  it("keeps two samples on or after a household's own history on every budget-exceeding preset — the spec 0009 regression", () => {
    // The reported bug, set up as reported: a household that uploaded its
    // first statement yesterday, so its whole recorded history is one calendar
    // day old. `positionSet` is that history, not null, so this is the real
    // household shape rather than a bare date comparison — the preset's own
    // boundary ignores it (only "All" and "Custom" measure from the earliest
    // date), which is exactly why the sampler had to be the thing that fixed
    // this.
    const historyStart = daysBefore(TODAY, 1);
    const earliest = { positionSet: historyStart };

    // Every preset whose span outruns the budget, not just the default: 5Y and
    // All regressed the same way, one order of magnitude less visibly (spec
    // 0009, "Testing Decisions").
    for (const range of ["1y", "5y", "all"] as RangeKey[]) {
      const { dates } = resolveRange(range, { today: TODAY, earliest, surface: "household" });

      // Two points is the whole bug: one is what the old sampler left, and one
      // point cannot draw a line.
      expect(dates.filter((date) => date >= historyStart).length).toBeGreaterThanOrEqual(2);
    }
  });
});

describe("a custom range", () => {
  const earliest = { positionSet: "2026-01-01" as const };

  it("resolves to exactly the span asked for, when it is drawable", () => {
    const window = resolveRange("custom", {
      today: TODAY,
      earliest,
      surface: "household",
      custom: { start: "2026-02-01", end: "2026-05-01" },
    });

    expect(window.since).toBe("2026-02-01");
    expect(window.dates[0]).toBe("2026-02-01");
    expect(window.dates.at(-1)).toBe("2026-05-01");
  });

  it("falls back to the default rather than erroring on an incomplete pair", () => {
    const fallback = resolveRange(DEFAULT_RANGE, { today: TODAY, earliest, surface: "household" });

    expect(resolveRange("custom", { today: TODAY, earliest, surface: "household" })).toEqual(fallback);
  });

  it("falls back to the default rather than drawing a span before the surface's earliest date", () => {
    const fallback = resolveRange(DEFAULT_RANGE, { today: TODAY, earliest, surface: "household" });
    const tooEarly = resolveRange("custom", {
      today: TODAY,
      earliest,
      surface: "household",
      custom: { start: "2020-01-01", end: "2026-05-01" },
    });

    expect(tooEarly).toEqual(fallback);
  });

  it("falls back to the default rather than drawing a span reaching into the future", () => {
    const fallback = resolveRange(DEFAULT_RANGE, { today: TODAY, earliest, surface: "household" });
    const future = resolveRange("custom", {
      today: TODAY,
      earliest,
      surface: "household",
      custom: { start: "2026-01-01", end: "2027-01-01" },
    });

    expect(future).toEqual(fallback);
  });

  it("falls back to the default rather than drawing an end before its own start", () => {
    const fallback = resolveRange(DEFAULT_RANGE, { today: TODAY, earliest, surface: "household" });
    const backwards = resolveRange("custom", {
      today: TODAY,
      earliest,
      surface: "household",
      custom: { start: "2026-05-01", end: "2026-02-01" },
    });

    expect(backwards).toEqual(fallback);
  });

  it("gives a custom date input the surface's own earliest date as its minimum", () => {
    expect(customRangeMin("household", earliest)).toBe("2026-01-01");
    expect(customRangeMin("account", { positionSet: null })).toBeNull();
  });
});

describe("reading a request: URL, then cookie, then the hardcoded default", () => {
  const requestWith = (search: string, cookie?: string): Request =>
    new Request(`http://portfolio.local/${search}`, cookie ? { headers: { Cookie: cookie } } : undefined);

  it("takes an explicit ?range= over a cookie naming a different range", () => {
    expect(readChartRange(requestWith("?range=5y", `${RANGE_COOKIE}=1m`))).toEqual({
      range: "5y",
      explicit: true,
    });
  });

  it("takes an explicit custom span over a cookie", () => {
    expect(
      readChartRange(requestWith("?range=custom&start=2026-01-01&end=2026-03-01", `${RANGE_COOKIE}=1m`)),
    ).toEqual({ range: "custom", custom: { start: "2026-01-01", end: "2026-03-01" }, explicit: true });
  });

  it("uses the cookie's stored range when the URL carries none", () => {
    expect(readChartRange(requestWith("", `${RANGE_COOKIE}=5y`))).toEqual({ range: "5y", explicit: false });
  });

  it("uses the hardcoded default when neither the URL nor the cookie says anything", () => {
    expect(readChartRange(requestWith(""))).toEqual({ range: DEFAULT_RANGE, explicit: false });
  });

  it("does not mistake an inherited property name for a range, however much it looks like a key", () => {
    for (const inherited of ["toString", "constructor", "valueOf", "hasOwnProperty"]) {
      expect(readChartRange(requestWith(`?range=${inherited}`))).toEqual({
        range: DEFAULT_RANGE,
        explicit: false,
      });
    }
  });

  it("falls back to the default when the URL and the cookie both name nothing usable", () => {
    expect(readChartRange(requestWith("?range=whenever", "not_the_cookie=5y"))).toEqual({
      range: DEFAULT_RANGE,
      explicit: false,
    });
  });
});

describe("the persistence cookie", () => {
  it("is named distinctly from the masking cookie", () => {
    expect(RANGE_COOKIE).not.toBe("masked");
  });

  it("round-trips a fixed preset", () => {
    expect(decodeRangeCookieValue(encodeRangeCookieValue("5y"))).toEqual({ range: "5y" });
  });

  it("round-trips a custom span", () => {
    const encoded = encodeRangeCookieValue("custom", { start: "2026-01-01", end: "2026-06-01" });
    expect(decodeRangeCookieValue(encoded)).toEqual({
      range: "custom",
      custom: { start: "2026-01-01", end: "2026-06-01" },
    });
  });

  it("decodes an unrecognised value to null rather than guessing", () => {
    expect(decodeRangeCookieValue("whenever")).toBeNull();
    expect(decodeRangeCookieValue("custom")).toBeNull();
    expect(decodeRangeCookieValue("custom:2026-01-01")).toBeNull();
    expect(decodeRangeCookieValue("toString")).toBeNull();
  });

  it("is scoped to the whole app, persistent, and not sent across sites", () => {
    expect(rangeCookie("1y")).toContain("Path=/");
    expect(rangeCookie("1y")).toMatch(/samesite=lax/i);
    expect(rangeCookie("1y")).toMatch(/max-age=\d+/i);
  });

  it("finds its own value among the others a browser sends, whole-name matched", () => {
    const requestWith = (cookie: string) => new Request("http://portfolio.local/", { headers: { Cookie: cookie } });

    expect(readRangeCookie(requestWith(`_oauth2_proxy=abc; ${RANGE_COOKIE}=5y`))).toBe("5y");
    expect(readRangeCookie(requestWith(`not_${RANGE_COOKIE}=5y`))).toBeUndefined();
    expect(readRangeCookie(new Request("http://portfolio.local/"))).toBeUndefined();
  });
});

describe("the address a range control points at", () => {
  const at = (search: string) => new URLSearchParams(search);

  it("keeps every parameter the control does not own", () => {
    // The bug this exists to fix: a bare `?range=1m` is a whole query string,
    // and React Router resolves it as one — so picking a range on the account
    // page dropped the `?uploaded=` receipt the reader was looking at.
    expect(rangeSearch(at("?uploaded=42"), "1m")).toBe("?uploaded=42&range=1m");
    // Comma-spelled, not `%2C`: `?owner=1,3` is this application's canonical
    // spelling for a multi-valued parameter (spec 0013), and a second spelling
    // of one view is what that normalisation rule exists to prevent.
    expect(rangeSearch(at("?owner=1,3&sort=value"), "1m")).toBe("?owner=1,3&sort=value&range=1m");
  });

  it("rewrites its own three rather than carrying them, so no preset leaves a custom span behind", () => {
    expect(rangeSearch(at("?range=custom&start=2026-01-01&end=2026-06-30"), "1m")).toBe("?range=1m");
    expect(rangeSearch(at(""), "1y")).toBe("?range=1y");
  });

  it("carries a repeated parameter as many times as the address holds it", () => {
    // `URLSearchParams.get` would keep one and discard the rest, which is a
    // link that quietly edits the address it was only meant to add to.
    expect(rangeSearch(at("?tag=a&tag=b"), "1m")).toBe("?tag=a&tag=b&range=1m");
    expect(carriedParams(at("?tag=a&tag=b"))).toEqual([
      ["tag", "a"],
      ["tag", "b"],
    ]);
  });

  it("hands the Custom form the same parameters, since a GET form submits its own fields and nothing else", () => {
    expect(carriedParams(at("?recorded=2026-01-31&range=1m&start=x&end=y"))).toEqual([
      ["recorded", "2026-01-31"],
    ]);
  });
});
