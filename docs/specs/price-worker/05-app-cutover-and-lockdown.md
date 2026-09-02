# 05 — App cutover and network lockdown

_Part of [0015-price-worker.md](../0015-price-worker.md) (§3.1, §3.4, §3.5)._

**What to build:** The single release where the app stops fetching and loses its internet route.
Three app-side modules swap the in-process Yahoo paths for the mailbox; the compose topology
becomes the full six networks; the superuser password stops having a default. After this ticket,
a trojan in the app has no socket to anywhere, and the only fetcher sees ticker symbols.

**Blocked by:** 04 (the worker must already be fetching in production, or this commit deploys an
instance with no price refresh).

**Status:** ready-for-agent

**The app-side modules (routes stay thin)**

- [ ] `app/lib/refresh-mailbox.server.ts` owns sweep, dedupe, insert, and poll-to-deadline
      (~8s); `app/routes/refresh.ts` keeps its one-call shape (`run()`, `:57`) and stops
      importing `yahooPriceProvider`/`refreshQuotes`
- [ ] Dedupe: an open `pending`/`running` row younger than the deadline is `{ status: "busy" }`
      — the same meaning today's held lock has; deadline expiry is the new
      `{ status: "worker-unresponsive" }`, rendered distinctly from `providerFailed` and
      `error`
- [ ] The JS-off document POST blocks the same ≤8s then redirects (`refresh.ts:37,:44-46`
      behaviour preserved); on deadline, the unchanged as-of line is the honest signal, stated
      in the control's copy
- [ ] Old finished mailbox rows are swept opportunistically before inserting (the
      `upload_draft` precedent — scaffolding, not history)
- [ ] `app/lib/probe-mailbox.server.ts` exports a factory: one shared deadline (~5s) across a
      `resolveAll` invocation (the probe loop is sequential, `:503-512` — six new symbols
      against a dead worker cost one wait, not six); expiry and pattern-violating symbols
      return `{ status: "unavailable" }` without touching the mailbox (the CHECK would
      otherwise turn "BRK/B" into a constraint error where today's probe returns a clean
      create-anyway verdict)
- [ ] `ResolutionDeps.probe` becomes required: the `probeSymbol` import and `?? probeSymbol`
      default are deleted from `instrument-resolution.server.ts:19,500`;
      `app/routes/upload/instruments.tsx:111` passes the mailbox probe;
      `tests/routes/upload-instruments.test.ts:84,162` (which call `resolveAll` with no deps)
      get a stub
- [ ] `app/root.tsx:67` stops calling `startPricePoller()`, the import at `:29` goes; nothing
      in the app's module graph value-imports `price-provider.server.ts` any more

**The lockdown**

- [ ] Full six-network topology from spec §3.1: `backend`/`worker-db`/`frontend` internal,
      `egress-worker`/`egress-gate`/`ingress` bridges; app, db, dump end with no route out
- [ ] `POSTGRES_PASSWORD` required (`:?`); the app/dump `DATABASE_URL` defaults re-derived
      from it (`compose.yaml:115`, `:192` — the coupling `compose.yaml:47` warns about);
      `.env.example:23`'s explicit `DATABASE_URL` updated so the documented
      `cp .env.example .env` flow still boots
- [ ] Compose header prose amended: two additional variables are deliberately without defaults
- [ ] Documented password alphabet restricted to URL-safe characters (raw interpolation into a
      URL breaks on `/`, `?`, `#`; percent-encoding the shared variable would break
      provisioning, which stores the text literally)

**Smoke**

- [ ] From `app` and `db`: outbound TCP fails AND external DNS resolution fails (the
      unpatched-engine exfil channel, CVE-2024-29018, asserted separately)
- [ ] From `worker`: Yahoo resolves; screens show fresh prices end to end
- [ ] The in-container yahoo-import check (`:265`) re-pointed at the worker container
- [ ] A fresh `up` without the required vars fails fast at interpolation, pointing at the
      runbook

**Tests**

- [ ] Route tests through `tests/support/routes.ts` for busy / done / worker-unresponsive
- [ ] Probe factory: each verdict, the shared deadline, pattern pre-validation
- [ ] Non-USD still refuses with nothing written; `unavailable` still creates-anyway

**Gates**

- [ ] `npm run typecheck`, `npm test`, `npm run build`, `scripts/smoke-test.sh` green
