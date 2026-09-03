# 04 — App cutover and network lockdown

_Part of [0018-price-worker.md](../0018-price-worker.md) (§3.1, §3.4)._

**What to build:** The single release where the app stops fetching and loses its internet route. One
new app module implementing an interface the app already injects, two call sites that swap which
implementation they construct, and the full network topology. After this ticket, a trojan in the app
has no socket to anywhere, and the only fetcher sees ticker symbols.

**How small the app change is, is the point.** `refreshPrices`, `refreshQuotes`, `backfillCloses`,
`selectBackfillCandidates`, `withRefreshLock`, `requestRefresh`, `app/root.tsx` and the route's
outcome union are all **untouched**. If this ticket's diff reaches into `prices.server.ts`, the seam
is in the wrong place.

**Blocked by:** 03 (the worker must already be running and proven, or this commit deploys an
instance with no price refresh).

**Status:** ready-for-agent

**The one new module**

- [ ] `app/lib/price-mailbox.server.ts` exports `mailboxPriceProvider(budget)` returning a
      `PriceProvider` (`price-provider.server.ts:155-162`) and `mailboxProbeSymbol(budget)`
      returning a `ProbeSymbol` (`:649`). Each call inserts a `fetch_request`, polls it (~100 ms),
      and returns the parsed payload — throwing for the two provider methods, and returning
      `{ status: "unavailable" }` for the probe, whose contract is never to throw (`:688-693`).
- [ ] **One shared deadline budget per invocation, not per call.** A refresh makes up to six calls
      (one `getQuotes`, up to `BACKFILL_BATCH_SIZE` = 5 `getDailyCloses`, `prices.server.ts:87`) and
      ingest probes sequentially (`instrument-resolution.server.ts:502-511`). Per-call deadlines
      stack: against a dead worker one press would cost six timeouts and six new symbols six more.
      One budget per `refreshPrices` invocation and one per `resolveAll`; once spent, later calls
      fail immediately. One helper serves both — do not write two poll loops.
- [ ] **The app does not trust the payload.** Re-parse every answer with a Zod schema for
      `ProviderQuote[]` / `ProviderHistory` / `SymbolProbe` before it reaches `prices.server.ts`. A
      compromised worker is then exactly as trusted as Yahoo, which is the honest bar.
- [ ] **The money schema must reject non-finite decimals.** `'NaN'` is a valid `numeric(20,4)`, and
      `money.ts:47` throws `Cannot convert NaN0000 to a BigInt` on it — one fabricated payload would
      500 every screen. Money crosses as decimal strings (`ProviderDailyClose = { date, close:
      string }`, `price-provider.server.ts:110-120`); pin that a JSON *number* is refused rather
      than coerced, and that `NaN`/`Infinity` are refused.

**The two swaps, and nothing else**

- [ ] `price-poller.server.ts:41`/`:193` and `refresh.ts:14`/`:67` stop importing
      `yahooPriceProvider` and construct the mailbox provider instead
- [ ] `ResolutionDeps.probe` becomes required: the `probeSymbol` import and `?? probeSymbol` default
      are deleted from `instrument-resolution.server.ts:20,499`;
      `app/routes/upload/instruments.tsx:104` passes the mailbox probe;
      `tests/routes/upload-instruments.test.ts:84,162` (which call `resolveAll` with no deps) get a
      stub
- [ ] Nothing in the app's module graph value-imports `price-provider.server.ts` afterwards
- [ ] **No new outcome variant.** `backfillCloses` already ledgers a per-instrument provider throw
      as `providerFailed` and continues (`prices.server.ts:537-540`); `refreshQuotes` already maps a
      throw to `RefreshReport.providerFailed`. So `refresh.ts:21-33` and its renderer
      (`app/components/price-freshness.tsx:71`) are untouched and the household reads "the feed could
      not be reached", which is true. Telling "worker down" from "Yahoo down" is an operator
      question — it goes in the log line and the runbook entry (ticket 05).

**The lockdown**

- [ ] Full topology from spec §3.1: `backend`, `worker-db`, `caddy-app`, `caddy-gate` internal;
      `egress-worker`, `egress-gate`, `ingress` bridges. `app` gets `[backend, caddy-app]` — **not a
      shared `frontend` with `gate`**: from a shared network the app can POST
      `/oauth2/callback?code=<bytes>` to `gate:4180` and the gate relays them to Google, which is a
      kilobyte-scale egress proxy handed to the container this whole slice exists to contain.
- [ ] `app`, `db` and `dump` end with no route out

**Smoke — the assertion set is total, not partial**

- [ ] Outbound TCP **and** external DNS resolution fail from `app`, `db` **and `dump`**. `dump` holds
      the household's finances in plaintext on a bind mount and no earlier draft asserted anything
      about it.
- [ ] `worker`, `gate` and `caddy` are asserted to *have* egress, so the set says something about
      every service
- [ ] `docker network inspect` reports `"Internal": true` for `backend`, `worker-db`, `caddy-app`
      and `caddy-gate` — one line naming the property directly rather than inferring it
- [ ] **The positive control does not use Yahoo.** "From `worker`, Yahoo resolves" couples CI to a
      third party's uptime and rate limits; the day it flakes someone relaxes it and the negative
      assertions stop being falsifiable. Any DNS name and a TCP connect.
- [ ] `app:3000` and `gate:4180` unreachable from `worker` — and note in the test's comment that
      this passes partly because Compose's DNS only resolves names on networks the querying
      container is attached to. It does **not** cover the host-gateway path (spec §3.1): the worker
      still reaches Caddy's published `:80` and the LAN through the host's default route. Assert
      against the bridge gateway address so the limit is recorded rather than implied.
- [ ] The in-container yahoo-import check (`:265-268`) re-pointed from `app` at `worker`. It only
      imports and constructs, never calls out, so it passes on a container with no internet route —
      it is not an egress assertion.
- [ ] The DNS assertion's comment says what it proves: CVE-2024-29018 leaks only where the host's
      `resolv.conf` names a loopback forwarding resolver, so a green run on a CI runner says nothing
      about an operator's systemd-resolved box on an old engine.

**Tests**

- [ ] Route tests through `tests/support/routes.ts`: a refresh whose worker never answers reports
      `providerFailed`, and the JS-off document POST still redirects
- [ ] The mailbox provider round-trips each kind and shares one budget across a `refreshPrices`
      invocation
- [ ] Probe factory: each verdict, the shared deadline, pattern pre-validation
- [ ] Non-USD still refuses with nothing written; `unavailable` still creates-anyway
- [ ] Almost nothing else changes. `refreshQuotes`, `backfillCloses`, `refreshPrices`,
      `price-provider` and the poller suites all already drive a fake `PriceProvider` and do not know
      which implementation production passes. If this ticket rewrites them, stop and re-read the
      seam.

**Gates**

- [ ] `npm run typecheck`, `npm test`, `npm run build`, `scripts/smoke-test.sh` green
