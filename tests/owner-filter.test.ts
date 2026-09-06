/**
 * Owner filter's decisions about a string (spec 0013, ticket 01). Two are silent when wrong:
 * an id naming nobody must survive parsing (dropping it shows the whole portfolio), and the
 * canonical spelling must be a fixed point (every loader redirects to it — else an infinite loop).
 */
import { describe, expect, it } from "vitest";

import {
  ALL_OWNERS,
  canonicalOwnerSearch,
  isFiltered,
  ownerSearch,
  readOwnerFilter,
  toOwnerParam,
} from "~/lib/owner-filter";

const from = (search: string) => readOwnerFilter(new URLSearchParams(search));

// one row per parse rule; right side is the canonical selection, in canonical order
const PARSES: [address: string, selected: string[], why: string][] = [
  ["?owner=3", ["3"], "a single id, which is what Holdings' old Owner select emitted"],
  ["?owner=1,3", ["1", "3"], "the comma-separated grammar this module still reads, though it no longer emits it"],
  ["?owner=10,9", ["9", "10"], "ordered numerically, not lexicographically"],
  ["?owner=3,1", ["1", "3"], "sorted, so one view has one URL"],
  ["?owner=3,3", ["3"], "de-duplicated"],
  ["?owner=03,3", ["3"], "leading zeros stripped before de-duplication, so this is one owner"],
  ["?owner=000", ["0"], "an id of only zeros keeps one, and no person has id 0"],
  ["?owner=0", ["0"], "id zero is kept and matches nothing, rather than becoming empty"],
  ["?owner=1, 3", ["1", "3"], "whitespace around a separator is trimmed, not kept"],
  ["?owner=1,,3", ["1", "3"], "an empty segment is skipped, not kept"],
  ["?owner=", [], "an empty value is the household"],
  ["?owner=,,", [], "a value of only separators is the household"],
  ["?sort=value", [], "a missing parameter is the household"],
  ["?owner=999999999", ["999999999"], "an id naming nobody is kept, and narrows to nothing"],
  [
    "?owner=1234567890123456789012345",
    ["1234567890123456789012345"],
    "a 25-digit id survives parsing; refusing it is the predicate's job",
  ],
  ["?owner=alice", ["alice"], "an id that is not digits at all is kept, and matches nothing"],
  ["?owner=2,alice,1", ["1", "2", "alice"], "digit ids first, in numeric order; the rest after"],
  ["?owner=1&owner=3", ["1", "3"], "a repeated parameter contributes both, rather than one"],
  ["?owner=&owner=3", ["3"], "an empty first value does not swallow the id after it"],
  ["?owner=a%26b", ["a&b"], "a decoded ampersand is one id, and must not become two parameters"],
  ["?owner=a+b", ["a b"], "a plus decodes to a space, and the id keeps it"],
  ["?owner=1%2C3", ["1", "3"], "a percent-encoded separator is still the separator"],
  ["?owner=o'brien", ["o'brien"], "an apostrophe id is kept — the character the fixed-point test below singles out"],
  ["?owner=100%25", ["100%"], "a percent sign survives, and must survive being spelled again"],
  ["?owner=%C3%A9", ["é"], "a non-ASCII id is kept, sorted after the digits"],
];

describe("reading the filter off an address", () => {
  for (const [address, selected, why] of PARSES) {
    it(`reads ${address} as [${selected.join(", ")}] — ${why}`, () => {
      expect(from(address)).toEqual(selected);
    });
  }

  it("treats an absent parameter and an empty one as the same household", () => {
    // toBe not toEqual: ALL_OWNERS is one frozen instance — a caller mutating it throws
    // rather than silently corrupting every screen
    expect(from("")).toBe(ALL_OWNERS);
    expect(from("?owner=")).toBe(ALL_OWNERS);
    expect(isFiltered(from("?owner="))).toBe(false);
    expect(isFiltered(from("?owner=3"))).toBe(true);
  });

  it("orders a selection mixing digit and non-digit ids the same way whichever way it arrives", () => {
    // comparator never calls Number() — Number(a)-Number(b) returns NaN for "alice", leaving order undefined
    expect(from("?owner=alice,10,bob,9")).toEqual(from("?owner=bob,9,alice,10"));
    expect(from("?owner=alice,10,bob,9")).toEqual(["9", "10", "alice", "bob"]);
  });

  it("produces a filter rather than an error for anything a hand can type", () => {
    expect(() => from("?owner=%20or%201=1")).not.toThrow();
    expect(() => from("?owner=-1")).not.toThrow();
    expect(from("?owner=-1")).toEqual(["-1"]);
  });
});

describe("the canonical spelling", () => {
  it("is idempotent for every address the table above covers", () => {
    // non-fixed-point canonicalisation redirects forever, unnoticed until a reader hits it
    for (const [address] of PARSES) {
      const once = from(address);
      expect(from(ownerSearch(once))).toEqual(once);
      expect(toOwnerParam(from(ownerSearch(once)))).toBe(toOwnerParam(once));
    }
  });

  it("encodes each id, so an id carrying a separator cannot become a second parameter", () => {
    // without encoding, ownerSearch(["a&b"]) becomes "?owner=a&b" — an id injecting a new parameter
    expect(ownerSearch(["a&b"])).toBe("?owner=a%26b");
    expect(from(ownerSearch(["a&b"]))).toEqual(["a&b"]);

    // repeated key, no separator — sidesteps the comma vs %2C disagreement entirely
    expect(ownerSearch(["1", "3"])).toBe("?owner=1&owner=3");
  });

  it("canonicalises what it is handed, so an unsorted filter has no second spelling", () => {
    expect(toOwnerParam(["3", "1"])).toBe("owner=1&owner=3");
    expect(toOwnerParam(["3", "3"])).toBe("owner=3");
  });

  it("carries no owner parameter at all when the filter is off", () => {
    expect(toOwnerParam(ALL_OWNERS)).toBe("");
    expect(ownerSearch(ALL_OWNERS)).toBe("");
  });

  it("spells a selection as a repeated key, with and without the question mark", () => {
    // two functions, not one: toSearch (holdings-view.ts) already returns a leading "?"; composing both would double it
    expect(toOwnerParam(["1", "3"])).toBe("owner=1&owner=3");
    expect(ownerSearch(["1", "3"])).toBe("?owner=1&owner=3");
  });

  it("hands a loader the address to redirect to, with the rest of the query kept", () => {
    const canonical = (search: string) => canonicalOwnerSearch(new URLSearchParams(search));

    // unchanged = no redirect; repeated-key spelling is already canonical
    expect(canonical("?owner=1&owner=3")).toBe("?owner=1&owner=3");
    expect(canonical("?range=1m")).toBe("?range=1m");
    expect(canonical("")).toBe("");

    // every second spelling (including the comma grammar readOwnerFilter still accepts) settles
    // in one hop, never refused
    expect(canonical("?owner=3,1")).toBe("?owner=1&owner=3");
    expect(canonical("?owner=3,3")).toBe("?owner=3");
    expect(canonical("?owner=1,3")).toBe("?owner=1&owner=3");
    // percent-encoded separator too — indistinguishable from the literal one if computed from decoded values
    expect(canonical("?owner=1%2C3")).toBe("?owner=1&owner=3");
    // unfiltered screen's spelling is no parameter at all; an empty one is a second URL for the same view
    expect(canonical("?owner=")).toBe("");

    // rest of the address is kept, owner leads it — ownerSearch alone would drop the custom range
    expect(canonical("?range=custom&start=2026-01-01&owner=3,1")).toBe(
      "?owner=1&owner=3&range=custom&start=2026-01-01",
    );
  });

  it("is a fixed point, for every address the table covers", () => {
    for (const [address] of PARSES) {
      const once = canonicalOwnerSearch(new URLSearchParams(address));

      expect(canonicalOwnerSearch(new URLSearchParams(once))).toBe(once);
    }

    for (const search of ["?range=1m&owner=3,1", "?owner=1%2C3&sort=value", "?a=1&owner=&b=2"]) {
      const once = canonicalOwnerSearch(new URLSearchParams(search));

      expect(canonicalOwnerSearch(new URLSearchParams(once))).toBe(once);
    }
  });

  it("is a fixed point of both serialisers a canonical address is put through, which is what lets a loader compare with strict equality", () => {
    // two round trips: new URL() mirrors what url.search already went through once; new
    // URLSearchParams() mirrors react-router's callRouteHandler rebuilding the request (see
    // toOwnerParam's doc). A speller fixed in only one loop misses characters the two
    // serialisers spell differently (apostrophe vs ~ ! ( ) space).
    const arrivesAsItself = (canonical: string) => {
      expect(new URL(`http://portfolio.test/${canonical}`).search).toBe(canonical);
      // "" has no leading "?" to strip/restore — exempted rather than accidentally passing
      if (canonical !== "") {
        expect(`?${new URLSearchParams(canonical.slice(1))}`).toBe(canonical);
      }
    };

    for (const [address] of PARSES) {
      arrivesAsItself(canonicalOwnerSearch(new URLSearchParams(address)));
    }

    // ids readOwnerFilter keeps on purpose, plus ones the two serialisers spell differently:
    // ~!() and space (form), apostrophe (URL parser), *+%/non-ASCII (both, differently);
    // "03" and a 25-digit id per the same reasons owner-reading.server.ts keeps them.
    for (const id of [
      "o'brien",
      "a b",
      "a&b",
      "100%",
      "é",
      "''",
      "1",
      "~",
      "!",
      "(",
      ")",
      "*",
      "+",
      "%",
      "03",
      "1234567890123456789012345",
    ]) {
      arrivesAsItself(ownerSearch([id]));
    }

    arrivesAsItself(ownerSearch(["o'brien", "1", "3"]));
    arrivesAsItself(canonicalOwnerSearch(new URLSearchParams("?owner=o'brien&range=1m")));
  });
});

describe("carrying the filter to another screen", () => {
  it("emits the owner parameter alone, never the screen it came from", () => {
    // whole location.search would drag range/sort/edit onto a screen that doesn't own them
    const holdings = "?group=owner&sort=value&dir=asc&owner=3&edit=1:2&saved=1";

    expect(ownerSearch(from(holdings))).toBe("?owner=3");
  });

  it("emits nothing at all from an unfiltered screen, so a nav target stays a bare path", () => {
    expect(ownerSearch(from("?range=custom&start=2026-01-01&end=2026-06-30"))).toBe("");
  });
});
