import type { Pool, PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { createPool } from "../server/db.ts";
import { TEST_DATABASE_URL } from "./support/database.ts";

const CONNECTION_ERROR_MESSAGE = "Postgres connection error:";

describe("Postgres pool resilience", () => {
  let subjectPool: Pool;
  let controllerPool: Pool;
  let heldClient: PoolClient | undefined;

  beforeAll(async () => {
    subjectPool = createPool(TEST_DATABASE_URL);
    controllerPool = createPool(TEST_DATABASE_URL);

    try {
      await controllerPool.query("select 1");
    } catch (cause) {
      await Promise.allSettled([subjectPool.end(), controllerPool.end()]);
      throw new Error(
        `Cannot reach the test database at ${TEST_DATABASE_URL}.\n` +
          "Start it with: docker compose -f compose.test.yaml up -d\n" +
          "or point TEST_DATABASE_URL at your own throwaway Postgres.",
        { cause },
      );
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    heldClient?.release(true);
    heldClient = undefined;
    await Promise.allSettled([subjectPool?.end(), controllerPool?.end()]);
  });

  function waitForConnectionError() {
    let resolveError: (() => void) | undefined;
    const errorReported = new Promise<void>((resolve) => {
      resolveError = resolve;
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      if (args[0] === CONNECTION_ERROR_MESSAGE) {
        resolveError?.();
      }
    });

    return { errorReported, errorSpy };
  }

  it("logs an error when Postgres terminates an idle client", async () => {
    const result = await subjectPool.query<{ pid: number }>("select pg_backend_pid() as pid");
    const pid = result.rows[0]?.pid;
    expect(pid).toBeTypeOf("number");

    const { errorReported, errorSpy } = waitForConnectionError();
    const termination = await controllerPool.query<{ terminated: boolean }>(
      "select pg_terminate_backend($1) as terminated",
      [pid],
    );
    expect(termination.rows[0]?.terminated).toBe(true);
    await errorReported;

    expect(errorSpy).toHaveBeenCalledWith(CONNECTION_ERROR_MESSAGE, expect.any(Error));
  });

  it("logs an error when Postgres terminates a checked-out client", async () => {
    heldClient = await subjectPool.connect();
    const result = await heldClient.query<{ pid: number }>("select pg_backend_pid() as pid");
    const pid = result.rows[0]?.pid;
    expect(pid).toBeTypeOf("number");

    const { errorReported, errorSpy } = waitForConnectionError();
    try {
      const termination = await controllerPool.query<{ terminated: boolean }>(
        "select pg_terminate_backend($1) as terminated",
        [pid],
      );
      expect(termination.rows[0]?.terminated).toBe(true);
      await errorReported;

      expect(errorSpy).toHaveBeenCalledWith(CONNECTION_ERROR_MESSAGE, expect.any(Error));
    } finally {
      heldClient.release(true);
      heldClient = undefined;
    }
  });
});
