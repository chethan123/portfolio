/** `pricing` never gates the HTTP status here — only `database`/`migrations` do. */
import {
  pricingHealth,
  type PollerSnapshot,
  type PricingHealth,
  type WorkerReachability,
} from "./price-health.ts";

import type { HealthReport } from "./db.server.ts";

export type HealthzBody = {
  status: "ok" | "unhealthy";
  database: boolean;
  migrations: "current" | "pending";
  pendingMigrations: string[];
  pricing: PricingHealth;
};

export function healthzResponse(
  health: HealthReport,
  worker: WorkerReachability,
  snapshot: PollerSnapshot,
  now: Date = new Date(),
): { body: HealthzBody; status: number } {
  return {
    body: {
      status: health.healthy ? "ok" : "unhealthy",
      database: health.database,
      migrations: health.pendingMigrations.length === 0 ? "current" : "pending",
      pendingMigrations: health.pendingMigrations,
      pricing: pricingHealth(snapshot, worker, now),
    },
    status: health.healthy ? 200 : 503,
  };
}
