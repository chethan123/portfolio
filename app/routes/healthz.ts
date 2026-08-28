import { checkHealth } from "~/lib/db.server";

/**
 * `GET /healthz` — 200 while the instance is genuinely serving, non-200
 * otherwise. Compose, a reverse proxy and any monitoring read this.
 *
 * It answers two questions, both of which have to be yes:
 *
 * - Is the database reachable?
 * - Is every migration present on disk recorded as applied? A pending one means
 *   the image and the database disagree, so the instance is serving pages
 *   against a schema older than the code reading it.
 *
 * Two deliberate non-goals:
 *
 * - It does not check the price provider. A health check that fails on a
 *   third-party outage would make Compose restart a perfectly healthy app.
 * - It never requires authentication, so monitoring needs no credentials. The
 *   app enforces nothing either way; the gate in front is what has to exempt
 *   this path, and its Caddyfile is now the only list of such exemptions
 *   anywhere in the deployment.
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
