# 02 — Pin the wiring the suite cannot see

_Part of [0020-the-lock-hardened.md](../0020-the-lock-hardened.md). Acts on the launch review's
[F3](../../research/2026-09-05-lock-slice-launch-review.md#f3--should-fix--the-two-wirings-the-lock-rests-on-are-not-pinned-by-any-test),
on its mutation results, and on the two test-file notes under its §3._

**What to build:** Tests only — no behaviour changes, one comment. The review put nineteen
deliberate breaks into the implementation; two survived every test — dropping `where not exists`
from the bootstrap insert, and writing `bootstrap = false` in it — and outside the nineteen, a
`Domain=` attribute added to the grant cookie went unrefused and the two removal checks
(acknowledgement, assertion presence) went red only through a message regex. Three more things
nothing tests at all: that `future.v8_middleware` is on, without which the `middleware` export is
silently ignored and the lock is gone; that user verification is *in force* rather than merely
not restated; and that `Layout` installs the re-entry listeners regardless of `hasPasskey`, which
a DOM-less suite cannot reach and this ticket says so. This ticket adds the test for each it can,
so the next regression is a red CI run rather than a review — and takes the two dead assertions
and the stale prose out of `tests/reentry.test.ts` while it is there.

Its own ticket because it adds and never changes: a reviewer reads each test against the rule it
claims to pin and asks whether the mutation the review made would now go red.

**Blocked by:** Nothing. Ticket 08 waits for this one; the review's test-file clean-up, once a
third pull request under ticket 11, is this ticket's last section.

**Status:** ready-for-agent

**The framework flag**

- [ ] A test imports `react-router.config.ts` and asserts `future.v8_middleware === true`, with a
      comment saying it is a tripwire, not a proof, and what happens without the flag:
      `handleDocumentRequest` passes no `generateMiddlewareResponse`
      (`node_modules/react-router/dist/development/chunk-ZA36QIGN.mjs:1430-1441`) and
      `staticHandler.query` never calls `runServerMiddlewarePipeline` (`chunk-62JRHF6Z.mjs:3522-3534`),
      so the lock's `middleware` export is never read
- [ ] The proof, beside it: a request through the framework itself. Build a `ServerBuild` by hand
      and hand it to `createRequestHandler` from `react-router` with mode `"test"`. The type is at
      `node_modules/react-router/dist/development/index-react-server-client-*.d.mts` (`interface
      ServerBuild`); the smallest values it and the runtime accept are: `routes: { root: { id:
      "root", path: "", module: rootModule }, child: { id: "child", parentId: "root", path:
      "holdings", module: { default: () => null, loader: () => ({}) } } }` with `rootModule` the
      real `app/root.tsx` import (already imported under vitest by `tests/routes/root.test.ts`;
      expect a cast to the route-module type); `entry: { module: { default: () => new
      Response("page") } }`; `assets: { entry: { imports: [], module: "" }, routes: {}, url: "",
      version: "" }`; `future: { ...config.future, v8_passThroughRequests: false,
      v8_trailingSlashAwareDataRequests: false }` (the type requires all three booleans; the
      config carries one); `ssr: true`, `prerender: []`, `isSpaMode: false`, `publicPath: "/"`,
      `assetsBuildDirectory: ""`, `routeDiscovery: { mode: "lazy", manifestPath: "/__manifest" }`.
      With a passkey seeded and no cookie, `GET http://portfolio.local/holdings` answers 302 to
      `/unlock?redirectTo=%2Fholdings`; the same build with `v8_middleware: false` answers 200.
      Importing the source module (not the built bundle under `build/server/`) is what lets
      `getDb()` resolve to the test's transaction; the bundle carries its own pool and would need
      committed rows
- [ ] If the hand-built build cannot be made to pass typecheck and run in about sixty lines, keep
      the tripwire, say so in the test file's header, and stop — an honest gap beats a fixture
      nobody can maintain

**The `Layout` wiring**

- [ ] No extraction: moving the effect body into a helper pins nothing, since the regression the
      review names (`if (!hasPasskey) return;` inside the effect) sits ahead of any helper call.
      Instead, the effect at `app/root.tsx:775-779` gains a comment naming the manual check — the
      drive script under `docs/research/2026-09-05-lock-slice-launch-review/harness/`, steps S8 and
      S9 — and saying why no test here can reach it (the suite is DOM-less by design, CLAUDE.md
      "Tests"). Do not add jsdom or a test renderer to close this gap

**User verification in force**

- [ ] `tests/support/webauthn.ts`'s `assertionResponse` gains a `flags` option (defaulting to
      `AUTHENTICATION_FLAGS`, `webauthn.ts:151`) passed straight to `authenticatorData`, which
      already takes flags (`:163`) — re-signing follows, exactly as the `counter` and `rpID`
      options do
- [ ] A test presents an assertion with the UV bit cleared (UP set, UV clear) against a fresh
      challenge and asserts a `ValidationError`, no grant, `counter` and `last_used_at` untouched
      (the library refuses at `verifyAuthenticationResponse.js:175-176`, default at `:24`). The
      existing spy assertion that the option is `undefined` (`tests/lock.test.ts:526-541`) stays —
      it pins "not restated"; its comment at `:536-538` claiming a UV=false assertion "cannot" be
      produced is deleted, since it now can

**The bootstrap halves, each through the real path**

- [ ] The in-flight test at `tests/lock.test.ts:906-929` ("refuses a bootstrap registration once
      another passkey landed while it was in flight") is joined by a twin whose interloper is seeded
      with `bootstrap: false` (`seedPasskey` takes it, `tests/support/fixtures.ts:238`) — the state
      after "bootstrap A, enrol B, remove A". With the partial index then silent, only `where not
      exists` refuses; the review's mutation dropping it must go red here
- [ ] The two-connection race at `tests/lock.test.ts:1242-1290` (two `beginEnrolment`s and two
      `completeRegistration`s on two transactions, the same credential id, `passkey_pkey` firing
      first) is joined by a twin with two *distinct* credential ids — `registrationResponse`
      accepts `credentialId`/`publicKey` overrides (`webauthn.ts:201-207`), and
      `unrelatedPublicKeyCose()` is already there — so `passkey_bootstrap_idx` is what refuses:
      exactly one lands, the other answers `BOOTSTRAP_TAKEN_MESSAGE` (`/no longer without one/`).
      Build it there, not in `tests/lock-schema.test.ts`, which drives raw fixture SQL and not the
      module. The review's mutation writing `bootstrap = false` must go red here

**The cookie, and the removal checks**

- [ ] The cookie-attribute tests (`tests/lock.test.ts:268-300`) assert the *absence* of `Domain=`
      on both `lockCookie` and `clearedLockCookie`, and that `Path=/` is the whole attribute (the
      `toContain("Path=/")` at `:292` and `:299` also accepts `Path=/x`); the review's `Domain=`
      mutation must go red
- [ ] A removal test sends a *valid* removal assertion (scoped to the target) with
      `confirmRemoval` absent, and asserts the passkey and its grants survive and no grant was
      minted — today every such test sends no assertion, so deleting the acknowledgement check
      only changes a message. `removePasskey` checks the acknowledgement before it spends the
      challenge (`lock.server.ts:1254-1259`), so the assertion is left unspent; assert that too

**`tests/reentry.test.ts`, while here**

- [ ] The test at `:226-263` differs from the one at `:209-224` only by asserting that
      `onPersistedRestore` was not called on a hidden-too-long return, and it names an enrolment
      scenario it does not exercise. Move that one assertion into `:209-224` (nothing else pins
      it — `:317-330` pins the converse, a persisted restore calling `onPersistedRestore`), then
      delete `:226-263`
- [ ] `askServer` is declared at `:320` and asserted not-called at `:328` without ever being handed
      to `watchReentry`. Delete both lines
- [ ] The header (`:2-9`) and the "What moved here" paragraph (`:29-41`) describe an
      `assumedPasskey` parameter and a `resolveReentryCallback` that no longer exist. Rewrite them
      to describe what the file pins now

**Tests**

- [ ] Every new `it` is a sentence stating the rule
- [ ] Before committing, replay the review's surviving mutations by hand (one-line edits, listed in
      the review's F3 and the spec's Testing section) and confirm each now fails at least one of
      these tests; record the failing `it` sentences in the pull request body

**Verification**

1. `npx vitest run tests/lock.test.ts tests/reentry.test.ts tests/routes/root.test.ts` and the new
   file(s) — real pass counts.
2. The mutation replays above, each red, each reverted.
3. `npm run typecheck`, `npm run build`, `npm test`.
