/**
 * The Holdings table — what it shows, in what order, and what the figures
 * come to (DESIGN.md §8.1). No database: `holdings-view.ts` is pure, so
 * these are unit tests over a fixture function. Four things pinned: the
 * grouping and filtering (the obvious one); the arithmetic — exact decimal
 * strings including the cases a float gets wrong; the sort, where a
 * plausible implementation quietly fails (`"9.0000"` against `"10.0000"` as
 * strings puts the ninth-largest holding atop a value-sorted column, and it
 * looks right until you read it); and the honesty rule the screen stands on
 * — an unknown is never a zero: a null cost basis reports no gain rather
 * than a gain equal to the untracked position, a group nobody can price is
 * worth `null`, and a filter matching no rows differs from a portfolio with
 * none.
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_DIRECTION,
  DEFAULT_SORT,
  DIMENSIONS,
  GROUPINGS,
  applyFilters,
  availableFilters,
  formatQuantity,
  groupHoldings,
  holdingNote,
  holdingYield,
  parseQuery,
  parseRowKey,
  rowKey,
  sortHoldings,
  summarise,
  toSearch,
} from "~/lib/holdings-view";
import { MONEY_SCALE, SHARE_SCALE, render, sumMoney, toUnits } from "~/lib/money";
import { ALL_OWNERS, readOwnerFilter } from "~/lib/owner-filter";

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
    accountNumberTail: null,
    institution: "Fidelity",
    accountKind: "brokerage",
    taxTreatment: "taxable",
    ownerId: "1",
    ownerName: "Alice",
    instrumentId: String((sequence += 1)),
    symbol: "VTI",
    instrumentName: "Vanguard Total Stock Market ETF",
    quoteType: "ETF",
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
    // Zero rather than null, because that is what the view emits for a holding
    // whose instrument carries no rate: the coalesce is in the SQL.
    annualDividend: "0.0000",
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
    const parsed = query("account=7&institution=Vanguard&group=kind&sort=quantity&dir=asc");

    expect(parsed.filters.get("account")).toBe("7");
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
    expect(query("account=&kind=").filters.size).toBe(0);
  });

  it("accepts the dividend column as a sort", () => {
    // Not framework behaviour: a key missing from `SORT_KEYS` is *ignored*
    // rather than refused, so forgetting to list it would leave the new
    // header's link ordering the table by value with a caret drawn on the
    // wrong column and nothing anywhere reporting a fault.
    expect(query("sort=annualDividend").sort).toBe("annualDividend");
  });

  it("keeps a filter key no holding carries", () => {
    // Dropping it would silently widen the request: someone who asked for one
    // account would be shown the whole portfolio. It survives, and renders as
    // an empty result that says so.
    expect(query("account=999").filters.get("account")).toBe("999");
  });
});

describe("the dimensions", () => {
  it("offers exactly the six a select can narrow by, owner no longer among them", () => {
    // The literal list, not a count: a count passes while the wrong dimension
    // is missing. `owner` left because narrowing by owner is household-wide
    // now, and a second, screen-local way to ask the same question is two
    // answers available at once.
    expect(DIMENSIONS.map((dimension) => dimension.id)).toEqual([
      "account",
      "institution",
      "kind",
      "tax",
      "classification",
      "assetClass",
    ]);
  });

  it("keeps owner as a grouping, first, because grouping is not narrowing", () => {
    expect(GROUPINGS.map((dimension) => dimension.id)).toEqual([
      "owner",
      ...DIMENSIONS.map((dimension) => dimension.id),
    ]);
  });

  it("still parses `group=owner`, so a bookmarked grouping keeps working", () => {
    expect(query("group=owner").group).toBe("owner");
    // And it is no longer read as a filter, whatever the URL says.
    expect(query("owner=2").filters.size).toBe(0);
  });
});

describe("toSearch", () => {
  it("omits the defaults, so the unfiltered table's URL is bare", () => {
    expect(toSearch(query(), ALL_OWNERS)).toBe("");
  });

  it("round-trips a view", () => {
    const search = "account=7&institution=Vanguard&group=kind&sort=quantity&dir=asc";

    expect(toSearch(query(search), ALL_OWNERS)).toBe(`?${search}`);
  });

  it("emits the owner filter first, with literal commas, so one view has one spelling", () => {
    // First and comma-spelled because this function is the single definition of
    // a canonical Holdings URL and the loader redirects anything else. Round
    // -tripping the pair through `URLSearchParams` would spell the separator
    // `%2C`, which is a second URL for one view.
    expect(toSearch(query("group=kind"), ["1", "3"])).toBe("?owner=1,3&group=kind");
    expect(toSearch(query(), ["3"])).toBe("?owner=3");
  });

  it("is a fixed point, so the route's canonical redirect cannot loop", () => {
    // The route bounces to `toSearch(parseQuery(search), readOwnerFilter(…))`
    // whenever the incoming URL differs from it — which is every time a form
    // submits, since a GET form sends `&kind=&tax=` for the selects nobody
    // touched and `owner=1&owner=3` for the boxes somebody did. If a second
    // pass could change the string again, that bounce would be a redirect loop
    // rather than a tidy-up, and nothing would notice until a reader opened
    // the screen.
    for (const messy of [
      "owner=1&account=&institution=&kind=&tax=&classification=&assetClass=",
      "sort=value&dir=desc&group=",
      "colour=blue&owner=2",
      "owner=3&owner=1",
      "group=kind&owner=10,9",
      "owner=1%2C3&sort=quantity",
      "",
    ]) {
      const params = new URLSearchParams(messy);
      const once = toSearch(parseQuery(params), readOwnerFilter(params));
      const again = new URLSearchParams(once);

      expect(toSearch(parseQuery(again), readOwnerFilter(again))).toBe(once);
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
        holding({ institution: "Fidelity", assetClass: "equity" }),
        holding({ institution: "Vanguard", assetClass: "bond" }),
      ],
      query(),
    );

    expect(controls.map((control) => control.id)).toEqual(["institution", "assetClass"]);
  });

  it("never offers an owner select, however many owners the holdings carry", () => {
    // Narrowing by owner is household-wide (ADR-0008), so this bar does not
    // ask: two ways to ask one question is two answers available at once.
    const controls = availableFilters(
      [
        holding({ ownerId: "1", ownerName: "Alice", institution: "Fidelity" }),
        holding({ ownerId: "2", ownerName: "Bob", institution: "Vanguard" }),
      ],
      query(),
    );

    expect(controls.map((control) => control.id)).not.toContain("owner");
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

  it("spells an account option as name, number tail, then institution", () => {
    // The tail rides in the option whenever a number is recorded — not only
    // when names collide (CONTEXT.md) — and an account without one keeps the
    // bare name: no dots standing in for a number nobody recorded.
    const [account] = availableFilters(
      [
        holding({ accountId: "1", accountName: "Roth IRA", accountNumberTail: "····3910" }),
        holding({ accountId: "2", accountName: "Checking", accountNumberTail: null }),
      ],
      query(),
    ).filter((control) => control.id === "account");

    expect(account?.options.map((option) => option.label)).toEqual([
      "Checking · Fidelity",
      "Roth IRA ····3910 · Fidelity",
    ]);
  });

  it("offers an account type in the self-explaining form, not the short one", () => {
    // The register split this module owns: the table cell prints "Workplace
    // plan" (below), the dropdown offering the choice spells out which
    // accounts it means. Both come off the one dimension, so they are the
    // same words minus the tail — and this is the only assertion left of the
    // long form now that the Analysis panel prints a bucket like the table.
    const [kind] = availableFilters(
      [holding({ accountKind: "401k" }), holding({ accountKind: "brokerage" })],
      query(),
    ).filter((control) => control.id === "kind");

    expect(kind?.options.map((option) => option.label)).toEqual([
      "Brokerage",
      "Workplace plan (401k, 403b)",
    ]);
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

  it("distinguishes two people who share a name, wherever owner is still read", () => {
    // The owner dimension is a grouping now rather than a filter, and it is
    // still keyed on the id: two people in one household can share a first
    // name, and a grouping that merged them would be wrong invisibly.
    const groups = groupHoldings(
      [
        holding({ ownerId: "1", ownerName: "Sam", value: "10.0000" }),
        holding({ ownerId: "2", ownerName: "Sam", value: "20.0000" }),
      ],
      "owner",
      DEFAULT_SORT,
      DEFAULT_DIRECTION,
    );

    expect(groups.map((group) => group.key)).toEqual(["2", "1"]);
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
    const filtered = applyFilters(rows, query("assetClass=equity&institution=Fidelity"));

    expect(filtered).toHaveLength(2);
    expect(filtered.every((row) => row.institution === "Fidelity")).toBe(true);
  });

  it("returns nothing for a combination the household does not hold", () => {
    // Distinct from an empty portfolio, and the screen says so differently.
    expect(applyFilters(rows, query("assetClass=bond&institution=Fidelity"))).toEqual([]);
  });

  it("no longer narrows on owner, whatever the URL says", () => {
    // The owner filter is household-wide and applied in SQL. A leftover
    // `?owner=` reaching this function must not narrow a second time.
    expect(applyFilters(rows, query("owner=1"))).toHaveLength(rows.length);
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

  it("orders the dividend by magnitude, and a holding that pays nothing is not missing", () => {
    // Two rules in one, because the second is the one a copy of the `value`
    // column would get wrong. The dividend has no `isMissing` case: the view
    // coalesces a missing rate to zero, so `$0` is a figure and belongs where
    // the arithmetic puts it. Sorted ascending, a holding nobody can price
    // leads the table here — and must, because it pays the least — where on
    // the Value column the same row stays pinned to the bottom.
    const rows = [
      holding({ instrumentName: "Nine", annualDividend: "9.0000" }),
      holding({ instrumentName: "Ten", annualDividend: "10.0000" }),
      holding({ instrumentName: "Trust", value: null, annualDividend: "0.0000" }),
    ];

    expect(sortHoldings(rows, "annualDividend", "desc").map((row) => row.instrumentName)).toEqual([
      "Ten",
      "Nine",
      "Trust",
    ]);
    expect(sortHoldings(rows, "annualDividend", "asc").map((row) => row.instrumentName)).toEqual([
      "Trust",
      "Nine",
      "Ten",
    ]);
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

  it("adds the dividend over rows the value total cannot cover", () => {
    // The column that is complete beside one that is not. An unquoted trust
    // has a quantity and no price, so it contributes nothing to the value and
    // a real `$0` to the dividend — which is why this figure carries no
    // coverage caption while the one beside it does.
    const total = summarise([
      holding({ value: "27000.0000", annualDividend: "340.0000" }),
      holding({ value: "3000.0000", annualDividend: "0.1000" }),
      holding({ value: null, annualDividend: "0.0000" }),
    ]);

    expect(total.annualDividend).toBe("340.1000");
    expect(total.value).toBe("30000.0000");
    expect(total.valueCoverage).toEqual({ known: 2, total: 3 });
  });

  it("is `$0` of dividend where nothing pays, never an unknown amount", () => {
    // The one figure here that is not nulled when nothing behind it is known.
    // `totalOf`'s `figure()` helper dashes a sum whose `known` count is zero,
    // which is right for the three figures beside this one and wrong for this
    // one: a set where nothing pays pays nothing, and a dash there would read
    // as "we could not work out what this comes to" (DESIGN.md §14,
    // limitation 9). The empty set is the sharpest case — every other figure
    // on it is null.
    expect(summarise([]).annualDividend).toBe("0.0000");
    expect(summarise([]).value).toBeNull();
    expect(summarise([holding(), holding()]).annualDividend).toBe("0.0000");
  });

  it("nets a liability's interest against what the assets pay", () => {
    // Seeded against a real database while this feature was specced: a taxable
    // brokerage holding beside a car loan whose note carries a rate came out
    // *negative*, because a negative quantity times a rate is money going out.
    // The subtotal on the group a household cares most about is the one that
    // goes below zero.
    const total = summarise([
      holding({ value: "27000.0000", annualDividend: "340.0000" }),
      holding({ accountKind: "liability", value: "-14500.0000", annualDividend: "-522.2000" }),
    ]);

    expect(total.annualDividend).toBe("-182.2000");
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
        holding({ accountKind: "brokerage", value: "10000.0000" }),
        holding({ accountKind: "bank", value: "10000.0000" }),
        holding({ accountKind: "401k", value: "10000.0000" }),
        holding({ accountKind: "liability", value: "-20000.0000" }),
      ],
      "kind",
      DEFAULT_SORT,
      DEFAULT_DIRECTION,
    );

    // Three groups rather than one, because one group's share is 1.000000
    // whatever the arithmetic does. Each third rounds to 0.333333 on its own
    // and three of those are a millionth short of the whole; the unit that
    // flooring lost goes back to the first of the tied remainders in sort
    // order, so the groups add up and the same set always reads the same way.
    expect(groups.map((group) => [group.label, group.share])).toEqual([
      ["Bank", "0.333334"],
      ["Brokerage", "0.333333"],
      ["Workplace plan", "0.333333"],
      // −20,000 of the 30,000 owned. Not of the 10,000 net, and not topped up:
      // a debt is not one of the pieces the whole is being cut into.
      ["Liability", "-0.666667"],
    ]);

    // Summed on the digits. `Number()` would round a millionth's shortfall away
    // and report a pie that has a gap in it as whole.
    const positive = groups
      .map((group) => group.share)
      .filter((share): share is string => share !== null && !share.startsWith("-"));

    expect(positive.reduce((sum, share) => sum + toUnits(share, SHARE_SCALE), 0n)).toBe(
      toUnits("1.000000", SHARE_SCALE),
    );
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

  it("subtotals the dividend, and the grand total is the sum of the subtotals", () => {
    // The screen prints the rows, the subtotals under them and the total under
    // those, all from one array — so this asserts the arithmetic that makes
    // the three unable to disagree, rather than three separate figures that
    // happen to match. The third group pays nothing and subtotals to `$0`,
    // which is the figure a dash would have replaced.
    const paying = [
      holding({ ownerId: "1", ownerName: "Alice", value: "27000.0000", annualDividend: "340.0000" }),
      holding({ ownerId: "1", ownerName: "Alice", value: "3000.0000", annualDividend: "0.1000" }),
      holding({ ownerId: "2", ownerName: "Bob", value: "12500.0000", annualDividend: "162.5000" }),
      holding({ ownerId: "3", ownerName: "Cleo", value: "9000.0000", annualDividend: "0.0000" }),
    ];

    const groups = groupHoldings(paying, "owner", DEFAULT_SORT, DEFAULT_DIRECTION);

    expect(groups.map((group) => [group.label, group.total.annualDividend])).toEqual([
      ["Alice", "340.1000"],
      ["Bob", "162.5000"],
      ["Cleo", "0.0000"],
    ]);

    const subtotals = sumMoney(groups.map((group) => group.total.annualDividend));

    expect(render(subtotals.amount, MONEY_SCALE)).toBe(summarise(paying).annualDividend);
    expect(summarise(paying).annualDividend).toBe("502.6000");
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

describe("holdingYield", () => {
  it("states one holding's payout as a fraction of what it is worth", () => {
    // Exact at `SHARE_SCALE`, computed on the digits: 340 / 27,000 is
    // 1.259259…%, and the sixth place is where the rounding lands.
    expect(holdingYield({ annualDividend: "340.0000", value: "27000.0000" })).toBe("0.012593");
  });

  it("has no percentage for a holding nobody can price", () => {
    // The unquoted 401k trust: a quantity, no price, and therefore a `$0`
    // dividend with nothing to state it as a fraction of. `0.0%` beneath a
    // blank Value would be a claim about a holding no one can value.
    expect(holdingYield({ annualDividend: "0.0000", value: null })).toBeNull();
  });

  it("has no percentage for a holding worth zero, and does not throw on one", () => {
    // The crash this guard exists for. `money.ts`'s `divide` divides bigints,
    // so a zero denominator raises `RangeError` — and nothing in the schema
    // stops a quantity or a price being zero, so a position someone has sold
    // out of arrives here as `"0.0000"`. Unguarded, one such row takes the
    // whole Holdings table down rather than losing its own sub-line.
    expect(() => holdingYield({ annualDividend: "0.0000", value: "0.0000" })).not.toThrow();
    expect(holdingYield({ annualDividend: "0.0000", value: "0.0000" })).toBeNull();
    expect(holdingYield({ annualDividend: "5.0000", value: "0.0000" })).toBeNull();
  });

  it("reads a liability's two negatives as the rate it is charged at", () => {
    // A loan holds a negative quantity, so both figures are negative and the
    // fraction between them comes out positive. That is the right answer and
    // it is worth pinning: the row says −$522.20 at 3.6%, which is what the
    // note costs and the rate it costs it at — not a payout of 3.6%.
    expect(holdingYield({ annualDividend: "-522.0000", value: "-14500.0000" })).toBe("0.036000");
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
    // Leading zeros name the same pair as "1.2" and would otherwise survive the
    // loader's canonical check while matching no row's key on the page.
    "0001.0002",
    "01.2",
    "9999999999999999999.7",
  ])("reads %j as no row at all", (value) => {
    // Silent about failure, the way `parseQuery` is about everything else in
    // this query string: a mangled `edit=` closes the editor rather than
    // raising. It also keeps a non-numeric id away from a `::bigint` cast,
    // which reaches a reader as a 500 rather than as a closed editor.
    expect(parseRowKey(value)).toBeNull();
  });
});
