import { checkHealth } from "~/lib/db.server";
import { healthzResponse } from "~/lib/health-response";
import { readPollerSnapshot } from "~/lib/price-poller.server";
import { workerHealthProbe } from "~/lib/worker-reachability.server";

/**
 * `GET /healthz` — 200 iff database reachable and no pending migration; `pricing` never changes that
 * status. `pricing.worker` is a *listener* check, proving only that this process's own socket mount
 * reaches the worker, not that Yahoo or `egress-proxy` are up. `pricing.scheduler` and
 * `pricing.quotes` are read passively off the price poller's own live state (spec price-health/03):
 * this loader never starts, stops or retimes the poller, and never fetches a quote — it only reads
 * the snapshot the root middleware's own arming already produced. No auth — must stay on
 * `LOCK_EXEMPT_PATHS` (app/root.tsx, docs/adr/0012).
 */
export async function loader() {
  const [health, worker] = await Promise.all([checkHealth(), workerHealthProbe.check()]);
  const { body, status } = healthzResponse(health, worker, readPollerSnapshot());

  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}
