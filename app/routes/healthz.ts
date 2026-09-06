import { checkHealth } from "~/lib/db.server";

/**
 * `GET /healthz` — 200 iff database reachable and no pending migration.
 * No price-provider check (a third-party outage shouldn't restart a
 * healthy app), no auth — must stay on `LOCK_EXEMPT_PATHS` (app/root.tsx, docs/adr/0012).
 */
export async function loader() {
  const health = await checkHealth();

  return Response.json(
    {
      status: health.healthy ? "ok" : "unhealthy",
      database: health.database,
      migrations: health.pendingMigrations.length === 0 ? "current" : "pending",
      pendingMigrations: health.pendingMigrations,
    },
    {
      status: health.healthy ? 200 : 503,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
