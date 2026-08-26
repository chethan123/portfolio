/**
 * The one loader that runs on every page render, including the login page.
 *
 * Its first-run read is a hint, not data, and `root.tsx` says so: a database
 * that is down must produce a page without a prompt rather than an error page.
 * That sentence is load-bearing and nothing enforces it. `firstRunStep()` is a
 * query like any other and will throw when Postgres is unreachable; propagated
 * from *this* loader it becomes an error boundary on the root route — which is
 * every route — so an instance whose database is down would refuse the login
 * page too. Someone would then be locked out of a running app by a container
 * that is merely restarting, with `/healthz` next door reporting the real
 * cause to nobody. One `try` is the difference, and a `try` is the easiest
 * thing in a file to tidy away.
 *
 * The environment is configured before the import because `getConfig()`
 * memoises its first read — the same reason `root-gate.test.ts` does it, and
 * the same order the container uses.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { TEST_DATABASE_URL, closeTestDatabase, withDatabase } from "../support/database.ts";
import { args, get } from "../support/routes.ts";

process.env.DATABASE_URL = TEST_DATABASE_URL;

const { loader } = await import("../../app/root.tsx");
const { createDatabase, withDb } = await import("~/lib/db.server");
const { stopPricePoller } = await import("~/lib/price-poller.server");

/** Refused immediately, which is how "the database is down" arrives here. */
const UNREACHABLE_DATABASE_URL = "postgres://portfolio:portfolio@127.0.0.1:1/portfolio_test";

/**
 * This loader also starts the refresh loop (§6.2), because it is the one
 * server-side path every page render passes through — so calling it here
 * creates a real fifteen-minute interval holding the live Yahoo provider. It is
 * `unref`'d, so it cannot hold vitest open, but it would outlive this file for
 * the rest of the run. Stopped after every test rather than left to that.
 */
afterEach(stopPricePoller);

afterAll(closeTestDatabase);

describe("the shell's loader", () => {
  it("reports no first-run step rather than propagating, when the database cannot be reached", async () => {
    const unreachable = createDatabase(UNREACHABLE_DATABASE_URL);

    try {
      const data = await withDb(unreachable, () => loader(args(get("/"))));

      // Null, which the shell renders as "no prompt" — not a thrown Response,
      // and not an error page over the login form.
      expect(data.firstRun).toBeNull();

      // The masking read is down the same well and has the same duty, with one
      // extra: of the two ways to be wrong while the database is unreachable,
      // this is the one that cannot put a household's balances on a screen
      // (spec 0007).
      expect(data.masked).toBe(true);
    } finally {
      await unreachable.destroy();
    }
  });

  it(
    "reports the step the instance is actually on when the database answers",
    withDatabase(async ({ seedPerson }) => {
      // The counterpart, and what keeps the test above from passing on a
      // loader that had stopped asking the question at all.
      await seedPerson();

      expect((await loader(args(get("/")))).firstRun).toBe("accounts");
    }),
  );
});
