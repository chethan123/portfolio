/**
 * `GET /healthz`'s body and status, as a pure function of a database report and a worker
 * reachability (spec price-health/02). Pulled out of the route so the database × worker matrix is
 * testable without `withDatabase` or a socket — `pricing.worker` never gates the HTTP status; only
 * `database`/`migrations` do, unchanged from before this key existed.
 */
import type { HealthReport } from "./db.server.ts";
import type { WorkerReachability } from "./worker-reachability.server.ts";

export type HealthzBody = {
  status: "ok" | "unhealthy";
  database: boolean;
  migrations: "current" | "pending";
  pendingMigrations: string[];
  pricing: { worker: WorkerReachability };
};

export function healthzResponse(
  health: HealthReport,
  worker: WorkerReachability,
): { body: HealthzBody; status: number } {
  return {
    body: {
      status: health.healthy ? "ok" : "unhealthy",
      database: health.database,
      migrations: health.pendingMigrations.length === 0 ? "current" : "pending",
      pendingMigrations: health.pendingMigrations,
      pricing: { worker },
    },
    status: health.healthy ? 200 : 503,
  };
}
