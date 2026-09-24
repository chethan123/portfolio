// netWorthChange resolves its baseline over several statements before it aggregates anything
// (#347). Two connections and committed rows, because withDatabase's one rolled-back transaction
// cannot contend with itself; every row planted here carries RACE_PREFIX and is swept at both ends.
// Keep it that way: inOneSnapshot short-circuits on an outer transaction, so a case moved under
// withDatabase inherits READ COMMITTED and stops reaching REPEATABLE READ at all. This file is the
// only coverage of that isolation level, and it would go on passing without it.
import { sql } from "kysely";
import { afterAll, beforeAll, expect, it } from "vitest";

import { ALL_OWNERS } from "~/lib/owner-filter";
import { netWorthChange } from "~/lib/valuation.server";

import { closeTestDatabase, testDatabase, waitUntilRelationBlocked } from "./support/database.ts";
import { RACE_PREFIX, clearRaces, makeFixtures } from "./support/fixtures.ts";

beforeAll(async () => clearRaces(await testDatabase()));
afterAll(async () => {
  try {
    await clearRaces(await testDatabase());
  } finally {
    await closeTestDatabase();
  }
});

it("reports a first statement committed while it is resolving its baseline as no change rather than a gain from nothing", async () => {
  const database = await testDatabase();
  const fixtures = makeFixtures(database);
  const usd = await fixtures.usdInstrument();
  const owner = await fixtures.seedPerson({ name: `${RACE_PREFIX}owner` });
  const account = await fixtures.seedAccount({
    name: `${RACE_PREFIX}account`,
    owner,
    kind: "bank",
  });

  const uploader = await database.startTransaction().execute();

  try {
    // The clamp. Resolving a baseline reads manual_networth after position_set, so an exclusive
    // lock on it holds the read open across the commit — in production the same gap is ordinary
    // scheduling between two statements, which no test can time.
    await sql`lock table manual_networth in access exclusive mode`.execute(uploader);

    const reading = netWorthChange(ALL_OWNERS, "2020-01-01", database);
    reading.catch(() => {});
    await waitUntilRelationBlocked(database, "manual_networth", { unless: reading });

    // The household's first statement ever, committed mid-read: nothing was recorded when the
    // baseline was looked for, and $5,000 is there by the time the totals are summed.
    await makeFixtures(uploader).seedPositionSet({
      account,
      asOf: "2026-01-31",
      holdings: [{ instrument: usd, quantity: "5000.00000000" }],
    });
    await uploader.commit().execute();

    expect(await reading).toEqual({
      current: "0.0000",
      previous: "0.0000",
      difference: "0.0000",
      percent: null,
      basis: "none",
      basisDate: null,
    });
  } finally {
    if (!uploader.isCommitted && !uploader.isRolledBack) {
      await uploader.rollback().execute().catch(() => {});
    }
  }
});
