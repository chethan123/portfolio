# 11 — The small ones, in two pull requests

_Part of [0020-the-lock-hardened.md](../0020-the-lock-hardened.md). Acts on the launch review's
F12–F16._

**What to build:** Five corrections that share nothing but their size, grouped into two pull
requests by what they touch so each still typechecks, builds and tests alone. Each is stated here
with its finding; none needs an argument of its own. (The test-file clean-up the review also
listed is ticket 02's, which is already in that file.)

**Blocked by:** (a) nothing; (b) [11(a)](#b-the-domain-module--applibllockserverts-applibllockts),
which edits the one import line in `passkeys.tsx` that (b) also touches.

**Status:** ready-for-agent

**(a) The screens — `app/routes/settings/passkeys.tsx`, `app/lib/unlock-ceremony.ts`**

- [ ] F12 — the same-provider refusal. `requestRegistration` maps a thrown error whose `name` is
      `InvalidStateError` — the client half of `excludeCredentials`: this provider already holds a
      passkey for this instance — to its own outcome, and the panel prints a sentence in the
      family's words (this provider already holds a passkey for this app; make the second one from
      a different device or provider) instead of the library's "The authenticator was previously
      registered". The wrapper preserves the cause's `name` and sets `code:
      "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED"`
      (`node_modules/@simplewebauthn/browser/esm/helpers/identifyRegistrationError.js`, the
      `InvalidStateError` branch; `webAuthnError.js` sets `this.name = name ?? cause.name`) — match
      on the name, and cite both files
- [ ] F12 — a way out. The `readyToCreate` phase gains a "Start over" control. Its handler and the
      existing `!result.ok` branch (`passkeys.tsx:640-646`) do the same four things — note, phase,
      options, minted-at — so extract them into one function in the file's existing shape
      (`applyRemovalOptionsResult`'s: setters as parameters, `:874-889`) and call it from both. The
      unspent `register` challenge is simply abandoned; the header on `REGISTRATION_OPTIONS_TTL_MS`
      says why that costs nothing
- [ ] F15 — `<noscript>` on the Passkeys screen, in `unlock.tsx:506-508`'s shape: with scripting
      off, neither ceremony can run, and the message says so and names the recoveries
- [ ] The guide sentence ticket 05 left ("reloading the page is how to start over") is removed here
- [ ] Tests: the mapped outcome needs a real `requestRegistration` with a stubbed thrower —
      `vi.mock("@simplewebauthn/browser")` whose `startRegistration` throws an error shaped like
      the wrapper's (`name: "InvalidStateError"`) — since `tests/unlock-ceremony-boundary.test.ts`
      only greps file layout and both route tests mock the whole seam
      (`tests/routes/unlock.test.ts:41-60`); say so in the test's header. The reset function as a
      pure-function test in `tests/routes/settings-passkeys.test.ts` following that file's pattern;
      the `<noscript>` fragment by `toContain`

**(b) The domain module — `app/lib/lock.server.ts`, `app/lib/lock.ts`**

- [ ] F13 — labels. The control-character refinement (`/[\p{Cc}]/u`, `lock.server.ts:944`) is
      widened to refuse U+2028 and U+2029 (the message at `:938-939` already promises "no line
      break"), the bidirectional controls U+202A–U+202E and U+2066–U+2069, and U+200B (zero width
      space) — and deliberately *not* U+200D (zero width joiner) or the variation selectors, which
      emoji sequences need. State the set in the comment; one `it.each` over one example per
      refused class, and one `it` that a joined emoji label passes
- [ ] F14 — `REGISTRATION_OPTIONS_TTL_MS` in `passkeys.tsx:509` restates `CHALLENGE_TTL_MS`
      (`lock.server.ts:462`, unexported). Move the constant to `app/lib/lock.ts` as
      `CHALLENGE_TTL_MS` beside the other windows, import it in both places, delete the restatement
      and its "because `.server.ts`" justification
- [ ] F16 — the expired-challenge message is unreachable after any later mint, because
      `sweepChallenges` (`:555-558`) deletes expired entries on every mint and a stale one then
      reads "never issued". Either keep expired entries until read (and sweep only those older
      than the TTL twice over) so the sentence is reachable, or delete the third sentence and its
      test. Pick one and say why in the commit. Separately, spent entries count against the
      per-kind budget until they expire (`:527-530`) — exclude them from the count, since a spent
      entry cannot be used by anyone
- [ ] Tests for each, in `tests/lock.test.ts`

**Verification**

1. Per pull request: the single test files named above, real pass counts.
2. `npm run typecheck`, `npm run build`, `npm test` — each pull request alone.
3. (a) changes a screen: retake the Settings → Passkeys screenshots with the capture script if the
   Start-over control or the `<noscript>` block moves the layout in a captured state (the capture
   runs with scripting on and no registration in flight, so it probably does not — check, and say
   which in the pull request).
