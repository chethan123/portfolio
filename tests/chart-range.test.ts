// Range-resolution math both routes' loaders read (spec 0008), plus the sampler's density
// rule (spec 0009/ADR-0003). Pure, no Postgres/render — this is the domain rule itself.
import { describe, expect, it } from "vitest";

import {
  DEFAULT_RANGE,
  RANGE_COOKIE,
  RANGES,
  SAMPLE_BUDGET,
  chartWindow,
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

  // 1D excluded — its boundary is the observation log's last session, not a calendar offset.
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
    // Date has no 31 February — JS Date rolls it into the next month automatically.
    expect(resolveRange("1m", { ...NO_DATA, today: "2026-03-31" }).since).toBe("2026-03-03");
  });

  it("3M resolves as an ordinary, first-class preset", () => {
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

    expect(household.since).toBe(defaulted.since);
    expect(household.dates).toEqual(defaulted.dates);
    expect(household.range).toBe("all");
  });
});

describe("the disabled-state rule", () => {
  const earliest = { positionSet: "2026-06-01" as const };

  it("disables a preset whose start falls before the surface's earliest date", () => {
    // 5Y's boundary (2021-08-26) predates an 8-month-old account.
    expect(isRangeDisabled("5y", { today: TODAY, earliest, surface: "account" })).toBe(true);
  });

  it("does not disable a preset whose start lands exactly on the earliest date", () => {
    // YTD opens Jan 1st/2nd — data starting the same day shows thin, not disabled.
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
    // Other presets aren't disabled by "no data" itself — empty state pre-empts them; only 1D reads the log, not a calendar boundary.
    const noData = { today: TODAY, earliest: { positionSet: null }, surface: "account" as Surface };

    for (const range of Object.keys(RANGES) as RangeKey[]) {
      expect(isRangeDisabled(range, noData)).toBe(range === "1d");
    }
  });

  it("offers 1D once anything at all has been observed, however little", () => {
    // Story 13 disables the chip only when the log is empty outright.
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
    expect(window.dates).toEqual([]);
  });

  it("measures its change from the day before the session, never from the session itself", () => {
    // Today's price_daily row converges on the last observation — measuring against it would show every session flat.
    expect(resolveRange("1d", { ...HOUSEHOLD, session: "2026-08-25" }).since).toBe("2026-08-24");
  });

  it("names the latest session it was given, whatever today is", () => {
    const window = resolveRange("1d", { ...HOUSEHOLD, today: "2026-08-30", session: "2026-08-28" });

    expect(window.session).toBe("2026-08-28");
    expect(window.since).toBe("2026-08-27");
  });

  it("falls back to the default preset when nothing has been observed", () => {
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
    expect(encodeRangeCookieValue("1d")).toBe("1d");
    expect(decodeRangeCookieValue("1d")).toEqual({ range: "1d" });
    expect(readChartRange(new Request("https://x/?range=1d"))).toEqual({ range: "1d", explicit: true });

    const request = new Request("https://x/", { headers: { Cookie: "chart_range=1d" } });
    expect(readChartRange(request)).toEqual({ range: "1d", explicit: false });
  });

  it("leaves every other preset resolving exactly as it did", () => {
    const withSession = resolveRange("1m", { ...HOUSEHOLD, session: "2026-08-25" });
    const without = resolveRange("1m", HOUSEHOLD);

    expect(withSession).toEqual(without);
  });
});

/** `until` minus `days` — deliberately not the module's own addDays, so a bug there can't hide behind reuse. */
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

/** Gaps between consecutive sampled dates, ascending. Walked with a carried `previous`, not by index, to avoid noUncheckedIndexedAccess asserts. */
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

    // No decay here — unlike the fixed-count sampler this replaces.
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
    // Every gap exactly one — no off-by-one at the seam from this side.
    expect(gapsOf(dates)).toEqual(Array(SAMPLE_BUDGET - 1).fill(1));
  });

  it("crosses into decay exactly one day past the boundary, with no gap or duplicate at the seam", () => {
    const since = daysBefore(TODAY, SAMPLE_BUDGET);
    const { dates } = spanOf(since, TODAY);

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
    // Ratio solved so decay gaps sum to exactly the span, landing precisely on `since`.
    expect(dates[0]).toBe("2021-08-26");
    expect(dates.at(-1)).toBe(TODAY);

    const gaps = gapsOf(dates);

    // Anchor gap is fixed at one calendar day for every budget-exceeding span, any width.
    expect(gaps.at(-1)).toBe(1);

    // Not monotonic step to step (~1.02 ratio rounds to whole days: 56 pairs increase, 100 equal, 22 decrease) — dense-to-coarse is a quarter-bucket trend, not a pairwise one.
    const bucket = (from: number, to: number) =>
      gaps.slice(from, to).reduce((sum, gap) => sum + gap, 0) / (to - from);
    const quarter = Math.floor(gaps.length / 4);
    expect(bucket(0, quarter)).toBeGreaterThan(bucket(quarter, 2 * quarter));
    expect(bucket(quarter, 2 * quarter)).toBeGreaterThan(bucket(2 * quarter, 3 * quarter));
    expect(bucket(2 * quarter, 3 * quarter)).toBeGreaterThan(bucket(3 * quarter, gaps.length));
  });

  it("decays from `until` itself, not from the real current date, for a window ending in the past", () => {
    const pastUntil = "2020-06-15";
    const since = daysBefore(pastUntil, 900);

    const { dates } = spanOf(since, pastUntil);

    expect(dates.length).toBe(SAMPLE_BUDGET);
    expect(dates[0]).toBe(since);
    expect(dates.at(-1)).toBe(pastUntil);
    expect(gapsOf(dates).at(-1)).toBe(1);
  });

  it("keeps two samples on or after a household's own history on every budget-exceeding preset — the spec 0009 regression", () => {
    // Reported bug: preset boundaries ignore a one-day-old history (only All/Custom measure from earliest) — the sampler is what has to fix this.
    const historyStart = daysBefore(TODAY, 1);
    const earliest = { positionSet: historyStart };

    // 5Y and All regressed the same way, less visibly (spec 0009).
    for (const range of ["1y", "5y", "all"] as RangeKey[]) {
      const { dates } = resolveRange(range, { today: TODAY, earliest, surface: "household" });

      // Two points is the whole bug — one point can't draw a line.
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
    // Bug this fixes: bare `?range=1m` resolves as a whole query string in React Router —
    // dropped `?uploaded=` on the account page.
    expect(rangeSearch(at("?uploaded=42"), "1m")).toBe("?uploaded=42&range=1m");
    // Repeated key, not comma-joined (spec 0013, toOwnerParam) — URLSearchParams reproduces it unchanged, no separator for another serialiser to misread.
    expect(rangeSearch(at("?owner=1&owner=3&sort=value"), "1m")).toBe(
      "?owner=1&owner=3&sort=value&range=1m",
    );
  });

  it("rewrites its own three rather than carrying them, so no preset leaves a custom span behind", () => {
    expect(rangeSearch(at("?range=custom&start=2026-01-01&end=2026-06-30"), "1m")).toBe("?range=1m");
    expect(rangeSearch(at(""), "1y")).toBe("?range=1y");
  });

  it("carries a repeated parameter as many times as the address holds it", () => {
    // URLSearchParams.get would keep one and discard the rest — quietly editing the address.
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

describe("chartWindow: the window and the control block a loader spreads (spec 0015)", () => {
  it("assembles the household's window and control block from a request naming an explicit range", () => {
    const earliest = { positionSet: "2026-06-01" as const, manual: "2020-01-01" as const };
    const shared = { today: TODAY, earliest, session: "2026-08-25" as const, timeZone: "America/New_York" };

    const { resolved, controls } = chartWindow("household", {
      request: new Request("https://x/?range=1y"),
      ...shared,
    });

    // Literal values, not resolveRange(...) — that would test the function against itself; boundary/decay math is covered above.
    expect(resolved.range).toBe("1y");
    expect(resolved.since).toBe("2025-08-26");
    expect(resolved.custom).toBeUndefined();
    expect(resolved.session).toBeUndefined();
    expect(resolved.dates.length).toBe(SAMPLE_BUDGET);
    expect(resolved.dates[0]).toBe("2025-08-26");
    expect(resolved.dates.at(-1)).toBe(TODAY);

    expect(controls).toEqual({
      range: "1y",
      custom: undefined,
      // Off 1D: session stays null here even though one was observed (resolved.session, not shared.session).
      session: null,
      // Literal, not rangeOptions(...) — every preset is on since 2020-01-01 (manual) predates every boundary and 1D has a session.
      rangeOptions: (Object.keys(RANGES) as RangeKey[]).map((key) => ({
        key,
        label: RANGES[key].label,
        disabled: false,
      })),
      // Earlier of the household's two dates (surfaceEarliestDate), not the account's.
      customMin: "2020-01-01",
      customMax: TODAY,
    });
  });

  it("assembles the account's window and control block the same way, off a request naming no range at all", () => {
    const earliest = { positionSet: "2026-06-01" as const };
    const shared = { today: TODAY, earliest, session: null, timeZone: "America/New_York" };

    const { resolved, controls } = chartWindow("account", {
      request: new Request("https://x/"),
      ...shared,
    });

    // Unset ?range= falls back to 1Y, same boundary as the explicit case above (same TODAY).
    expect(resolved.range).toBe(DEFAULT_RANGE);
    expect(resolved.since).toBe("2025-08-26");
    expect(resolved.custom).toBeUndefined();
    expect(resolved.session).toBeUndefined();
    expect(resolved.dates.length).toBe(SAMPLE_BUDGET);
    expect(resolved.dates[0]).toBe("2025-08-26");
    expect(resolved.dates.at(-1)).toBe(TODAY);

    expect(controls).toEqual({
      range: DEFAULT_RANGE,
      custom: undefined,
      session: null,
      // 1D disabled (no session); 3M/YTD/1Y/5Y disabled (before 2026-06-01); 1W/1M land after it; All/Custom never disabled.
      rangeOptions: [
        { key: "1d", label: "1D", disabled: true },
        { key: "1w", label: "1W", disabled: false },
        { key: "1m", label: "1M", disabled: false },
        { key: "3m", label: "3M", disabled: true },
        { key: "ytd", label: "YTD", disabled: true },
        { key: "1y", label: "1Y", disabled: true },
        { key: "5y", label: "5Y", disabled: true },
        { key: "all", label: "All", disabled: false },
        { key: "custom", label: "Custom", disabled: false },
      ],
      // Account's own earliest date — no manual series on this surface to fall back to.
      customMin: "2026-06-01",
      customMax: TODAY,
    });
  });
});
