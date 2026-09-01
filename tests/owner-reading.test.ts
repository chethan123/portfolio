/**
 * `ownerReading` is now the one place all four owner-filter screens settle an
 * address, resolve the roster, and narrow `reading` — a bug here reaches
 * every one of them at once, where the four separate loader preambles this
 * replaces could each drift on its own (and did: Overview's own reorder,
 * Holdings' own dropped receipt). The settle chain is the sharpest risk: a
 * canonical spelling that is not a fixed point is an infinite redirect
 * nobody notices until they open a screen, so this file follows the chain to
 * its end rather than checking one hop. `reading`'s divergence from the raw
 * filter is the second: a stale id has to be dropped from what a
 * date-crossing reader narrows by, and a selection matching nobody has to
 * keep its raw ids rather than silently widen to the whole household.
 */
import { afterAll, describe, expect, it } from "vitest";

import { isFiltered, ownerSearch, type OwnerFilter } from "~/lib/owner-filter";
import { isNarrowedToNothing, ownerReading, type ScreenAddress } from "~/lib/owner-reading.server";

import { closeTestDatabase, withDatabase } from "./support/database.ts";
import { get, outcomeOf, redirectTo } from "./support/routes.ts";

import type { TestContext } from "./support/database.ts";

afterAll(closeTestDatabase);

/** An arbitrary pathname — `ownerReading` is screen-agnostic, so no route need exist here. */
const PATH = "/screen";

/** Two owners, each holding one open account — enough for a real narrowing. */
async function seedTwoOwners(ctx: Pick<TestContext, "seedPerson" | "seedAccount">) {
  const alice = await ctx.seedPerson({ name: "Alice" });
  const bob = await ctx.seedPerson({ name: "Bob" });
  await ctx.seedAccount({ name: "Alice Brokerage", owner: alice });
  await ctx.seedAccount({ name: "Bob Roth", owner: bob });

  return { alice, bob };
}

/**
 * A stand-in for Holdings' own address (`?edit=`/`?saved=`): a `row` the
 * request-target keeps and the link — `showEveryone` included — always
 * drops, because a link built from the view must not reopen an editor the
 * reader who follows it never had open.
 */
function rowAddress(row: string): ScreenAddress {
  const link = (owners: OwnerFilter) => ownerSearch(owners);

  return {
    request: (owners) => {
      const base = link(owners);
      return `${base === "" ? "?" : `${base}&`}row=${row}`;
    },
    link,
  };
}

describe("the settle chain", () => {
  // Terminates, rather than bounces exactly once: an address can legitimately
  // take two hops — the canonical spelling, then the all-owners collapse —
  // and what must never happen is a third that is the second again. Four is
  // generous enough to prove a loop rather than to allow one. This is what
  // actually catches a non-idempotent speller; a check blind to the chain
  // would pass `?owner=1,3 → ?owner=3,1 → ?owner=1,3` and loop forever.
  const settles = async (search: string): Promise<void> => {
    let where = `${PATH}${search}`;
    const seen: string[] = [];

    for (let hop = 0; hop < 4; hop += 1) {
      const outcome = await outcomeOf(() => ownerReading(get(where)));
      if (!(outcome instanceof Response)) return;

      seen.push(where);
      where = outcome.headers.get("Location") ?? "";
      expect({ search, revisited: seen.includes(where) }).toEqual({ search, revisited: false });
    }

    expect({ search, settled: false }).toEqual({ search, settled: true });
  };

  it(
    "settles, and never revisits an address on the way, whatever spelled it",
    withDatabase(async (ctx) => {
      const { alice, bob } = await seedTwoOwners(ctx);
      const both = [alice.id, bob.id].sort((a, b) => Number(a) - Number(b)).join(",");

      for (const search of [
        "",
        `?owner=${alice.id}`,
        `?owner=${both}`,
        // Every multi-owner URL, on any transport that has already round-tripped
        // the query through `URLSearchParams`.
        `?owner=${both.replace(",", "%2C")}`,
        // An id naming nobody, which this application keeps on purpose — the
        // one case where `encodeURIComponent` and the URL parser disagree.
        "?owner=o%27brien",
        "?owner=o'brien",
        "?owner=a%20b",
        "?owner=a+b",
        `?owner=${bob.id},${alice.id}`,
        `?owner=${alice.id}&owner=${bob.id}`,
        "?owner=",
        // A non-owner parameter on either side of it, carried through every hop.
        `?range=1m&owner=${bob.id},${alice.id}`,
        `?owner=${alice.id}&range=3m`,
      ]) {
        await settles(search);
      }
    }),
  );

  it(
    "keeps the rest of the address and spells the owner parameter first",
    withDatabase(async (ctx) => {
      const { alice, bob } = await seedTwoOwners(ctx);
      const both = [alice.id, bob.id].sort((a, b) => Number(a) - Number(b)).join(",");

      const messy = get(`${PATH}?range=1m&owner=${bob.id},${alice.id}`);
      expect(await redirectTo(() => ownerReading(messy))).toBe(`${PATH}?owner=${both}&range=1m`);
    }),
  );

  it(
    "bounces the percent-encoded separator on its own, not only as part of the chain",
    withDatabase(async (ctx) => {
      const { alice, bob } = await seedTwoOwners(ctx);
      const both = [alice.id, bob.id].sort((a, b) => Number(a) - Number(b)).join(",");

      // A comparison blind to encoding would settle this address perfectly
      // while quietly keeping two URLs for one view — `?owner=1%2C3` never
      // itself appearing as a hop in a chain that starts elsewhere is not the
      // same claim as it bouncing when it is where a reader actually lands.
      const encoded = get(`${PATH}?owner=${both.replace(",", "%2C")}&range=1m`);
      expect(await redirectTo(() => ownerReading(encoded))).toBe(`${PATH}?owner=${both}&range=1m`);
    }),
  );
});

describe("what `reading` resolves to", () => {
  it(
    "drops an id the roster does not carry, from `reading` alone",
    withDatabase(async (ctx) => {
      const { alice } = await seedTwoOwners(ctx);

      // Already canonical: `999999999` sorts after any freshly seeded id, so
      // this exercises the resolution, not the bounce.
      const { reading, owner } = await ownerReading(get(`${PATH}?owner=${alice.id},999999999`));

      expect(reading).toEqual([alice.id]);
      // The raw selection is untouched — `reading` narrows what the readers
      // see, not what the control draws as ticked or the sentence names.
      expect(owner.owners).toEqual([alice.id, "999999999"]);
      expect(owner.unknownOwner).toBe(true);
    }),
  );

  it(
    "keeps every raw id in `reading` when the selection resolves to nobody, rather than widening",
    withDatabase(async (ctx) => {
      await seedTwoOwners(ctx);

      const { reading } = await ownerReading(get(`${PATH}?owner=888888888,999999999`));

      // `[]` reads as the whole household (`owner-filter.ts`); keeping the raw,
      // unmatched ids is what makes a household-scoped reader narrow to
      // nothing instead of quietly widening back out.
      expect(reading).toEqual(["888888888", "999999999"]);
    }),
  );

  it(
    "is filtered exactly when the raw selection is, whatever it resolves to",
    withDatabase(async (ctx) => {
      const { alice } = await seedTwoOwners(ctx);

      for (const search of [
        "",
        `?owner=${alice.id}`,
        `?owner=${alice.id},999999999`,
        "?owner=888888888,999999999",
      ]) {
        const { reading, owner } = await ownerReading(get(`${PATH}${search}`));
        expect(isFiltered(reading)).toBe(isFiltered(owner.owners));
      }
    }),
  );
});

describe("a screen's own request-only state", () => {
  it(
    "survives both bounces through `request`, and is gone from `link` and `showEveryone`",
    withDatabase(async (ctx) => {
      const { alice, bob } = await seedTwoOwners(ctx);
      const both = [alice.id, bob.id].sort((a, b) => Number(a) - Number(b)).join(",");
      const spell = rowAddress("42");

      // Non-canonical order, the row present: the canonical bounce keeps it.
      const messy = get(`${PATH}?owner=${bob.id},${alice.id}&row=42`);
      const sorted = await redirectTo(() => ownerReading(messy, spell));
      expect(sorted).toBe(`${PATH}?owner=${both}&row=42`);

      // Alice and Bob are the whole household, so the sorted address collapses
      // next — the everyone bounce, built from the same `request`, keeps the
      // row too. One speller for both bounces is what closes the gap Holdings
      // had: its own everyone bounce used to drop `saved` where its canonical
      // bounce kept it.
      const everyone = await redirectTo(() => ownerReading(get(sorted), spell));
      expect(everyone).toBe(`${PATH}?row=42`);

      // `owner.showEveryone` is built from `link`, never `request`, and a link
      // built from the view carries no row to reopen.
      const { owner } = await ownerReading(get(everyone), spell);
      expect(owner.showEveryone).not.toContain("row=");
    }),
  );
});

describe("isNarrowedToNothing", () => {
  type Counts = { held: number; instance: number };

  const CASES: Array<[owners: OwnerFilter, counts: Counts, expected: boolean, why: string]> = [
    [[], { held: 0, instance: 0 }, false, "unfiltered and never uploaded — nothing to narrow"],
    [[], { held: 5, instance: 5 }, false, "unfiltered with holdings is never narrowed to nothing"],
    [["1"], { held: 3, instance: 5 }, false, "a filter that reaches something is not narrowed"],
    [["1"], { held: 0, instance: 5 }, true, "a filter reaching nothing on an instance that has data"],
    [
      ["1"],
      { held: 0, instance: 0 },
      false,
      "a never-uploaded instance says so itself — this is not that sentence, even while filtered",
    ],
    [["1", "2"], { held: 0, instance: 0 }, false, "same, with a multi-owner selection"],
  ];

  for (const [owners, counts, expected, why] of CASES) {
    it(`is ${expected} when ${why}`, () => {
      expect(isNarrowedToNothing(owners, counts)).toBe(expected);
    });
  }
});
