/**
 * The market calendar, and the date a quote belongs to.
 *
 * These are the only tests in the pricing slice that need no database, because
 * the module needs no clock and no configuration of its own — every case states
 * its own instant and its own zone.
 *
 * The cases worth protecting are the ones where a plausible implementation
 * differs from a correct one: the two days a year the offset moves, the evening
 * NAV that is already tomorrow in UTC, and the difference between "no session"
 * and "no row".
 */
import { describe, expect, it } from "vitest";

import { isMarketOpen, marketDateOf } from "~/lib/market-hours";

const NEW_YORK = "America/New_York";

/** An instant, written the way a reader can check it: UTC, explicitly. */
const at = (iso: string): Date => new Date(iso);

describe("the trading date a quote belongs to", () => {
  it("reads the market's calendar day, not UTC's", () => {
    // 21:30 UTC on the 5th is 16:30 in New York on the 5th — same day either
    // way, so this case alone would not catch a UTC implementation.
    expect(marketDateOf(at("2026-06-05T21:30:00Z"), NEW_YORK)).toBe("2026-06-05");
  });

  it("keeps an evening mutual fund NAV on the day it was struck", () => {
    // 01:30 UTC on the 6th is 21:30 on the 5th in New York. A UTC reading files
    // this under the 6th, where the 6th's real close then overwrites it and the
    // NAV is gone. This is the case the whole `marketDateOf` seam exists for.
    expect(marketDateOf(at("2026-06-06T01:30:00Z"), NEW_YORK)).toBe("2026-06-05");
  });

  it("follows the offset across a daylight-saving boundary", () => {
    // 2026-11-01 is the US fall-back. 04:30 UTC is 00:30 EDT on the 1st; a
    // fixed -5 offset would say 23:30 on October the 31st.
    expect(marketDateOf(at("2026-11-01T04:30:00Z"), NEW_YORK)).toBe("2026-11-01");
    // And in March, after the spring-forward: 2026-03-08 07:30 UTC is 03:30 EDT
    // on the 8th under the real rules, but 02:30 EST under a fixed -5 — both
    // still the 8th, so the discriminating case is the hour, not the date.
    // 2026-03-09T04:30Z is 00:30 EDT on the 9th, and 23:30 on the 8th under a
    // fixed -5. That one tells the two apart.
    expect(marketDateOf(at("2026-03-09T04:30:00Z"), NEW_YORK)).toBe("2026-03-09");
  });

  it("answers in the zone it is given, not a hardcoded one", () => {
    expect(marketDateOf(at("2026-06-06T01:30:00Z"), "UTC")).toBe("2026-06-06");
  });
});

describe("whether the session is running", () => {
  it("is open inside regular hours on a weekday", () => {
    // 14:30 UTC = 10:30 EDT, a Friday.
    expect(isMarketOpen(at("2026-06-05T14:30:00Z"), NEW_YORK)).toBe(true);
  });

  it("is shut before the opening bell and at the closing one", () => {
    // 13:29 UTC = 09:29 EDT, one minute early.
    expect(isMarketOpen(at("2026-06-05T13:29:00Z"), NEW_YORK)).toBe(false);
    // 20:00 UTC = 16:00 EDT. The close is the end of the session, not part of it.
    expect(isMarketOpen(at("2026-06-05T20:00:00Z"), NEW_YORK)).toBe(false);
  });

  it("is open at the opening bell itself", () => {
    // 13:30 UTC = 09:30 EDT exactly — the `>=` boundary, which a `>` would miss.
    expect(isMarketOpen(at("2026-06-05T13:30:00Z"), NEW_YORK)).toBe(true);
  });

  it("is shut in the small hours", () => {
    // 04:00 UTC is midnight EDT. Worth stating because midnight is where the
    // `h23` pin in `partsIn` matters: an engine formatting it as "24" would
    // compute 1440 minutes rather than 0. Both readings are shut, so this
    // asserts the behaviour rather than the pin — the pin is there so that no
    // future window arithmetic inherits a 24 it did not expect.
    expect(isMarketOpen(at("2026-06-05T04:00:00Z"), NEW_YORK)).toBe(false);
  });

  it("is shut at the weekend", () => {
    // 2026-06-06 is a Saturday, 2026-06-07 a Sunday — both inside what would
    // otherwise be session hours.
    expect(isMarketOpen(at("2026-06-06T14:30:00Z"), NEW_YORK)).toBe(false);
    expect(isMarketOpen(at("2026-06-07T14:30:00Z"), NEW_YORK)).toBe(false);
  });

  it("is shut on a hardcoded NYSE holiday", () => {
    // Good Friday 2026, a weekday inside session hours.
    expect(isMarketOpen(at("2026-04-03T14:30:00Z"), NEW_YORK)).toBe(false);
    // Thanksgiving 2026.
    expect(isMarketOpen(at("2026-11-26T15:00:00Z"), NEW_YORK)).toBe(false);
    // Independence Day 2026 falls on a Saturday and is observed on the 3rd.
    expect(isMarketOpen(at("2026-07-03T14:30:00Z"), NEW_YORK)).toBe(false);
  });

  it("is open on the day either side of a holiday", () => {
    // Guards against a holiday entry that is a day out — the failure mode a
    // hand-maintained table actually has.
    expect(isMarketOpen(at("2026-04-02T14:30:00Z"), NEW_YORK)).toBe(true);
    expect(isMarketOpen(at("2026-11-27T15:00:00Z"), NEW_YORK)).toBe(true);
  });
});
