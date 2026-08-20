/**
 * The Holdings screen's table — what it shows, in what order, and what the
 * figures under it come to (DESIGN.md §8.1).
 *
 * No database. `app/lib/holdings-view.ts` is pure by design, for the reason
 * `allocation.ts` gives about itself: the screen renders its rows and its
 * subtotals from one array, so agreement between them is structural rather than
 * something to keep true. That makes these unit tests over a fixture function
 * rather than a fixture builder, and they run without Postgres.
 *
 * Four things are being pinned, and only one of them is the obvious one.
 *
 * The grouping and the filtering are the obvious one. The second is the
 * arithmetic: every money assertion is an exact decimal string, including the
 * cases a float gets wrong, because `money.ts` is now the one module in the
 * application that adds money outside SQL and being exact is its whole
 * justification. The third is the sort, which is where a plausible
 * implementation quietly fails — comparing `"9.0000"` against `"10.0000"` as
 * strings puts the ninth-largest holding at the top of a column sorted by
 * value, and it looks right until you read it.
 *
 * The fourth is the honesty rule the whole screen stands on: an unknown is
 * never a zero. A null cost basis reports no gain rather than a gain equal to
 * the entire untracked position; a group nobody can price is worth `null`
 * rather than nothing; and a filter that matched no rows is a different state
 * from a portfolio with no rows in it.
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_DIRECTION,
  DEFAULT_SORT,
  applyFilters,
  availableFilters,
  formatQuantity,
  groupHoldings,
  holdingNote,
  parseQuery,
  parseRowKey,
  rowKey,
  sortHoldings,
  summarise,
  toSearch,
} from "~/lib/holdings-view";

import type { ValuedHolding } from "~/lib/valuation.server";

let sequence = 0;

/**
 * One row shaped as `holding_valued` would have produced it.
 *
 * `isPriced` is derived rather than passed, exactly as in `allocation.test.ts`:
 * the view cannot emit a row where a null value and a true `is_priced`
 * disagree, so deriving it keeps a test from asserting on a row the database
 * could never hand over.
 */
function holding(overrides: Partial<ValuedHolding> = {}): ValuedHolding {
  const merged: ValuedHolding = {
    accountId: "1",
    accountName: "Taxable",
    institution: "Fidelity",
    accountKind: "brokerage",
    taxTreatment: "taxable",
    ownerId: "1",
    ownerName: "Alice",
    instrumentId: String((sequence += 1)),
    symbol: "VTI",
    instrumentName: "Vanguard Total Stock Market ETF",
    classification: "US equity",
    assetClass: "equity",
    quantity: "1.00000000",
    price: "1.0000",
    value: "1.0000",
    costBasisPerShare: null,
    costBasis: null,
    unrealized: null,
    isPriced: true,
    isStale: false,
    ...overrides,
  };

  return {
    ...merged,
    price: merged.value === null ? null : merged.price,
    isPriced: merged.value !== null,
  };
}

/** The query a bare `/holdings` produces, for tests that only vary one thing. */
function query(search = "") {
  return parseQuery(new URLSearchParams(search));
}

describe("parseQuery", () => {
  it("defaults to everything, ungrouped, biggest position first", () => {
    const parsed = query();

    expect(parsed.filters.size).toBe(0);
    expect(parsed.group).toBeNull();
    expect(parsed.sort).toBe(DEFAULT_SORT);
    expect(parsed.direction).toBe(DEFAULT_DIRECTION);
  });

  it("reads every dimension, the grouping and the sort", () => {
    const parsed = query("owner=2&institution=Vanguard&group=kind&sort=quantity&dir=asc");

    expect(parsed.filters.get("owner")).toBe("2");
    expect(parsed.filters.get("institution")).toBe("Vanguard");
    expect(parsed.group).toBe("kind");
    expect(parsed.sort).toBe("quantity");
    expect(parsed.direction).toBe("asc");
  });

  it("ignores a parameter it does not recognise rather than failing on it", () => {
    // A stale bookmark, a hand-edited URL and a crawler all land here. None of
    // them should produce an error page; they produce the unfiltered table.
    const parsed = query("group=favourite&sort=vibes&dir=sideways&colour=blue");

    expect(parsed.group).toBeNull();
    expect(parsed.sort).toBe(DEFAULT_SORT);
    expect(parsed.direction).toBe(DEFAULT_DIRECTION);
    expect(parsed.filters.size).toBe(0);
  });

  it("treats an empty select as `all`, not as a filter for the empty key", () => {
    // This is what a GET form submits for a `<select>` nobody touched.
    expect(query("owner=&kind=").filters.size).toBe(0);
  });

  it("keeps a filter key no holding carries", () => {
    // Dropping it would silently widen the request: someone who asked for one
    // account would be shown the whole portfolio. It survives, and renders as
    // an empty result that says so.
    expect(query("account=999").filters.get("account")).toBe("999");
  });
});

describe("toSearch", () => {
  it("omits the defaults, so the unfiltered table's URL is bare", () => {
    expect(toSearch(query())).toBe("");
  });

  it("round-trips a view", () => {
    const search = "owner=2&institution=Vanguard&group=kind&sort=quantity&dir=asc";

    expect(toSearch(query(search))).toBe(`?${search}`);
  });

  it("is a fixed point, so the route's canonical redirect cannot loop", () => {
    // The route bounces to `toSearch(parseQuery(search))` whenever the incoming
    // URL differs from it — which is every time the filter form submits, since
    // a GET form sends `&kind=&tax=` for the selects nobody touched. If a
    // second pass could change the string again, that bounce would be a
    // redirect loop rather than a tidy-up.
    for (const messy of [
      "owner=1&account=&institution=&kind=&tax=&classification=&assetClass=",
      "sort=value&dir=desc&group=",
      "colour=blue&owner=2",
      "",
    ]) {
      const once = toSearch(query(messy));

      expect(toSearch(query(once))).toBe(once);
    }
  });
});

describe("availableFilters", () => {
  it("does not offer a filter that cannot discriminate", () => {
    // One person, one brokerage: those are facts about the household, not
    // choices, and a select implying otherwise costs more than it saves
    // (DESIGN.md §13.7).
    const controls = availableFilters(
      [holding({ classification: "US equity" }), holding({ classification: "Bonds" })],
      query(),
    );

    expect(controls.map((control) => control.id)).toEqual(["classification"]);
  });

  it("offers every dimension the data really varies on", () => {
    const controls = availableFilters(
      [
        holding({ ownerId: "1", ownerName: "Alice", institution: "Fidelity" }),
        holding({ ownerId: "2", ownerName: "Bob", institution: "Vanguard" }),
      ],
      query(),
    );

    expect(controls.map((control) => control.id)).toEqual(["owner", "institution"]);
  });

  it("builds its options from the holdings, never from the enumeration", () => {
    // A household with no Roth account is not offered "Tax-free": choosing it
    // could only ever produce an empty table.
    const [tax] = availableFilters(
      [
        holding({ taxTreatment: "taxable" }),
        holding({ taxTreatment: "tax_deferred" }),
      ],
      query(),
    ).filter((control) => control.id === "tax");

    expect(tax?.options.map((option) => option.value)).toEqual(["tax_deferred", "taxable"]);
  });

  it("keeps a selected filter drawn even once it has narrowed to one value", () => {
    // Otherwise the control you narrowed with vanishes and there is no way back.
    const rows = [holding({ institution: "Fidelity" })];
    const controls = availableFilters(rows, query("institution=Fidelity"));

    expect(controls.map((control) => control.id)).toEqual(["institution"]);
    expect(controls[0]?.selected).toBe("Fidelity");
  });

  it("gives a selected key nothing carries an option of its own", () => {
    // Otherwise `defaultValue` finds no match, the select falls back to its
    // first option, and every filter reads "All" above an empty table with no
    // clue what was actually filtered.
    const [account] = availableFilters(
      [holding({ accountId: "1" }), holding({ accountId: "2" })],
      query("account=999"),
    ).filter((control) => control.id === "account");

    expect(account?.selected).toBe("999");
    expect(account?.options[0]).toEqual({ value: "999", label: "Not in this portfolio" });
    // And it is flagged, so the empty result can say "this link predates a
    // change" rather than sending the reader hunting for an overlap that was
    // never the problem.
    expect(account?.selectedIsAbsent).toBe(true);
    expect(account?.selectedPhrase).toBeNull();
  });

  it("phrases a selection as a sentence fragment, not as its field caption", () => {
    // "nothing is brokerage Chase and asset class Equity" is not English; the
    // caption above a `<select>` and the same fact in prose are different words.
    const controls = availableFilters(
      [
        holding({ institution: "Chase", accountKind: "liability" }),
        holding({ institution: "Fidelity", accountKind: "brokerage" }),
      ],
      query("institution=Chase&kind=liability"),
    );

    expect(controls.map((control) => control.selectedPhrase)).toEqual([
      "at Chase",
      "in a liability account",
    ]);
  });

  it("distinguishes two people who share a name", () => {
    const [owner] = availableFilters(
      [
        holding({ ownerId: "1", ownerName: "Sam" }),
        holding({ ownerId: "2", ownerName: "Sam" }),
      ],
      query(),
    );

    expect(owner?.options.map((option) => option.value)).toEqual(["1", "2"]);
  });
});

describe("applyFilters", () => {
  const rows = [
    holding({ ownerId: "1", ownerName: "Alice", institution: "Fidelity", assetClass: "equity" }),
    holding({ ownerId: "1", ownerName: "Alice", institution: "Vanguard", assetClass: "bond" }),
    holding({ ownerId: "2", ownerName: "Bob", institution: "Fidelity", assetClass: "equity" }),
  ];

  it("narrows on one dimension", () => {
    expect(applyFilters(rows, query("institution=Fidelity"))).toHaveLength(2);
  });

  it("ands the dimensions together", () => {
    const filtered = applyFilters(rows, query("owner=1&institution=Fidelity"));

    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.assetClass).toBe("equity");
  });

  it("returns nothing for a combination the household does not hold", () => {
    // Distinct from an empty portfolio, and the screen says so differently.
    expect(applyFilters(rows, query("owner=2&institution=Vanguard"))).toEqual([]);
  });
});

describe("sortHoldings", () => {
  it("orders money by magnitude, not by the digits as text", () => {
    // The failure this exists to catch: as strings, "9.0000" sorts above
    // "10.0000" and the ninth-largest holding leads a table sorted by value.
    const sorted = sortHoldings(
      [
        holding({ instrumentName: "Nine", value: "9.0000" }),
        holding({ instrumentName: "Ten", value: "10.0000" }),
        holding({ instrumentName: "Ninety", value: "90.0000" }),
      ],
      "value",
      "desc",
    );

    expect(sorted.map((row) => row.instrumentName)).toEqual(["Ninety", "Ten", "Nine"]);
  });

  it("puts a liability below every asset", () => {
    const sorted = sortHoldings(
      [
        holding({ instrumentName: "Loan", value: "-14500.0000" }),
        holding({ instrumentName: "Cash", value: "0.0000" }),
      ],
      "value",
      "desc",
    );

    expect(sorted.map((row) => row.instrumentName)).toEqual(["Cash", "Loan"]);
  });

  it("keeps the unpriced holdings last in both directions", () => {
    // Ascending by value must not drag every holding nobody can price to the
    // top of the page — an unknown is not a small number.
    const rows = [
      holding({ instrumentName: "Unpriced", value: null }),
      holding({ instrumentName: "Small", value: "1.0000" }),
      holding({ instrumentName: "Large", value: "100.0000" }),
    ];

    expect(sortHoldings(rows, "value", "desc").map((row) => row.instrumentName)).toEqual([
      "Large",
      "Small",
      "Unpriced",
    ]);
    expect(sortHoldings(rows, "value", "asc").map((row) => row.instrumentName)).toEqual([
      "Small",
      "Large",
      "Unpriced",
    ]);
  });

  it("compares a quantity at its own scale, not the money scale", () => {
    // `quantity` is numeric(20,8). Truncating to four places would make these
    // two equal and let the tie-break decide the order.
    const sorted = sortHoldings(
      [
        holding({ instrumentName: "Fewer", quantity: "1.00000001" }),
        holding({ instrumentName: "More", quantity: "1.00000002" }),
      ],
      "quantity",
      "desc",
    );

    expect(sorted.map((row) => row.instrumentName)).toEqual(["More", "Fewer"]);
  });

  it("breaks a tie the same way every time", () => {
    const rows = [
      holding({ instrumentName: "Beta", value: "5.0000" }),
      holding({ instrumentName: "Alpha", value: "5.0000" }),
    ];

    expect(sortHoldings(rows, "value", "desc").map((row) => row.instrumentName)).toEqual([
      "Alpha",
      "Beta",
    ]);
    expect(sortHoldings([...rows].reverse(), "value", "desc").map((row) => row.instrumentName)).toEqual(
      ["Alpha", "Beta"],
    );
  });

  it("orders the text columns by what is printed in them, both ways", () => {
    const rows = [
      holding({ instrumentName: "Zinc", accountName: "Zeta", ownerName: "Zoe" }),
      holding({ instrumentName: "Apple", accountName: "Alpha", ownerName: "Ada" }),
    ];

    for (const key of ["asset", "account", "owner"] as const) {
      expect(sortHoldings(rows, key, "asc")[0]?.instrumentName).toBe("Apple");
      expect(sortHoldings(rows, key, "desc")[0]?.instrumentName).toBe("Zinc");
    }
  });

  it("keeps a missing price, cost basis or unrealized last on its own column", () => {
    // `value` is the column that gets exercised everywhere else; the other
    // three take the same path and nothing was checking that they do.
    for (const key of ["price", "costBasis", "unrealized"] as const) {
      const rows = [
        holding({ instrumentName: "Missing", [key]: null }),
        holding({ instrumentName: "Present", price: "5.0000", costBasis: "5.0000", unrealized: "5.0000" }),
      ];

      expect(sortHoldings(rows, key, "asc").at(-1)?.instrumentName).toBe("Missing");
      expect(sortHoldings(rows, key, "desc").at(-1)?.instrumentName).toBe("Missing");
    }
  });

  it("does not sort the caller's array", () => {
    const rows = [holding({ value: "1.0000" }), holding({ value: "2.0000" })];
    const before = [...rows];

    sortHoldings(rows, "value", "desc");

    expect(rows).toEqual(before);
  });
});

describe("summarise", () => {
  it("adds exactly, including the fractions a float gets wrong", () => {
    const total = summarise([
      holding({ value: "0.1000" }),
      holding({ value: "0.2000" }),
      holding({ value: "1248392.1400" }),
    ]);

    expect(total.value).toBe("1248392.4400");
  });

  it("counts value, cost basis and unrealized as three separate coverages", () => {
    // The case this is built for: a 401k line arrives priced and with no cost
    // basis at all, and an ETF nobody can quote arrives with a basis and no
    // price. Neither figure covers what the other does.
    const total = summarise([
      holding({ value: "1000.0000", costBasis: "800.0000", unrealized: "200.0000" }),
      holding({ value: "500.0000", costBasis: null, unrealized: null }),
      holding({ value: null, costBasis: "300.0000", unrealized: null }),
    ]);

    expect(total.value).toBe("1500.0000");
    expect(total.costBasis).toBe("1100.0000");
    expect(total.unrealized).toBe("200.0000");
    expect(total.valueCoverage).toEqual({ known: 2, total: 3 });
    expect(total.basisCoverage).toEqual({ known: 2, total: 3 });
    expect(total.unrealizedCoverage).toEqual({ known: 1, total: 3 });
  });

  it("reports no gain at all rather than a gain equal to the untracked position", () => {
    const total = summarise([holding({ value: "1000.0000" })]);

    expect(total.costBasis).toBeNull();
    expect(total.unrealized).toBeNull();
  });

  it("is null, not zero, when nothing behind it is known", () => {
    const total = summarise([holding({ value: null }), holding({ value: null })]);

    expect(total.value).toBeNull();
    expect(total.valueCoverage).toEqual({ known: 0, total: 2 });
  });

  it("nets a liability against the assets", () => {
    const total = summarise([
      holding({ value: "25000.0000" }),
      holding({ value: "-14500.0000", accountKind: "liability" }),
    ]);

    expect(total.value).toBe("10500.0000");
  });
});

describe("groupHoldings", () => {
  const rows = [
    holding({ ownerId: "1", ownerName: "Alice", value: "25000.0000" }),
    holding({ ownerId: "1", ownerName: "Alice", value: "3000.0000" }),
    holding({ ownerId: "2", ownerName: "Bob", value: "12500.0000" }),
  ];

  it("puts the largest group first and totals each exactly", () => {
    const groups = groupHoldings(rows, "owner", DEFAULT_SORT, DEFAULT_DIRECTION);

    expect(groups.map((group) => [group.label, group.total.value])).toEqual([
      ["Alice", "28000.0000"],
      ["Bob", "12500.0000"],
    ]);
  });

  it("keeps every row, sorted within its group", () => {
    const groups = groupHoldings(rows, "owner", "value", "asc");

    expect(groups[0]?.holdings.map((row) => row.value)).toEqual(["3000.0000", "25000.0000"]);
    expect(groups.flatMap((group) => group.holdings)).toHaveLength(3);
  });

  it("shares out of the gross positive total, so a liability's share is negative", () => {
    // The denominator `allocation.ts` argues for at length: the net total makes
    // shares explode where debts nearly cancel assets, and flips every sign for
    // a household in net debt.
    const groups = groupHoldings(
      [
        holding({ accountKind: "brokerage", value: "80000.0000" }),
        holding({ accountKind: "liability", value: "-20000.0000" }),
      ],
      "kind",
      DEFAULT_SORT,
      DEFAULT_DIRECTION,
    );

    expect(groups.map((group) => [group.label, group.share])).toEqual([
      ["Brokerage", "1.000000"],
      ["Liability", "-0.250000"],
    ]);
  });

  it("has no share to report when nothing is positive", () => {
    // A household with only a loan recorded: there is no gross-asset base for
    // anything to be a fraction of. `null`, not `0.000000` — a zero here would
    // read as "this group is none of the portfolio", when the truth is that the
    // question has no denominator. The amount beside it still says what it is.
    const groups = groupHoldings(
      [holding({ accountKind: "liability", value: "-20000.0000" })],
      "kind",
      DEFAULT_SORT,
      DEFAULT_DIRECTION,
    );

    expect(groups[0]?.share).toBeNull();
    expect(groups[0]?.total.value).toBe("-20000.0000");
  });

  it("leaves a group nobody can price worth nothing known, not worth nothing", () => {
    const groups = groupHoldings(
      [
        holding({ classification: "Priced", value: "100.0000" }),
        holding({ classification: "Unpriced", value: null }),
      ],
      "classification",
      DEFAULT_SORT,
      DEFAULT_DIRECTION,
    );

    const unpriced = groups.find((group) => group.label === "Unpriced");

    expect(unpriced?.total.value).toBeNull();
    expect(unpriced?.total.valueCoverage).toEqual({ known: 0, total: 1 });
    // And its share is null for the same reason the value is: a group nothing
    // could price is not 0% of the portfolio, it is an unknown fraction of it.
    expect(unpriced?.share).toBeNull();
  });

  it("groups on every dimension, not just the ones with a column", () => {
    const rows = [
      holding({ institution: "Fidelity", taxTreatment: "taxable", assetClass: "equity" }),
      holding({ institution: "Vanguard", taxTreatment: "tax_free", assetClass: "bond" }),
    ];

    for (const [dimension, labels] of [
      ["institution", ["Fidelity", "Vanguard"]],
      ["tax", ["Tax-free", "Taxable"]],
      ["assetClass", ["Bonds", "Equity"]],
      ["account", ["Taxable"]],
    ] as const) {
      const labelled = groupHoldings(rows, dimension, DEFAULT_SORT, DEFAULT_DIRECTION)
        .map((group) => group.label)
        .sort();

      expect(labelled).toEqual([...labels].sort());
    }
  });

  it("labels an account type in the short form a table cell has room for", () => {
    const groups = groupHoldings(
      [holding({ accountKind: "401k" })],
      "kind",
      DEFAULT_SORT,
      DEFAULT_DIRECTION,
    );

    expect(groups[0]?.label).toBe("Workplace plan");
  });
});

describe("holdingNote", () => {
  it("says what a holding is", () => {
    expect(holdingNote(holding({ assetClass: "bond" }))).toBe("Bonds");
  });

  it("distinguishes a price that is old from one that never existed", () => {
    // §6.2's distinction: a stale price is still shown and still counted; a
    // holding that has never been quoted is excluded from every total. Only one
    // of the two is fixed by waiting.
    expect(holdingNote(holding({ isStale: true }))).toBe("Equity · price is stale");
    expect(holdingNote(holding({ value: null }))).toBe("Equity · never priced");
  });
});

describe("formatQuantity", () => {
  it("trims the zeros scale-8 storage pads a share count with", () => {
    expect(formatQuantity("145.23400000")).toBe("145.234");
    expect(formatQuantity("1.00000000")).toBe("1");
  });

  it("groups thousands and uses the U+2212 minus, like every figure beside it", () => {
    // The failure this catches is a second copy of this function drifting: a
    // hyphen and no separators renders the same loan as `-14500` on one screen
    // and `−14,500` on the other.
    expect(formatQuantity("-14500.00000000")).toBe("−14,500");
    expect(formatQuantity("1234567.00000000")).toBe("1,234,567");
  });

  it("has no negative zero", () => {
    expect(formatQuantity("-0.00000000")).toBe("0");
  });
});

describe("addressing one row", () => {
  it("names a row by the pair that survives an upload, not by a holding id", () => {
    // A `holding` row's id changes every time a statement lands, so an `?edit=`
    // built on one would rot on the next upload while still pointing at a real
    // row somewhere. The account and the instrument are what the reader means.
    expect(rowKey({ accountId: "12", instrumentId: "7" })).toBe("12.7");
  });

  it("round-trips, which is what makes the URL canonical", () => {
    expect(parseRowKey(rowKey({ accountId: "12", instrumentId: "7" }))).toEqual({
      accountId: "12",
      instrumentId: "7",
    });
  });

  it.each([
    null,
    "",
    "12",
    "12.",
    ".7",
    "12.7.3",
    "a.b",
    "-1.7",
    "12.7 ",
    "9999999999999999999.7",
  ])("reads %j as no row at all", (value) => {
    // Silent about failure, the way `parseQuery` is about everything else in
    // this query string: a mangled `edit=` closes the editor rather than
    // raising. It also keeps a non-numeric id away from a `::bigint` cast,
    // which reaches a reader as a 500 rather than as a closed editor.
    expect(parseRowKey(value)).toBeNull();
  });
});
