// ownerReading is the one place all four owner-filter screens settle an address and narrow `reading` — a bug here reaches all of them
import { afterAll, describe, expect, it } from "vitest";

import { isFiltered, ownerSearch, type OwnerFilter } from "~/lib/owner-filter";
import { isNarrowedToNothing, ownerReading, type ScreenAddress } from "~/lib/owner-reading.server";

import { closeTestDatabase, withDatabase } from "./support/database.ts";
import { get, outcomeOf, ownerParam, redirectTo } from "./support/routes.ts";

import type { TestContext } from "./support/database.ts";

afterAll(closeTestDatabase);

// arbitrary pathname — ownerReading is screen-agnostic, no route need exist
const PATH = "/screen";

async function seedTwoOwners(ctx: Pick<TestContext, "seedPerson" | "seedAccount">) {
  const alice = await ctx.seedPerson({ name: "Alice" });
  const bob = await ctx.seedPerson({ name: "Bob" });
  await ctx.seedAccount({ name: "Alice Brokerage", owner: alice });
  await ctx.seedAccount({ name: "Bob Roth", owner: bob });

  return { alice, bob };
}

// stand-in for Holdings' address (?edit=/?saved=): request keeps `row`, link drops it — a view link must not reopen an editor
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
  // legitimate chains are 2 hops (canonical, then all-owners collapse); 4 is generous enough to prove a loop, not permit one
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
        // covers a transport that's already round-tripped the query through URLSearchParams
        `?owner=${both.replace(",", "%2C")}`,
        // apostrophe id, encoded and literal — both must settle to the same address
        "?owner=o%27brien",
        "?owner=o'brien",
        "?owner=a%20b",
        "?owner=a+b",
        `?owner=${bob.id},${alice.id}`,
        `?owner=${alice.id}&owner=${bob.id}`,
        "?owner=",
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

      const messy = get(`${PATH}?range=1m&owner=${bob.id},${alice.id}`);
      expect(await redirectTo(() => ownerReading(messy))).toBe(
        `${PATH}?${ownerParam(alice.id, bob.id)}&range=1m`,
      );
    }),
  );

  it(
    "bounces a comma-spelled selection — literal or percent-encoded — to the repeated-key address, on its own and not only as part of the chain",
    withDatabase(async () => {
      // no seed needed — respelling is decided from the address alone; "?owner=1,3" is the old canonical spelling, accepted but never a redirect target
      for (const search of ["?owner=1,3&range=1m", "?owner=1%2C3&range=1m"]) {
        expect(await redirectTo(() => ownerReading(get(`${PATH}${search}`)))).toBe(
          `${PATH}?owner=1&owner=3&range=1m`,
        );
      }
    }),
  );
});

describe("what `reading` resolves to", () => {
  it(
    "drops an id the roster does not carry, from `reading` alone",
    withDatabase(async (ctx) => {
      const { alice } = await seedTwoOwners(ctx);

      // sorts after any seeded id and is already canonical — exercises resolution, not the bounce
      const { reading, owner } = await ownerReading(
        get(`${PATH}?owner=${alice.id}&owner=999999999`),
      );

      expect(reading).toEqual([alice.id]);
      // reading narrows what's shown, not what the control ticks or names
      expect(owner.owners).toEqual([alice.id, "999999999"]);
      expect(owner.unknownOwner).toBe(true);
    }),
  );

  it(
    "keeps every raw id in `reading` when the selection resolves to nobody, rather than widening",
    withDatabase(async (ctx) => {
      await seedTwoOwners(ctx);

      const { reading } = await ownerReading(get(`${PATH}?owner=888888888&owner=999999999`));

      // [] reads as the whole household — keeping raw unmatched ids narrows instead of silently widening
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
        `?owner=${alice.id}&owner=999999999`,
        "?owner=888888888&owner=999999999",
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
      const spell = rowAddress("42");

      const messy = get(`${PATH}?owner=${bob.id},${alice.id}&row=42`);
      const sorted = await redirectTo(() => ownerReading(messy, spell));
      expect(sorted).toBe(`${PATH}?${ownerParam(alice.id, bob.id)}&row=42`);

      // regression: Holdings' own everyone bounce used to drop `saved` here
      const everyone = await redirectTo(() => ownerReading(get(sorted), spell));
      expect(everyone).toBe(`${PATH}?row=42`);

      // showEveryone is built from link, not request — a view link carries no row to reopen
      const { owner } = await ownerReading(get(everyone), spell);
      expect(owner.showEveryone).not.toContain("row=");
    }),
  );
});

describe("showEveryone", () => {
  it(
    "is '.' rather than '' for a screen whose unfiltered address is bare",
    withDatabase(async (ctx) => {
      const { alice } = await seedTwoOwners(ctx);

      // canonical is "" here — <Link to=""> would resolve to the current filtered page, making Show everyone a no-op
      const { owner } = await ownerReading(get(`${PATH}?owner=${alice.id}`));

      expect(owner.showEveryone).toBe(".");
    }),
  );
});

describe("isNarrowedToNothing", () => {
  type Counts = { held: number; instance: number };

  const CASES: Array<[owners: OwnerFilter, counts: Counts, expected: boolean, why: string]> = [
    [[], { held: 0, instance: 0 }, false, "unfiltered and never uploaded — nothing to narrow"],
    [[], { held: 5, instance: 5 }, false, "unfiltered with holdings is never narrowed to nothing"],
    [
      [],
      { held: 0, instance: 5 },
      false,
      "unfiltered and holding nothing is an empty instance, never a filter that reached nothing",
    ],
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
