# 01 — Worker reachability on `/healthz`

_Part of [0021-price-health.md](../0021-price-health.md)._

**What to build:** A bounded `GET /healthz` probe over the configured worker Unix socket, owned by
`app/lib/provider-socket.server.ts`, and a non-gating `pricing` object in the app's health response.
It answers whether the app process can reach the worker listener through its own mount. It never
calls Yahoo and never decides the route's HTTP status.

Separate because app-to-worker reachability is useful on its own and can be tested without changing
the poller's state model. This pull request changes one public machine contract deliberately and
updates every document and exact-body test which owns that contract.

**Blocked by:** Nothing.

**Status:** ready-for-agent

**The probe**

- [ ] Export a narrow worker-reachability check beside the existing Unix-socket transport; do not
      route it through `ask`, duplicate `ask`, or put socket transport in `db.server.ts`
- [ ] Send `GET /healthz` with `agent: false` to `getConfig().PRICE_WORKER_SOCKET`
- [ ] Accept only HTTP 200, `application/json`, at most 1 KiB, and exactly `{"ok":true}`; a
      malformed, oversized, incomplete, extra-key, or non-200 response is unavailable
- [ ] Bound the whole exchange to 500 ms, including connection, headers and body; destroy the request
      on timeout and consume/destroy every response
- [ ] Map every error to `available | unavailable`; never throw it out of the app health loader and
      never return a path, code, message, or timing detail publicly
- [ ] Coalesce concurrent calls into one in-flight request and cache both outcomes for five seconds
      per app process; a transition is observable no later than the next call after that window
- [ ] A test seam controls time/cache reset without exporting production mutation or using a mocked
      provider response

**The first health contract**

- [ ] `GET /healthz` always includes
      `pricing: { status: "unknown" | "degraded", worker: "available" | "unavailable" }`
- [ ] `pricing.status` is `unknown` when the worker is available because this ticket has no
      scheduler claim; it is `degraded` when the worker is unavailable
- [ ] Run database health and the bounded worker check concurrently
- [ ] Worker unavailable plus healthy/current database returns HTTP 200 and top-level `status: "ok"`
- [ ] Worker available plus unhealthy database returns HTTP 503 and top-level `status: "unhealthy"`
- [ ] Preserve `database`, `migrations`, `pendingMigrations`, and `Cache-Control: no-store` exactly
- [ ] Extract a pure response composition helper, or an equivalently narrow dependency seam, so the
      independent database/pricing status cases are tested without module mocking or breaking the
      process-wide test pool

**Tests that carry the boundary**

- [ ] A real temporary Unix listener proves a valid worker answer becomes available
- [ ] Missing socket, non-200, invalid JSON, oversized body, early close and a listener which never
      answers all become unavailable within the deadline
- [ ] Concurrent calls produce one socket request; cached success and failure are reused, expire,
      and observe recovery
- [ ] Route tests pin the whole additive JSON body and both independent HTTP-status cases
- [ ] No test makes a Yahoo request or spends a quotes/history admission

**Documents**

- [ ] Add a superseding banner to the old absolute claims in `docs/specs/0002-pricing.md` and
      `docs/specs/pricing/04-in-process-poller.md`: pricing still never gates health, but worker
      reachability is now reported
- [ ] `ARCHITECTURE.md` names the app-side probe and its five-second observation lag
- [ ] `docs/operating.md` and `docs/runbook.md` tell monitors to inspect the JSON attribute while
      continuing to alert on HTTP non-200 for app/database failure
- [ ] They say explicitly that worker availability proves neither `egress-proxy` nor Yahoo
