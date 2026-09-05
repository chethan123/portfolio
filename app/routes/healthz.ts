import { checkHealth } from "~/lib/db.server";

/**
 * `GET /healthz` — 200 while the instance is genuinely serving; Compose, the
 * proxy and monitoring read it. Two questions, both must be yes: database
 * reachable, and every migration on disk recorded as applied — a pending one
 * means pages served against a schema older than the code reading them.
 *
 * Two non-goals: no price-provider check (failing on a third-party outage
 * would make Compose restart a healthy app), and no authentication, so
 * monitoring needs no credentials — the gate in front must exempt this path,
 * which its Caddyfile used to be the only list of such exemptions for. This
 * path is on the app's own lock's exempt list too now (`LOCK_EXEMPT_PATHS`,
 * `app/root.tsx`, docs/adr/0012) — a locked instance still answers `/healthz`
 * with no passkey check, since monitoring can hold no credential for one
 * either. That array is pinned by a test that fails the moment it grows.
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
