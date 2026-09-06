/** The two pure pieces the "Refresh now" control stands on: the stamp it renders and the guard
 * on where a press may send the browser back to. */
import { describe, expect, it } from "vitest";

import { marketStampOf } from "../app/lib/market-hours.ts";
import { safeReturn } from "../app/lib/return-path.ts";

const NEW_YORK = "America/New_York";

describe("the as-of stamp", () => {
  it("names the zone the close was filed under, and follows it across the DST boundary", () => {
    // same wall-clock close, six months apart — a fixed offset would print one an hour out
    expect(marketStampOf(new Date("2026-08-28T20:00:00Z"), NEW_YORK)).toBe(
      "28 Aug 2026, 4:00 PM EDT",
    );
    expect(marketStampOf(new Date("2026-12-18T21:00:00Z"), NEW_YORK)).toBe(
      "18 Dec 2026, 4:00 PM EST",
    );
  });

  it("reads an evening instant as that evening rather than the next UTC day", () => {
    // 21:30 NY on the 5th = 01:30 UTC on the 6th — a UTC caption would date this a day ahead of its price_daily row
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
    // the trap a startsWith("/") guard walks into — WHATWG still resolves a backslash off-site for a special scheme
    expect(safeReturn("/\\evil.test")).toBe("/");
    expect(safeReturn("/\\/evil.test")).toBe("/");
  });

  it("refuses an absolute or protocol-relative destination", () => {
    expect(safeReturn("//evil.test")).toBe("/");
    expect(safeReturn("https://evil.test/holdings")).toBe("/");
  });

  // origin check alone passes all of these: a "." or ".." segment contributes nothing, so the empty
  // segment after it becomes the path's first, resolving to a pathname a browser reads as a host.
  it.each([
    "/..//evil.test",
    "/%2e%2e//evil.test",
    "/.//evil.test",
    "/a/..//evil.test",
    "/..\\/evil.test",
    "/..//",
  ])(
    "refuses %j, which resolves to this origin and still serialises with a leading // a browser reads as a host",
    (to) => {
      expect(safeReturn(to)).toBe("/");
    },
  );

  it("answers with the Overview for a missing or unparseable destination", () => {
    expect(safeReturn(null)).toBe("/");
    expect(safeReturn("")).toBe("/");
  });
});
