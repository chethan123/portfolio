// The bounded, cached, single-flight `/healthz` probe of the worker's own listener (spec
// price-health/02). Real temp unix listeners throughout, following provider-socket.test.ts's
// pattern — a raw node:http server for the failure shapes `startWorker` itself can't produce, the
// real `startWorker` for the happy path and for proving no rate-limiter admission is spent.
import { randomBytes } from "node:crypto";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createWorkerHealthProbe } from "~/lib/worker-reachability.server";

import { startWorker } from "../server/price-worker.ts";

import type { YahooClient } from "../server/yahoo-client.ts";

const SOCKET_PATH = join(tmpdir(), `whsock-${randomBytes(4).toString("hex")}.sock`);
// getConfig() memoises on first read — set before any check() in this file ever calls it.
process.env.PRICE_WORKER_SOCKET = SOCKET_PATH;

let currentServer: http.Server | undefined;

afterEach(async () => {
  if (currentServer === undefined) return;
  await new Promise<void>((resolve) => currentServer!.close(() => resolve()));
  currentServer = undefined;
});

function listen(server: http.Server): Promise<void> {
  currentServer = server;
  return new Promise<void>((resolve) => server.listen(SOCKET_PATH, resolve));
}

const REFUSING_YAHOO: YahooClient = {
  quote: () => {
    throw new Error("the probe must never spend a quotes admission");
  },
  chart: () => {
    throw new Error("the probe must never spend a history admission");
  },
};

describe("createWorkerHealthProbe().check", () => {
  it("answers available for the worker's real GET /healthz", async () => {
    currentServer = await startWorker({ socketPath: SOCKET_PATH, yahoo: REFUSING_YAHOO });

    const probe = createWorkerHealthProbe();
    expect(await probe.check()).toBe("available");
  });

  it("answers unavailable, well within a second, when no socket file exists at all", async () => {
    const startedAt = Date.now();
    const probe = createWorkerHealthProbe();

    expect(await probe.check()).toBe("unavailable");
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it("answers unavailable for a non-200 status", async () => {
    await listen(
      http.createServer((_req, res) => {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      }),
    );

    expect(await createWorkerHealthProbe().check()).toBe("unavailable");
  });

  it("answers unavailable for a 200 with the wrong content-type", async () => {
    await listen(
      http.createServer((_req, res) => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(JSON.stringify({ ok: true }));
      }),
    );

    expect(await createWorkerHealthProbe().check()).toBe("unavailable");
  });

  it("answers unavailable for valid JSON that is not exactly { ok: true }", async () => {
    await listen(
      http.createServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, x: 1 }));
      }),
    );

    expect(await createWorkerHealthProbe().check()).toBe("unavailable");
  });

  it("answers unavailable for malformed JSON", async () => {
    await listen(
      http.createServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("not json");
      }),
    );

    expect(await createWorkerHealthProbe().check()).toBe("unavailable");
  });

  it("answers unavailable for a body over the 1 KiB cap", async () => {
    await listen(
      http.createServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, padding: "x".repeat(2000) }));
      }),
    );

    expect(await createWorkerHealthProbe().check()).toBe("unavailable");
  });

  it(
    "answers unavailable, at the deadline, for a listener that accepts and never answers",
    async () => {
      await listen(http.createServer(() => undefined));

      const startedAt = Date.now();
      expect(await createWorkerHealthProbe().check()).toBe("unavailable");
      // Well under the 5s test timeout — this pins the 500ms whole-exchange deadline, not the
      // suite's own budget.
      expect(Date.now() - startedAt).toBeLessThan(2_000);
    },
    5_000,
  );

  it("answers unavailable, well within its deadline, for a listener that closes mid-body", async () => {
    await listen(
      http.createServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/json", "content-length": "1000" });
        res.write("x".repeat(5));
        setImmediate(() => res.socket?.destroy());
      }),
    );

    const startedAt = Date.now();
    expect(await createWorkerHealthProbe().check()).toBe("unavailable");
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it("issues exactly one socket request for concurrent callers sharing the in-flight probe", async () => {
    let requests = 0;
    await listen(
      http.createServer((_req, res) => {
        requests += 1;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      }),
    );

    const probe = createWorkerHealthProbe();
    const results = await Promise.all([probe.check(), probe.check(), probe.check()]);

    expect(requests).toBe(1);
    expect(results).toEqual(["available", "available", "available"]);
  });

  it("caches an outcome for five seconds, then reflects a failure or a recovery after the window", async () => {
    await listen(
      http.createServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      }),
    );

    const probe = createWorkerHealthProbe();
    let now = 1_000_000;

    expect(await probe.check(now)).toBe("available");

    // Stop the listener — a fresh probe issued right now would see nothing at all, so a reused
    // cache is the only way the next call can still answer "available".
    await new Promise<void>((resolve) => currentServer!.close(() => resolve()));
    currentServer = undefined;

    now += 1_000; // still inside the five-second window from the first check
    expect(await probe.check(now)).toBe("available");

    now += 4_500; // now 5.5s past the first check: past the window
    expect(await probe.check(now)).toBe("unavailable");

    // Recovery: the worker comes back, and a full window has to pass before it's reflected.
    await listen(
      http.createServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      }),
    );

    now += 1_000; // still inside the window the unavailable check just opened
    expect(await probe.check(now)).toBe("unavailable");

    now += 4_100; // past that window too
    expect(await probe.check(now)).toBe("available");
  });

  it("spends no quotes or history admission across many probes, even past the worker's own rate caps", async () => {
    currentServer = await startWorker({ socketPath: SOCKET_PATH, yahoo: REFUSING_YAHOO });

    // Each fresh instance has its own empty cache, so every check() below is a real socket round
    // trip — well past the worker's 10-per-minute quotes and 20-per-minute history caps, which
    // /healthz answers above (server/price-worker.ts). REFUSING_YAHOO throws if either is ever
    // reached, which would fail this test via an unhandled rejection inside the worker.
    for (let i = 0; i < 25; i += 1) {
      expect(await createWorkerHealthProbe().check()).toBe("available");
    }
  });
});
