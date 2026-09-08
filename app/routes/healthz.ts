import { checkHealth } from "~/lib/db.server";
import { healthzResponse } from "~/lib/health-response";
import { workerHealthProbe } from "~/lib/worker-reachability.server";

/**
 * `GET /healthz` — 200 iff database reachable and no pending migration; `pricing.worker` never
 * changes that status. No price-provider check (a third-party outage shouldn't restart a healthy
 * app) — `pricing.worker` is a *listener* check, proving only that this process's own socket mount
 * reaches the worker, not that Yahoo or `egress-proxy` are up. No auth — must stay on
 * `LOCK_EXEMPT_PATHS` (app/root.tsx, docs/adr/0012).
 */
export async function loader() {
  const [health, worker] = await Promise.all([checkHealth(), workerHealthProbe.check()]);
  const { body, status } = healthzResponse(health, worker);

  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}
