/**
 * `GET /healthz`'s `pricing.worker` key (spec price-health/02): a bounded, cached, single-flight
 * check that *this app process* can reach the price worker's own `GET /healthz` over its unix
 * socket. Narrower than it sounds — it proves app → shared mount → worker listener, nothing past
 * that. The worker answers this path above both its rate limiters and before any Yahoo call
 * (`server/price-worker.ts`), so a probe never spends quote/history budget and never touches Yahoo;
 * it also proves nothing about `egress-proxy` or Yahoo, only that the worker's own listener answered.
 *
 * Unlike `provider-socket.server.ts` (whose header promises nothing is remembered between calls),
 * this module deliberately memoises. `/healthz` is one of only two paths Caddy exempts from the
 * gate, and the worker accepts eight connections at a time with no keep-alive — one held for the
 * lifetime of every probe. Single-flight bounds concurrent callers to one in-flight request; the
 * five-second cache bounds a sequential flood the same way. The cost is a transition (worker dies or
 * recovers) taking up to five seconds to show up here.
 *
 * Test seam: {@link createWorkerHealthProbe} builds an instance with its own cache, so a test never
 * resets a shared global. `check`'s `now` is a parameter, not a faked global clock.
 */
import { getConfig } from "../../server/config.ts";

import { socketRequest } from "./socket-transport.server.ts";

export type WorkerReachability = "available" | "unavailable";

/** Whole-exchange budget, deliberately unlike the `5000` socket-inactivity timers used for the
 * once-only deploy-time probes (`compose.yaml`, `docs/operating.md`, `scripts/smoke-test.sh`) — this
 * one runs on a live, unauthenticated request path. */
const DEADLINE_MS = 500;

/** The worker's own `/healthz` body is eleven bytes; this is a refusal threshold, not a real budget. */
const BODY_CAP_BYTES = 1024;

const CACHE_MS = 5_000;

function isExactlyOk(value: unknown): boolean {
  // Deep-equal to `{ ok: true }` — an extra key (a future worker field this probe doesn't know
  // about) is a refusal, not a success, so the accepted shape never silently widens.
  if (typeof value !== "object" || value === null) return false;
  const keys = Object.keys(value);
  return keys.length === 1 && (value as { ok?: unknown }).ok === true;
}

async function probeOnce(): Promise<WorkerReachability> {
  const result = await socketRequest({
    socketPath: getConfig().PRICE_WORKER_SOCKET,
    method: "GET",
    path: "/healthz",
    deadlineMs: DEADLINE_MS,
    capBytes: BODY_CAP_BYTES,
  });

  if (!result.ok) return "unavailable";

  const { status, headers, body } = result.response;
  if (status !== 200) return "unavailable";
  if (headers["content-type"] !== "application/json") return "unavailable";

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    return "unavailable";
  }

  return isExactlyOk(parsed) ? "available" : "unavailable";
}

export type WorkerHealthProbe = {
  check(now?: number): Promise<WorkerReachability>;
};

type CacheEntry = { result: WorkerReachability; expiresAt: number };

export function createWorkerHealthProbe(): WorkerHealthProbe {
  let cached: CacheEntry | undefined;
  let inFlight: Promise<WorkerReachability> | undefined;

  return {
    check(now = Date.now()): Promise<WorkerReachability> {
      if (cached !== undefined && now < cached.expiresAt) return Promise.resolve(cached.result);

      // Concurrent callers before this resolves all get this same promise — one socket request,
      // never one per caller, regardless of how many arrived in the cache's dead time.
      inFlight ??= probeOnce()
        .then((result) => {
          cached = { result, expiresAt: now + CACHE_MS };
          return result;
        })
        .finally(() => {
          inFlight = undefined;
        });

      return inFlight;
    },
  };
}

/** The one instance the app actually calls; tests build their own via {@link createWorkerHealthProbe}. */
export const workerHealthProbe = createWorkerHealthProbe();
