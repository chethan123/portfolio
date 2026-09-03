# 04 — App cutover and network lockdown

_Part of [0018-price-worker.md](../0018-price-worker.md) (§3.1, §3.4, §3.5)._

**What to build:** The single release where the app stops fetching and loses its internet route.
Three app-side modules swap the in-process Yahoo paths for the mailbox; the compose topology becomes
the full six networks; the superuser password stops having a default. After this ticket, a trojan in
the app has no socket to anywhere, and the only fetcher sees ticker symbols.

**Blocked by:** 03 (the worker must already be running and proven in production, or this commit
deploys an instance with no price refresh).

**Status:** ready-for-agent

**The app-side modules (routes stay thin)**

- [ ] `app/lib/refresh-mailbox.server.ts` owns sweep, candidate selection, dedupe, insert and
      poll-to-deadline (~8s). It calls the existing `selectBackfillCandidates`
      (`prices.server.ts:295-345`) and writes the request row plus its `backfill_candidate` rows in
      one transaction.
- [ ] `app/routes/refresh.ts` keeps its one-call shape (`run()`, `:58`) and stops importing
      `refreshPrices`/`withRefreshLock`/`yahooPriceProvider` (`:14-15`). Its `done` variant keeps
      reporting the quotes half only, as today (`:74-81`, by design at `:61-65`).
- [ ] Dedupe: an open `pending`/`running` row younger than the deadline is `{ status: "busy" }` —
      the same meaning today's held lock has (`:72`); deadline expiry is the new
      `{ status: "worker-unresponsive" }`, rendered distinctly from `providerFailed` and `error`
- [ ] The dedupe rule is also what keeps backfill pacing correct: while an open request exists the
      app does not enqueue another, so the same instruments cannot be picked twice before the worker
      writes their `price_backfill` ledger rows
- [ ] The JS-off document POST blocks the same ≤8s then redirects (`refresh.ts:38`, `:45-47`
      behaviour preserved); on deadline, the unchanged as-of line is the honest signal, stated in the
      control's copy
- [ ] Old finished mailbox rows are swept opportunistically before inserting (the `upload_draft`
      precedent — scaffolding, not history); `on delete cascade` takes the candidate rows along
- [ ] `app/lib/price-poller.server.ts` keeps its cadence re-read and re-arm (`:8-11`), its
      market-hours decision about `quotes` (`:108-114`) and its `logBackfill` line (`:146`), and
      swaps `withRefreshLock(() => refreshPrices(…))` (`:127-133`) for an enqueue through the mailbox
      module. The `yahooPriceProvider` import (`:41`) goes; `startPricePoller`'s provider parameter
      (`:193`) goes with it. **`app/root.tsx:67` is untouched.**
- [ ] `app/lib/probe-mailbox.server.ts` exports a factory: one shared deadline (~5s) across a
      `resolveAll` invocation (the probe loop is sequential, `instrument-resolution.server.ts:502-511`
      — six new symbols against a dead worker cost one wait, not six); expiry and pattern-violating
      symbols return `{ status: "unavailable" }` without touching the mailbox (the CHECK would
      otherwise turn "BRK/B" into a constraint error where today's probe returns a clean
      create-anyway verdict). Never throws (`price-provider.server.ts:688-693`).
- [ ] `ResolutionDeps.probe` becomes required: the `probeSymbol` import and `?? probeSymbol` default
      are deleted from `instrument-resolution.server.ts:20,499`;
      `app/routes/upload/instruments.tsx:104` passes the mailbox probe;
      `tests/routes/upload-instruments.test.ts:84,162` (which call `resolveAll` with no deps) get a
      stub
- [ ] Nothing in the app's module graph value-imports `price-provider.server.ts` any more

**The lockdown**

- [ ] Full six-network topology from spec §3.1: `backend`/`worker-db`/`frontend` internal,
      `egress-worker`/`egress-gate`/`ingress` bridges; app, db, dump end with no route out
- [ ] `POSTGRES_PASSWORD` required (`:?`); the app/dump `DATABASE_URL` defaults re-derived from it
      (`compose.yaml:126`, `:204` — the coupling `compose.yaml:56-57` warns about);
      `.env.example:23`'s explicit `DATABASE_URL` and `:104`'s commented `#POSTGRES_PASSWORD` updated
      so the documented `cp .env.example .env` flow still boots
- [ ] **`smoke-test.sh:109-116` will invert.** It runs `docker compose --env-file /dev/null config`
      with only the four gate variables unset and asserts the refusal names one of them. `db`
      (`compose.yaml:45`) precedes `gate` (`:233`), so a newly required `POSTGRES_PASSWORD` at `:59`
      is what Compose reports first and the assertion fails on its own success. The fix follows the
      `DUMP_UID`/`DUMP_GID` precedent (`smoke-test.sh:39-40`): export `POSTGRES_PASSWORD` and
      `WORKER_DB_PASSWORD` before that check so it still isolates the gate variables, and add a
      **separate** assertion that unsetting `POSTGRES_PASSWORD` alone is refused by name — otherwise
      the newly required variable is the one thing smoke does not cover.
- [ ] Compose header prose (`:1-26`) amended: `:2`'s "The price poller runs in-process in `app` (no
      worker for it…)" is now false, and `:20`'s "Every other setting has a working default" is now
      false by two variables
- [ ] Documented password alphabet restricted to URL-safe characters (raw interpolation into a URL
      breaks on `/`, `?`, `#`; percent-encoding the shared variable would break provisioning, which
      stores the text literally)

**Smoke**

- [ ] From `app` and `db`: outbound TCP fails AND external DNS resolution fails (the
      unpatched-engine exfil channel, CVE-2024-29018, asserted separately)
- [ ] From `worker`: Yahoo resolves; screens show fresh prices end to end
- [ ] The in-container yahoo-import check (`:265-268`) re-pointed from `app` at `worker`. Note it
      only imports and constructs — it never calls out — so it passes on a container with no internet
      route and is not an egress assertion.
- [ ] A fresh `up` without the required vars fails fast at interpolation, pointing at the runbook

**Tests**

- [ ] Route tests through `tests/support/routes.ts` for busy / done / worker-unresponsive
- [ ] The mailbox module writes candidate rows from `selectBackfillCandidates`, and dedupes onto an
      open request rather than enqueuing a second
- [ ] Probe factory: each verdict, the shared deadline, pattern pre-validation
- [ ] Non-USD still refuses with nothing written; `unavailable` still creates-anyway

**Gates**

- [ ] `npm run typecheck`, `npm test`, `npm run build`, `scripts/smoke-test.sh` green
