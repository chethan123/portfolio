/** `pricing.worker` never gates the HTTP status here — only `database`/`migrations` do. */
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
