import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createPool } from "../server/db.ts";

import type { Pool } from "pg";

/**
 * A dropped Postgres connection must not be a dropped process.
 *
 * Named after the rule rather than after `server/db.ts`, because that module's
 * other guarantee already has a file of its own in `tests/numeric.test.ts`.
 *
 * The finding these reproduce (`LEAD-8`): the pool was built with no `error`
 * listener anywhere in the tree, so a Postgres restart — or anything else that
 * closes a connection out from under the application — reached Node as an
 * `error` event on an EventEmitter with no listener, and took the whole
 * process down with `throw er; // Unhandled 'error' event`.
 *
 * Two things make these tests real rather than decorative:
 *
 * - **The kill is by backend pid, never by `datname`.** The suite shares one
 *   database, so terminating every backend on it would kill the harness pool
 *   and the other test files with it. Each test asks its own connection for
 *   `pg_backend_pid()` and terminates exactly that one.
 * - **The assertion waits on the production `console.error` spy.** Adding a
 *   listener from the test would itself be the thing that prevents the crash,
 *   so such a test passes against unfixed code. Waiting on the message the
 *   handler in `createPool` logs is what makes the test fail without the fix.
 *
 * Requires a database. See `compose.test.yaml`:
 *   docker compose -f compose.test.yaml up -d --wait
 */
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://portfolio:portfolio@127.0.0.1:55432/portfolio_test";

/** The pool under test, and a second one holding the connection that does the killing. */
let pool: Pool;
let executioner: Pool;

beforeAll(async () => {
  pool = createPool(TEST_DATABASE_URL);
  executioner = createPool(TEST_DATABASE_URL);

  try {
    await executioner.query("select 1");
  } catch (cause) {
    throw new Error(
      `Cannot reach the test database at ${TEST_DATABASE_URL}.\n` +
        "Start it with: docker compose -f compose.test.yaml up -d --wait\n" +
        "or point TEST_DATABASE_URL at your own throwaway Postgres.",
      { cause },
    );
  }
});

// Both, or the run hangs on open handles rather than finishing.
afterAll(async () => {
  await pool.end().catch(() => {});
  await executioner.end().catch(() => {});
});

/** Terminate one backend by pid, from a connection that is not the victim. */
async function terminate(pid: number): Promise<void> {
  await executioner.query("select pg_terminate_backend($1)", [pid]);
}

/**
 * Resolve once `console.error` has been called with a message containing
 * `stem`, or reject after `timeoutMs`.
 *
 * The stem, not the whole sentence: the test pins that the production handler
 * ran, not how it is worded.
 */
function awaitLoggedError(stem: string, timeoutMs = 5_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      if (typeof args[0] === "string" && args[0].includes(stem)) {
        clearTimeout(timer);
        spy.mockRestore();
        resolve();
      }
    });
    const timer = setTimeout(() => {
      spy.mockRestore();
      reject(new Error(`No console.error containing "${stem}" within ${timeoutMs}ms.`));
    }, timeoutMs);
  });
}

describe("a pool whose connection is closed underneath it", () => {
  it("survives a backend terminated while the client is idle in the pool", async () => {
    // The `LEAD-8` reproduction as an operator meets it: a connection sitting
    // in the pool between requests when Postgres restarts. `pg-pool` re-emits
    // an idle client's error on the pool, so this half is the pool handler's.
    const logged = awaitLoggedError("Postgres pool error");

    const client = await pool.connect();
    const { rows } = await client.query<{ pid: number }>("select pg_backend_pid() as pid");
    client.release();

    await terminate(rows[0]!.pid);
    await logged;

    // Survival is not enough: the pool must still be usable afterwards.
    const { rows: after } = await pool.query<{ ok: number }>("select 1 as ok");
    expect(after[0]?.ok).toBe(1);
  });

  it("survives a backend terminated while the client is checked out", async () => {
    // The half the pool handler does not cover, and the reason both listeners
    // exist. `pg-pool` removes its idle listener on checkout
    // (`pg-pool/index.js:344`), so a client held across an await — which is
    // exactly what the price poller does over its round trip to the quote
    // provider — emits its error on the client and nowhere else.
    const logged = awaitLoggedError("Postgres client error");

    const client = await pool.connect();
    try {
      const { rows } = await client.query<{ pid: number }>("select pg_backend_pid() as pid");

      // Held, doing something that is not database traffic.
      const killed = terminate(rows[0]!.pid);
      await new Promise((r) => setTimeout(r, 250));
      await killed;

      await logged;
    } finally {
      client.release();
    }

    const { rows: after } = await pool.query<{ ok: number }>("select 1 as ok");
    expect(after[0]?.ok).toBe(1);
  });

  it("rejects the in-flight query rather than leaving it hanging", async () => {
    // The feared side effect of swallowing a client error: a caller awaiting a
    // query that never settles would be worse than a crash. It cannot happen —
    // `pg` calls `_errorAllQueries` immediately before `emit('error')`
    // (`pg/lib/client.js:421-422`), so the rejection is already queued by the
    // time the handler runs.
    const client = await pool.connect();
    try {
      const { rows } = await client.query<{ pid: number }>("select pg_backend_pid() as pid");
      const sleeping = client.query("select pg_sleep(30)");

      await new Promise((r) => setTimeout(r, 100));
      await terminate(rows[0]!.pid);

      await expect(sleeping).rejects.toThrow();
    } finally {
      client.release();
    }
  });
});
