# 11 — The small ones, in three pull requests

_Part of [0020-the-lock-hardened.md](../0020-the-lock-hardened.md). Acts on the launch review's
F12–F16 and its §3 notes._

**What to build:** Six corrections that share nothing but their size, grouped into three pull
requests by what they touch so each still typechecks, builds and tests alone. Each is stated here
with its finding; none needs an argument of its own.

**Blocked by:** (a) nothing; (b) [04](04-narrow-what-registration-stores.md), which edits the
same function; (c) [02](02-pin-the-wiring.md), which edits the same test file.

**Status:** ready-for-agent

**(a) The screens — `app/routes/settings/passkeys.tsx`, `app/lib/unlock-ceremony.ts`**

- [ ] F12 — the same-provider refusal. `requestRegistration` maps a thrown `InvalidStateError`
      (the client half of `excludeCredentials`: this provider already holds a passkey for this
      instance) to its own outcome, and the panel prints a sentence in the family's words — this
      provider already holds a passkey for this app; make the second one from a different device
      or provider — instead of the library's "The authenticator was previously registered". Read
      `node_modules/@simplewebauthn/browser/esm/helpers/identifyRegistrationError.js` for the exact
      name the wrapper preserves before matching on it
- [ ] F12 — a way out. The `readyToCreate` phase gains a "Start over" control that clears the
      registration options, the minted-at time and the note, and re-enables the label — today the
      exits are a reload or the two-minute expiry. The unspent `register` challenge is simply
      abandoned; the header on `REGISTRATION_OPTIONS_TTL_MS` says why that costs nothing
- [ ] F15 — `<noscript>` on the Passkeys screen, in `unlock.tsx`'s shape: with scripting off,
      neither ceremony can run, and the message says so and names the recoveries. And the guide's
      sentence ticket 05 left ("the button is replaced by a line saying so") stays true
- [ ] Tests: the mapped outcome in `tests/unlock-ceremony-boundary.test.ts` or the ceremony seam's
      own test; the Start-over reset as a pure-function test in `tests/routes/settings-passkeys.test.ts`
      following that file's existing pattern; the `<noscript>` fragment by `toContain`. Ticket 05's
      interim guide sentence about reloading is removed here

**(b) The domain module — `app/lib/lock.server.ts`, `app/lib/lock.ts`**

- [ ] F13 — labels. The control-character refinement (`/[\p{Cc}]/u`) is widened to refuse
      U+2028 and U+2029 (the message already promises "no line break"), the bidirectional controls
      U+202A–U+202E and U+2066–U+2069, and U+200B (zero width space) — and deliberately *not*
      U+200D (zero width joiner) or the variation selectors, which emoji sequences need. State the
      set in the comment and pin it with one test per class and one that a joined emoji label passes
- [ ] F14 — `REGISTRATION_OPTIONS_TTL_MS` in `passkeys.tsx` restates `CHALLENGE_TTL_MS`; move the
      constant to `app/lib/lock.ts` as `CHALLENGE_TTL_MS` beside the other windows, import it in
      both places, delete the restatement and its "because `.server.ts`" justification
- [ ] F16 — the expired-challenge message is unreachable after any later mint, because
      `sweepChallenges` deletes expired entries on every mint and a stale one then reads "never
      issued". Either keep expired entries until read (and sweep only those older than the TTL
      twice over) so the sentence is reachable, or delete the third sentence and its test. Pick one
      and say why in the commit. Separately, spent entries count against the per-kind budget until
      they expire — exclude them from the count, since a spent entry cannot be used by anyone
- [ ] Tests for each, in `tests/lock.test.ts`

**(c) The tests — `tests/reentry.test.ts`**

- [ ] The test at `tests/reentry.test.ts:226-263` is byte-for-byte the one at `:209-224` with a
      different comment and pins nothing about the enrolment scenario it names; delete it, or make
      it differ in an input that matters (a loader-data-shaped belief handed in and ignored — which
      `watchReentry` no longer accepts, so delete it)
- [ ] The two `expect(askServer).not.toHaveBeenCalled()` assertions on a function never handed to
      `watchReentry` (ticket 08 removes the prose; this removes the assertions if 08 has not)

**Verification**

1. Per pull request: the single test files named above, real pass counts.
2. `npm run typecheck`, `npm run build`, `npm test` — each pull request alone.
3. (a) changes a screen: retake the Settings → Passkeys screenshots with the capture script if the
   Start-over control or the `<noscript>` block moves the layout in a captured state (the capture
   runs with scripting on and no registration in flight, so it probably does not — check, and say
   which in the pull request).
