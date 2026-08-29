/**
 * The two pure pieces the "Refresh now" control stands on: the stamp it renders
 * and the guard on where a press may send the browser back to.
 */
import { describe, expect, it } from "vitest";

import { marketStampOf } from "../app/lib/market-hours.ts";
import { safeReturn } from "../app/lib/return-path.ts";

const NEW_YORK = "America/New_York";

describe("the as-of stamp", () => {
  it("names the zone the close was filed under, and follows it across the DST boundary", () => {
    // The same wall-clock close, six months apart. A fixed offset would print
    // one of these an hour out; the abbreviation is what makes it checkable at
    // a glance rather than a subtraction the reader has to trust.
    expect(marketStampOf(new Date("2026-08-28T20:00:00Z"), NEW_YORK)).toBe(
      "28 Aug 2026, 4:00 PM EDT",
    );
    expect(marketStampOf(new Date("2026-12-18T21:00:00Z"), NEW_YORK)).toBe(
      "18 Dec 2026, 4:00 PM EST",
    );
  });

  it("reads an evening instant as that evening rather than the next UTC day", () => {
    // 21:30 New York on the 5th is 01:30 UTC on the 6th. A caption taken off the
    // UTC clock would date this a day ahead of the `price_daily` row the same
    // instant is filed under.
    expect(marketStampOf(new Date("2026-06-06T01:30:00Z"), NEW_YORK)).toBe(
      "5 Jun 2026, 9:30 PM EDT",
    );
  });
});

describe("where a press may send the browser", () => {
  it("keeps a path of ours, with its query string", () => {
    expect(safeReturn("/holdings?group=account&sort=value")).toBe(
      "/holdings?group=account&sort=value",
    );
  });

  it("refuses a backslash the URL parser reads as a slash", () => {
    // The trap a `startsWith("/")` guard walks into: one forward slash, and the
    // WHATWG parser still resolves it off-site for a special scheme.
    expect(safeReturn("/\\evil.test")).toBe("/");
    expect(safeReturn("/\\/evil.test")).toBe("/");
  });

  it("refuses an absolute or protocol-relative destination", () => {
    expect(safeReturn("//evil.test")).toBe("/");
    expect(safeReturn("https://evil.test/holdings")).toBe("/");
  });

  it("answers with the Overview for a missing or unparseable destination", () => {
    expect(safeReturn(null)).toBe("/");
    expect(safeReturn("")).toBe("/");
  });
});
