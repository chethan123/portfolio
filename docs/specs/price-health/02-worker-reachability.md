# 02 — Worker reachability on `/healthz`

_Part of [0021-price-health.md](../0021-price-health.md)._

**What to build:** Extract the Unix-socket transport that `app/lib/provider-socket.server.ts`'s
`ask` already owns, build a bounded, cached `GET /healthz` probe of the worker on top of it, and add
a non-gating `pricing` object to the app's health response carrying exactly one key: `worker`.

It answers whether *this app process* can reach the worker listener through its own read-only mount.
It never calls Yahoo, never spends the worker's quote or history rate budget, and never decides the
route's HTTP status.

Separate because app-to-worker reachability is useful on its own and needs no poller change. It ships
one key and one closed set, so nothing it publishes is redefined by ticket 03.

**Blocked by:** Nothing.

**Status:** ready-for-agent

## What already exists

- The worker answers `GET /healthz` over its socket with HTTP 200,
  `content-type: application/json`, and exactly the eleven bytes `{"ok":true}`
  (`server/price-worker.ts:285-288`, `sendJson` at `:88-92`). It answers **above** both rate limiters
  (`handleQuotes` at `:291`, `handleHistory` at `:296`, admissions taken in `readAdmittedBody` at
  `:226-229`), so a probe structurally cannot spend provider budget. Non-`GET` on that path is a 400.
- The socket is mounted into `app` read-only at `compose.yaml:139`; the path comes from
  `getConfig().PRICE_WORKER_SOCKET` (`server/config.ts:38`, `:136`), and `getConfig()` memoises on
  first read (`:209`).
- The app can already dial it — `scripts/smoke-test.sh:441-454` does, once, at deploy.
- `server.maxConnections = 8` and `server.maxRequestsPerSocket = 1`
  (`server/price-worker.ts:350-351`): no keep-alive, so each probe holds one of eight for its
  lifetime. `ask` already uses `agent: false` (`app/lib/provider-socket.server.ts:90`).
- `app/routes/healthz.ts` is 23 lines: `checkHealth()` from `~/lib/db.server`, a JSON body, 200/503,
  `Cache-Control: no-store`. `tests/routes/healthz.test.ts:20-26` pins the body with `toEqual` and a
  comment saying a renamed or dropped key must fail there — that test is *meant* to break here.

## Extract the transport; do not copy it

`ask` (`app/lib/provider-socket.server.ts:65`) is provider-operation semantics — `POST /${kind}`,
15/35-second budgets (`:32-35`), 512 KiB/2 MiB caps (`:41-44`), and error mapping that surfaces the
worker's own message. None of that belongs in a health probe. But its *transport* is exactly what a
probe needs, and it contains five mechanics that a hand-written second copy gets wrong:

| Mechanic | Where in `ask` | Why it matters |
|---|---|---|
| settle-once guard | `:76-82` | otherwise a late `error` rejects an already-resolved probe |
| byte-accumulating cap with `req.destroy()` | `:97-105` | otherwise a hostile or broken body is unbounded |
| `err.syscall === "connect"` branch | `:153-157` | the missing-socket case, which is the common one |
| abort branch | `:160-168` | the deadline has to actually settle the promise |
| `close`-before-`end` guard | `:175-177` | **without it the probe hangs** — the exact failure it exists to detect |

- [ ] Move the transport into its own module — a request function taking a socket path, method, path,
      optional body, a whole-exchange deadline, and a byte cap.
- [ ] **It must return a discriminated failure, not just bytes.** A transport returning only
      `{ status, contentType, body }` cannot satisfy the next bullet, because `ask`'s pinned messages
      are built from failure *kinds* only the transport can tell apart:
      `tests/provider-socket.test.ts:218` and `:243` need the `connect` errno (`ENOENT`, `ENOTDIR`);
      `:296` needs the deadline distinguished ("did not answer quotes within 200ms"); `:343` needs
      close-before-end ("connection closed before the quotes answer completed"); `:314` and `:326`
      need cap-exceeded ("exceeded 524288 bytes"). Return a success case plus
      `connect` / `timeout` / `closed` / `capped` with the errno where there is one, and leave every
      word of the operator-facing wording in `ask`.
- [ ] Rewrite `ask` to use it, keeping every provider-specific behaviour where it is: the budgets,
      the caps, the `ProviderUnreachable` / error-text mapping, and the `getConfig()`-per-call read.
- [ ] **`tests/provider-socket.test.ts` must pass untouched.** That is the proof the extraction
      preserved behaviour; if a test there needs editing, the extraction changed something it should
      not have.

## The probe

- [ ] A new module — not `provider-socket.server.ts`, whose header promises "Nothing is remembered
      between calls, so a recovery is never delayed" (`:5`) and which already exports a
      differently-meaning `socketProbe` (`:261`). This one memoises on purpose.
- [ ] `GET /healthz` with `agent: false` to `getConfig().PRICE_WORKER_SOCKET`.
- [ ] Accept only: HTTP 200, `content-type` `application/json`, body at most 1 KiB, and the parsed
      body deep-equal to `{ ok: true }` — an extra key is a refusal. Everything else — non-200,
      wrong content type, oversized, malformed JSON, early close, `ENOENT`, `EACCES`, timeout — is
      `unavailable`.
- [ ] A 500 ms whole-exchange deadline covering connection, headers and body. Destroy the request on
      timeout; consume or destroy every response body.
- [ ] Never throws out of the route. Never returns or logs a socket path, error code, message, or
      timing to the response.
- [ ] Single-flight: concurrent calls share one in-flight request. Cache both outcomes for five
      seconds per app process, so a transition is visible no later than the next call after the
      window. Rationale for the cache, worth a comment: `/healthz` is one of only two un-gated
      handles through Caddy (`Caddyfile:20-22`), and single-flight bounds concurrency but not a
      sequential flood against eight one-shot connections.
- [ ] Test seam without exporting production mutation: export a factory that builds a probe with its
      own cache, and have the module-level export be one shared instance. Tests build their own
      instance instead of resetting a global. Take `now` as an optional argument rather than reading
      a faked global clock.

## The health contract

- [ ] `GET /healthz` always includes `pricing: { "worker": "available" | "unavailable" }` — that key
      and no other. `ok`, `scheduler` and `quotes` arrive in ticket 03.
- [ ] Run `checkHealth()` and the probe concurrently, so the route's worst case is the slower of the
      two rather than their sum. Both compose healthchecks allow 5 s (`compose.yaml:151-160`,
      `:329-334`).
- [ ] Worker unavailable with a healthy, current database: HTTP `200`, top-level `status: "ok"`.
- [ ] Worker available with an unhealthy database or a pending migration: HTTP `503`, top-level
      `status: "unhealthy"`.
- [ ] `database`, `migrations`, `pendingMigrations` and `Cache-Control: no-store` are unchanged.
- [ ] Extract a pure body-composition helper — given a health report and a reachability, return the
      body object and the HTTP status — so the four database × worker cases are tested without module
      mocking and without fighting the process-wide test pool. Not an injected argument on the
      loader: React Router owns that signature (`Route.LoaderArgs`), and
      `tests/routes/healthz.test.ts:17` calls `loader()` with none. `tests/routes/healthz.test.ts:5-6` explains why the unhealthy database
      branch is not reachable there today.

## Tests

- [ ] A real temporary Unix listener answering `{"ok":true}` yields `available`.
      `tests/provider-socket.test.ts:333-421` already builds these; copy the pattern, and point
      `PRICE_WORKER_SOCKET` at the temp path *before* the first `getConfig()`.
- [ ] Each of these yields `unavailable` within the deadline: no socket file at all; HTTP 500;
      HTTP 200 with `text/plain`; valid JSON that is not `{"ok":true}` (include `{"ok":true,"x":1}`);
      malformed JSON; a body over 1 KiB; a listener that accepts and never answers; a listener that
      closes mid-body.
- [ ] Concurrent calls produce exactly one socket request. A cached `available` and a cached
      `unavailable` are both reused inside the window, both expire, and a recovery is observed after
      it.
- [ ] Route tests pin the whole additive JSON body — `toEqual`, as today — and both independent HTTP
      status cases.
- [ ] No test in this ticket makes a Yahoo request or spends a quotes/history admission.

## Documents

- [ ] `app/routes/healthz.ts:4-6` — its docstring says "No price-provider check". Still true and now
      easy to misread: the probe is a *listener* check, not a provider check. Say which.
- [ ] `ARCHITECTURE.md:1613` — "Never crosses the socket — silent on whether `worker` or
      `egress-proxy` are even running" is now false for `worker` and still true for `egress-proxy`.
- [ ] `ARCHITECTURE.md:1627-1628` — "Three healthchecks now, and no two of them prove the same
      thing" is the paragraph this ticket most directly changes: the app's own now proves one hop
      the worker's cannot.
- [ ] `ARCHITECTURE.md` Appendix A — this ticket adds up to two modules (the transport and the
      probe). Appendix A maps every module (`CLAUDE.md`), and `provider-socket.server.ts` sits at
      `:2163`; the new rows go beside it.
- [ ] `docs/operating.md:298` — "the `/healthz` above is `app`'s own and never crosses the socket".
- [ ] `docs/operating.md` and `docs/runbook.md`: tell a monitor to alert on HTTP non-200 for
      app/database failure and to read `pricing.worker` separately. Say explicitly that
      `worker: available` proves neither `egress-proxy` nor Yahoo, and that the five-second cache
      means a transition can lag by that much.
- [ ] Explain the deadline divergence somewhere an operator will meet it: `compose.yaml:196`,
      `docs/operating.md:306` and `scripts/smoke-test.sh:451` all use `5000`, but those are
      socket-inactivity timers on a once-only probe, while this is a whole-exchange deadline on a
      request path.
- [ ] Superseding banners on the absolute claims in `docs/specs/0002-pricing.md:164-165` and `:332-334`
      and `docs/specs/pricing/04-in-process-poller.md:34-36`: pricing still never gates health, but
      worker reachability is now reported.
