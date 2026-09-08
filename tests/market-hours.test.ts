import { describe, expect, it } from "vitest";

import { isMarketOpen, isScheduledQuoteWindow, marketDateOf } from "~/lib/market-hours";

const NEW_YORK = "America/New_York";

const at = (iso: string): Date => new Date(iso);

describe("the trading date a quote belongs to", () => {
  it("reads the market's calendar day, not UTC's", () => {
    // 21:30 UTC = 16:30 NY same day — alone wouldn't catch a UTC implementation
    expect(marketDateOf(at("2026-06-05T21:30:00Z"), NEW_YORK)).toBe("2026-06-05");
  });

  it("keeps an evening mutual fund NAV on the day it was struck", () => {
    // 01:30 UTC = 21:30 prior day NY; a UTC reading lets the next close overwrite it
    expect(marketDateOf(at("2026-06-06T01:30:00Z"), NEW_YORK)).toBe("2026-06-05");
  });

  it("follows the offset across a daylight-saving boundary", () => {
    // 2026-11-01 US fall-back: 04:30 UTC = 00:30 EDT; fixed -5 would say Oct 31
    expect(marketDateOf(at("2026-11-01T04:30:00Z"), NEW_YORK)).toBe("2026-11-01");
    // 2026-03-09 spring-forward: 04:30 UTC = 00:30 EDT vs 23:30 under fixed -5
    expect(marketDateOf(at("2026-03-09T04:30:00Z"), NEW_YORK)).toBe("2026-03-09");
  });

  it("answers in the zone it is given, not a hardcoded one", () => {
    expect(marketDateOf(at("2026-06-06T01:30:00Z"), "UTC")).toBe("2026-06-06");
  });
});

describe("whether the session is running", () => {
  it("is open inside regular hours on a weekday", () => {
    // 14:30 UTC = 10:30 EDT, a Friday
    expect(isMarketOpen(at("2026-06-05T14:30:00Z"), NEW_YORK)).toBe(true);
  });

  it("is shut before the opening bell and at the closing one", () => {
    // 13:29 UTC = 09:29 EDT, one minute early
    expect(isMarketOpen(at("2026-06-05T13:29:00Z"), NEW_YORK)).toBe(false);
    // 20:00 UTC = 16:00 EDT — close ends the session, not part of it
    expect(isMarketOpen(at("2026-06-05T20:00:00Z"), NEW_YORK)).toBe(false);
  });

  it("is open at the opening bell itself", () => {
    // 13:30 UTC = 09:30 EDT exactly — the `>=` boundary a `>` would miss
    expect(isMarketOpen(at("2026-06-05T13:30:00Z"), NEW_YORK)).toBe(true);
  });

  it("is shut in the small hours", () => {
    // 04:00 UTC = midnight EDT — the h23 pin in partsIn matters here, else "24" reads as 1440min not 0
    expect(isMarketOpen(at("2026-06-05T04:00:00Z"), NEW_YORK)).toBe(false);
  });

  it("is shut at the weekend", () => {
    // 2026-06-06 Sat, 2026-06-07 Sun — both inside otherwise-open hours
    expect(isMarketOpen(at("2026-06-06T14:30:00Z"), NEW_YORK)).toBe(false);
    expect(isMarketOpen(at("2026-06-07T14:30:00Z"), NEW_YORK)).toBe(false);
  });

  it("is shut on a hardcoded NYSE holiday", () => {
    // Good Friday 2026
    expect(isMarketOpen(at("2026-04-03T14:30:00Z"), NEW_YORK)).toBe(false);
    // Thanksgiving 2026
    expect(isMarketOpen(at("2026-11-26T15:00:00Z"), NEW_YORK)).toBe(false);
    // Independence Day 2026 falls Saturday, observed the 3rd
    expect(isMarketOpen(at("2026-07-03T14:30:00Z"), NEW_YORK)).toBe(false);
  });

  it("is open on the day either side of a holiday", () => {
    // catches an off-by-one holiday entry, the real failure mode of a hand-maintained table
    expect(isMarketOpen(at("2026-04-02T14:30:00Z"), NEW_YORK)).toBe(true);
    expect(isMarketOpen(at("2026-11-27T15:00:00Z"), NEW_YORK)).toBe(true);
  });
});

describe("the scheduled quote window", () => {
  it("starts fifteen minutes before the opening bell", () => {
    expect(isScheduledQuoteWindow(at("2026-06-05T13:14:00Z"), NEW_YORK)).toBe(false);
    expect(isScheduledQuoteWindow(at("2026-06-05T13:15:00Z"), NEW_YORK)).toBe(true);
  });

  it("ends fifteen minutes after the closing bell", () => {
    expect(isScheduledQuoteWindow(at("2026-06-05T20:15:00Z"), NEW_YORK)).toBe(true);
    expect(isScheduledQuoteWindow(at("2026-06-05T20:16:00Z"), NEW_YORK)).toBe(false);
  });

  it("still excludes weekends and holidays", () => {
    expect(isScheduledQuoteWindow(at("2026-06-06T14:30:00Z"), NEW_YORK)).toBe(false);
    expect(isScheduledQuoteWindow(at("2026-11-26T15:00:00Z"), NEW_YORK)).toBe(false);
  });
});
