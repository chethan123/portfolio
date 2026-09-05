# 02 — Pin the wiring the suite cannot see

_Part of [0020-the-lock-hardened.md](../0020-the-lock-hardened.md). Acts on the launch review's
[F3](../../research/2026-09-05-lock-slice-launch-review.md#f3--should-fix--the-two-wirings-the-lock-rests-on-are-not-pinned-by-any-test),
and on its mutation results._

**What to build:** Tests only — no behaviour changes. The review put nineteen deliberate breaks
into the implementation and four survived every test: dropping `where not exists` from the
bootstrap insert, writing `bootstrap = false` in it, adding `Domain=` to the grant cookie, and
(by message regex only) the acknowledgement and assertion-presence checks on removal. Three more
things nothing tests at all: that `future.v8_middleware` is on, without which the `middleware`
export is silently ignored and the lock is gone; that `Layout` installs the re-entry listeners
regardless of `hasPasskey`; and that user verification is *in force* rather than merely not
restated. This ticket adds the test for each, so the next regression is a red CI run rather than
a review.

Its own ticket because it adds and never changes: a reviewer reads each test against the rule it
claims to pin and asks whether the mutation the review made would now go red.

**Blocked by:** Nothing. Ticket 09 waits for this one.

**Status:** ready-for-agent

**The framework flag**

- [ ] A test imports `react-router.config.ts` and asserts `future.v8_middleware === true`, with a
      comment saying what happens without it: `handleDocumentRequest` passes no
      `generateMiddlewareResponse`, `staticHandler.query` never calls
      `runServerMiddlewarePipeline`, and the lock's `middleware` export is never read. This is the
      minimum and it is required
- [ ] Preferred, in addition, if it fits in about sixty lines: a request through the framework
      itself. Build a `ServerBuild` by hand — `routes` holding the real `app/root.tsx` module as
      `root` and one stub child route with a loader, `entry.module.default` a function returning
      `new Response("page")`, `future` read from `react-router.config.ts`, the other fields the
      smallest values the type accepts — hand it to `createRequestHandler` from `react-router`, and
      assert that with a passkey seeded and no cookie, `GET /holdings` is a 302 to `/unlock`, while
      with `future.v8_middleware` overridden to `false` in the same build the response is a 200.
      Read `ServerBuild` in `node_modules/react-router/dist/development/index-react-server-client-*.d.mts`
      before guessing at it. If the shape cannot be built cleanly, say so in the test file's header
      and keep only the flag assertion — an honest gap beats a fixture nobody can maintain

**The `Layout` wiring**

- [ ] `app/root.tsx`'s re-entry effect is reduced to one call: an exported
      `installReentry(isUnlockScreen, attemptLock, askServer)` in `app/lib/reentry.ts` that returns
      the teardown (or nothing when `isUnlockScreen`), with the effect body being exactly
      `return installReentry(...)`. A test drives `installReentry` with the existing
      document/window stand-in and asserts both listeners install for `isUnlockScreen === false`
      and neither for `true`, with no other input consulted
- [ ] The suite is DOM-less by design (AGENTS.md), so the effect's own call site stays untested
      here. The test file's header says so and names the manual check: the drive script under
      `docs/research/2026-09-05-lock-slice-launch-review/harness/`, steps S8 and S9. Do not add
      jsdom or a test renderer to close this gap

**User verification in force**

- [ ] `tests/support/webauthn.ts`'s `assertionResponse` gains a `flags` option (defaulting to the
      current `AUTHENTICATION_FLAGS`), re-signing `authData` exactly as the `counter` and `rpID`
      options already do — the header's claim that a UV=false assertion "cannot" be produced
      without breaking the signature is withdrawn along with the sentence in
      `tests/lock.test.ts:526-541` that repeats it
- [ ] A test presents an assertion with the UV bit cleared (UP set, UV clear) against a fresh
      challenge and asserts a `ValidationError`, no grant, `counter` and `last_used_at` untouched.
      The existing spy assertion that the option is `undefined` stays — it pins "not restated"; the
      new one pins "in force"

**The bootstrap halves, each through the real path**

- [ ] The in-flight test at `tests/lock.test.ts:906` ("refuses a bootstrap registration once another
      passkey landed while it was in flight") is joined by a twin whose interloper is seeded with
      `bootstrap: false` — the state after "bootstrap A, enrol B, remove A". With the partial index
      then silent, only `where not exists` refuses; the review's mutation dropping it must go red
      here
- [ ] `tests/lock-schema.test.ts`'s two-connection race is joined by one driven through
      `completeRegistration` with two *distinct* credential ids (`registrationResponse` accepts
      `credentialId`/`publicKey` overrides; `"none"` attestation needs no private key for a
      credential that never asserts). Both `beginEnrolment` calls run on an empty table; the second
      `completeRegistration` is issued before the first's transaction commits; exactly one lands,
      the other refuses with `BOOTSTRAP_TAKEN_MESSAGE`. The review's mutation writing
      `bootstrap = false` must go red here

**The cookie, and the removal checks**

- [ ] The cookie-attribute tests assert the *absence* of `Domain=` on both `lockCookie` and
      `clearedLockCookie`, and that `Path=/` is the whole attribute (a `toContain("Path=/")` also
      accepts `Path=/x`); the review's `Domain=` mutation must go red
- [ ] A removal test sends a *valid* removal assertion (scoped to the target) with
      `confirmRemoval` absent, and asserts the passkey and its grants survive — today every such
      test sends no assertion, so deleting the acknowledgement check only changes a message

**Tests**

- [ ] Every new `it` is a sentence stating the rule
- [ ] Before committing, replay the review's four surviving mutations by hand (they are one-line
      edits, listed in the review's F3) and confirm each now fails at least one of these tests;
      record the four failing `it` sentences in the pull request body

**Verification**

1. `npx vitest run tests/lock.test.ts tests/lock-schema.test.ts tests/reentry.test.ts
   tests/routes/root.test.ts` and the new file(s) — real pass counts.
2. The four mutation replays above, each red, each reverted.
3. `npm run typecheck`, `npm run build`, `npm test`.
