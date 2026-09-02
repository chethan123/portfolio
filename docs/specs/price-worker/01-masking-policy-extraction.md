# 01 — Free the worker's import closure from the UI framework

_Part of [0015-price-worker.md](../0015-price-worker.md) (§3.2)._

**What to build:** A new plain module `app/lib/masking-policy.ts` holding the masking-policy
*values* that today live in `app/lib/masking.ts` (`maskingPolicyValues`, `masking.ts:40`), with
both `masking.ts` and `app/lib/settings.server.ts` importing from it. Nothing else about masking
changes. `settings.server.ts:27` currently value-imports from `masking.ts`, and `masking.ts:14`
value-imports `react-router` — the one edge that drags the SSR framework (and React) into the
future worker's module graph. The honest justification is surface, not proven breakage:
react-router may well load under plain Node, but a fetch worker whose closure includes the UI
framework is attack surface and bloat for nothing.

The value of doing it first, alone: it is the only `app/lib` change the worker needs, it touches
no schema and no route, and it makes ticket 03's "the closure runs under plain `node`" claim
testable before any worker exists.

**Blocked by:** Nothing.

**Status:** ready-for-agent

**The extraction**

- [ ] `app/lib/masking-policy.ts` exports the policy values; no imports beyond zod/none
- [ ] `masking.ts` and `settings.server.ts` import the values from the new module; no other
      importer changes
- [ ] `masking.ts`'s header (`:1-13`), which argues its four pieces must never be split, is
      amended to name why the values moved — otherwise the file argues against its own shape,
      which is the drift ADR-0002 fears
- [ ] No behavioural change: the masking tests pass untouched

**Proof of the plain-Node closure**

- [ ] A `node --env-file=.env` invocation that imports `app/lib/price-poller.server.ts` (the
      worker's future entry edge) completes its imports under Node 24 type stripping — no
      react-router, react, or Vite-only construct anywhere in the transitive closure
      (`import.meta.hot` in the poller is `undefined` outside Vite and already guarded)
- [ ] The closure is recorded in the ticket's PR description: poller →
      `prices.server.ts` / `price-provider.server.ts` / `market-hours.ts` /
      `settings.server.ts` / `db.server.ts` → `server/*`, plus `input.server.ts` → `money.ts`
      and the new `masking-policy.ts` — the list ticket 03's Dockerfile copy set is built from

**Gates**

- [ ] `npm run typecheck`, `npm test`, `npm run build` green
