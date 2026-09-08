# 01 — Arm the poller from middleware, not from the first page render

_Part of [0021-price-health.md](../0021-price-health.md)._

**What to build:** Move `startPricePoller()` out of `app/root.tsx`'s loader and into a root
middleware, so scheduled pricing starts from the container's own healthcheck traffic rather than
from the first human page view. No health-response change; no pricing-path change.

Separate because it is a behaviour fix with its own failure mode and its own documents, and because
it is what makes the next two tickets honest — without it `scheduler: not_started` is the ordinary
state of a healthy container and the endpoint reports a fault most of the time.

**Blocked by:** Nothing.

**Status:** ready-for-agent

## The defect

`app/root.tsx:179` calls `startPricePoller()` as the first statement of the root **loader**.
`/healthz` is a resource route — `app/routes/healthz.ts` exports only `loader`, no component and no
`ErrorBoundary` — and React Router does not run parent loaders for those. At
`react-router@7.18.2`, `lib/server-runtime/server.ts:260-274` sends a leaf match with neither a
`default` nor an `ErrorBoundary` export to `handleResourceRequest`, which calls
`queryRoute(request, { routeId })`; `getTargetedDataStrategyMatches`
(`lib/router/router.ts:6435`) hands every non-target match `shouldCallHandler: () => false` at
`:6454`.

So the app's ten-second healthcheck (`compose.yaml:151-160`) never arms the timer, and
`docs/operating.md:1160-1164` records the result: *"A booted instance nobody has visited does zero
refreshes, forever."*

## Why middleware works

The same dispatch runs middleware. `handleResourceRequest` passes `generateMiddlewareResponse`
(`lib/server-runtime/server.ts:670`) and `queryRoute` runs `runServerMiddlewarePipeline` over **all**
matches (`lib/router/router.ts:4439`). Loaders no, middleware yes.

This repo already depends on that: `lockMiddleware` has to exempt `/healthz` by hand
(`app/root.tsx:45`, `:130`) — dead code if middleware did not run there — and
`ARCHITECTURE.md:1623-1625` says so in the repo's own words. It rests on
`future.v8_middleware: true` (`react-router.config.ts:11`), already pinned by
`tests/framework-wiring.test.ts:84`.

## The move

- [ ] Add a third middleware to `app/root.tsx` and place it **last** in the exported array
      (`app/root.tsx:165`, currently `[crossOriginMutationMiddleware, lockMiddleware]`). Last, not
      first: `lockMiddleware` reaches `next()` for exempt paths at `:131`, so `/healthz` and
      `/unlock` still arm the poller, while a locked grant-less request throws at `:150`, `:157` or
      `:160` and no side effect runs ahead of a refusal.
- [ ] The middleware calls `startPricePoller()` and returns `next()`. It does not await the start (it
      is synchronous), does not wrap the response, and cannot throw — `startPricePoller` already
      swallows its own failure (`app/lib/price-poller.server.ts:131-134`).
- [ ] Delete the call and its comment from the root loader (`app/root.tsx:178-179`). The loader keeps
      everything else it does.
- [ ] **Take the provider lazily.** `startPricePoller(provider: PriceProvider = socketProvider())`
      (`app/lib/price-poller.server.ts:114`) evaluates its default parameter *before* the
      `if (host[SLOT] !== undefined) return;` at `:116`, so from a middleware it would build a
      throwaway provider object on every request rather than every page render. Change the parameter
      to a thunk or make it `PriceProvider | undefined` resolved after the early return; keep the
      existing constraint that building one must never throw, and keep the injection seam tests use.
- [ ] Nothing else about the poller changes: still idempotent, still no immediate poll on start,
      still `unref()`ed, still stopped by `stopPricePoller` and the HMR dispose hook.

## Tests

- [ ] **The one that settles the framework fact.** `tests/framework-wiring.test.ts` already
      hand-builds a `ServerBuild` and drives it through `createRequestHandler` (`buildWith`, `serve`,
      `:36-79`). Add a resource-route child — a module with a `loader` and **no** `default` and **no**
      `ErrorBoundary` — request it, and assert the poller slot
      (`Symbol.for("portfolio.pricePoller")`) is defined afterwards. Assert in the same test that the
      root **loader** did not run, so the test proves the middleware path specifically and would fail
      if someone re-added a component or an `ErrorBoundary` to a resource route.
- [ ] A test that the poller is armed for a request to a lock-exempt path while the household is
      locked and holds no grant, since that is the shipped healthcheck's situation.
- [ ] A test that a locked, grant-less request to a **non**-exempt path is refused and does *not* arm
      the poller, pinning the "last in the array" placement.
- [ ] Existing root tests that relied on the loader arming it must be updated, not deleted —
      `tests/framework-wiring.test.ts:22-25` already calls `stopPricePoller()` in an `afterEach` with
      a comment naming the loader; the comment is now wrong.
- [ ] A test that `startPricePoller()` called twice builds one provider, pinning the lazy default.

## Documents

Every one of these currently asserts the loader owns the bootstrap and becomes false:

- [ ] `app/lib/price-poller.server.ts:108-113` — the module header's "the call site is a request path
      — there is no server entry file to hook under `react-router-serve` (§9), so `app/root.tsx`'s
      loader starts it". Rewrite to name the middleware and why a loader could not do it.
- [ ] `app/root.tsx:178` — the comment "Root's loader is the only server path every render passes
      through". A render is not the point any more; the middleware is the only server path every
      *request* passes through, resource routes included.
- [ ] `ARCHITECTURE.md:2215` — "Its loader starts the price poller, because `react-router-serve`
      leaves no server entry to hook and root's loader is the one server path every render passes
      through."
- [ ] `docs/operating.md:1160-1164` — cause 1 of "There is no price line in the log" is no longer a
      cause. Renumber the list, and correct the "quiet period by design" paragraph below it, which
      measures the first tick from the first page view rather than from boot.
- [ ] `DESIGN.md` §6.2 and §10 — check both for the same claim before editing anything else.
- [ ] `docs/research/2026-09-07-price-fetch-coordination-audit.md` — its `:123`, `:346`, `:584` and
      `:666` describe this defect. Add a dated addendum saying it is fixed and where; preserve the
      audit as a snapshot rather than rewriting it, the same convention
      `docs/research/README.md` uses elsewhere.

## Traps

- **Do not add an `ErrorBoundary` or a default export to `app/routes/healthz.ts`.** Either turns it
  into a document route, which runs the root loader again and would mask this change rather than
  break it.
- `npm run typecheck` regenerates `./+types/root`; run it after touching the middleware array.
- The suite is serial with `fileParallelism` off and the slot is process-wide — any test that arms
  the poller must stop it, or a stray `setInterval` outlives the file.
