import { isDatabaseReachable } from "~/lib/db.server";

/**
 * `GET /healthz` — 200 while the instance is genuinely serving, non-200
 * otherwise. Compose, a reverse proxy and any monitoring read this.
 *
 * Two deliberate non-goals:
 *
 * - It does not check the price provider. A health check that fails on a
 *   third-party outage would make Compose restart a perfectly healthy app.
 * - It never requires authentication, so monitoring needs no credentials. The
 *   optional login gate must exempt this path.
 *
 * Today it checks database reachability only; the migrations slice extends it
 * to assert that every migration on disk is recorded as applied.
 */
export async function loader() {
  const databaseReachable = await isDatabaseReachable();

  return Response.json(
    { status: databaseReachable ? "ok" : "unhealthy", database: databaseReachable },
    {
      status: databaseReachable ? 200 : 503,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
