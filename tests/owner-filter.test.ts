/**
 * The owner filter's decisions about a string (spec 0013, ticket 01).
 *
 * Pure — no Postgres and no render — for `chart-range.test.ts`'s reason: the
 * awkward parts of this feature are all decisions about a query parameter, and
 * each one is a fixture here or a bug found later on four screens at once.
 *
 * Two of them are worth naming, because both are silent when wrong. Nothing is
 * ever dropped: an id naming nobody has to survive parsing and empty the
 * screen, because dropping it would show the whole portfolio to someone who
 * asked for a slice of it. And the canonical spelling has to be a fixed point:
 * every loader redirects a non-canonical `owner` to the canonical one, so a
 * canonicalisation that is not idempotent is an infinite redirect loop nobody
 * sees until they open the screen.
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

/** The filter a screen would resolve from this address. */
const from = (search: string) => readOwnerFilter(new URLSearchParams(search));

/**
 * Every parse rule as one table, so a new one is a row rather than a block.
 * The right-hand side is the canonical selection, in canonical order.
 */
const PARSES: [address: string, selected: string[], why: string][] = [
  ["?owner=3", ["3"], "a single id, which is what Holdings' old Owner select emitted"],
  ["?owner=1,3", ["1", "3"], "the comma-separated grammar this slice adds"],
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
    // `toBe`, not `toEqual`: the unfiltered answer is the one frozen instance,
    // so a caller that casts the readonly away and mutates it throws rather
    // than quietly rewriting what every other screen reads.
    expect(from("")).toBe(ALL_OWNERS);
    expect(from("?owner=")).toBe(ALL_OWNERS);
    expect(isFiltered(from("?owner="))).toBe(false);
    expect(isFiltered(from("?owner=3"))).toBe(true);
  });

  it("orders a selection mixing digit and non-digit ids the same way whichever way it arrives", () => {
    // Deterministic because the comparator never calls `Number()`. A
    // `Number(a) - Number(b)` comparator answers NaN for "alice", which leaves
    // `sort` free to return either spelling and the canonical one undefined.
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
    // The string every loader redirects *to*. A canonicalisation that is not a
    // fixed point redirects forever, and nothing catches it before a reader does.
    for (const [address] of PARSES) {
      const once = from(address);
      expect(from(ownerSearch(once))).toEqual(once);
      expect(toOwnerParam(from(ownerSearch(once)))).toBe(toOwnerParam(once));
    }
  });

  it("encodes each id, so an id carrying a separator cannot become a second parameter", () => {
    // Without the encode, `ownerSearch(["a&b"])` is `?owner=a&b` — an id
    // injecting a parameter into the address a loader is about to redirect to.
    expect(ownerSearch(["a&b"])).toBe("?owner=a%26b");
    expect(from(ownerSearch(["a&b"]))).toEqual(["a&b"]);

    // The separator itself stays literal, because a canonical generator that
    // spelled it `%2C` would disagree with `toSearch` on every Holdings link.
    expect(ownerSearch(["1", "3"])).toBe("?owner=1,3");
  });

  it("canonicalises what it is handed, so an unsorted filter has no second spelling", () => {
    expect(toOwnerParam(["3", "1"])).toBe("owner=1,3");
    expect(toOwnerParam(["3", "3"])).toBe("owner=3");
  });

  it("carries no owner parameter at all when the filter is off", () => {
    expect(toOwnerParam(ALL_OWNERS)).toBe("");
    expect(ownerSearch(ALL_OWNERS)).toBe("");
  });

  it("spells a selection as one comma-separated parameter, with and without the question mark", () => {
    // Two functions rather than one: `toSearch` in `holdings-view.ts` already
    // returns its string *with* a `?`, and composing two such strings gives
    // `?sort=value&?owner=1`.
    expect(toOwnerParam(["1", "3"])).toBe("owner=1,3");
    expect(ownerSearch(["1", "3"])).toBe("?owner=1,3");
  });

  it("hands a loader the address to redirect to, with the rest of the query kept", () => {
    const canonical = (search: string) => canonicalOwnerSearch(new URLSearchParams(search));

    // Unchanged means no redirect.
    expect(canonical("?owner=1,3")).toBe("?owner=1,3");
    expect(canonical("?range=1m")).toBe("?range=1m");
    expect(canonical("")).toBe("");

    // Every second spelling of one view resolves to the first.
    expect(canonical("?owner=3,1")).toBe("?owner=1,3");
    expect(canonical("?owner=3,3")).toBe("?owner=3");
    expect(canonical("?owner=1&owner=3")).toBe("?owner=1,3");
    // Including the percent-encoded separator, which a verdict computed from
    // the decoded values could not have told apart from the literal one.
    expect(canonical("?owner=1%2C3")).toBe("?owner=1,3");
    // The unfiltered screen's spelling is no parameter at all, so an empty one
    // is a second URL for a view that already has one.
    expect(canonical("?owner=")).toBe("");

    // The rest of the address is kept, and the owner parameter leads it. A
    // target built from `ownerSearch` alone would drop a custom chart range.
    expect(canonical("?range=custom&start=2026-01-01&owner=3,1")).toBe(
      "?owner=1,3&range=custom&start=2026-01-01",
    );
  });

  it("is a fixed point, for every address the table covers", () => {
    // A canonical address that is not one is an infinite redirect, and nothing
    // notices until a reader opens the screen.
    for (const [address] of PARSES) {
      const once = canonicalOwnerSearch(new URLSearchParams(address));

      expect(canonicalOwnerSearch(new URLSearchParams(once))).toBe(once);
    }

    for (const search of ["?range=1m&owner=3,1", "?owner=1%2C3&sort=value", "?a=1&owner=&b=2"]) {
      const once = canonicalOwnerSearch(new URLSearchParams(search));

      expect(canonicalOwnerSearch(new URLSearchParams(once))).toBe(once);
    }
  });
});

describe("carrying the filter to another screen", () => {
  it("emits the owner parameter alone, never the screen it came from", () => {
    // The whole `location.search` would drag `range`, `sort` and a half-typed
    // `edit` row key onto a screen that does not own any of them.
    const holdings = "?group=owner&sort=value&dir=asc&owner=3&edit=1:2&saved=1";

    expect(ownerSearch(from(holdings))).toBe("?owner=3");
  });

  it("emits nothing at all from an unfiltered screen, so a nav target stays a bare path", () => {
    expect(ownerSearch(from("?range=custom&start=2026-01-01&end=2026-06-30"))).toBe("");
  });
});
