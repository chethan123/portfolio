# 06 — Say what a signature-counter regression means

_Part of [0020-the-lock-hardened.md](../0020-the-lock-hardened.md). Acts on the launch review's
[F6](../../research/2026-09-05-lock-slice-launch-review.md#f6--should-fix--a-signature-counter-regression-tells-the-family-try-again)._

**What to build:** One distinct refusal in `verifyScopedAssertion` (`app/lib/lock.server.ts:836-839`)
for the case the library throws because the assertion's signature counter did not advance past
the stored one. Today that throw is caught with every other verification failure and answered
"This passkey could not be verified. Try again." — and the family retries a message about the
one signal WebAuthn gives them that a copy of a passkey may exist. The refusal itself is right and
writes nothing (the review confirmed `counter`, `last_used_at` and the grant table untouched); only
the sentence is wrong. Ticket 02 of the lock slice asked that a regression "refuses the assertion
and says so".

Its own ticket because it is one message and one test, and because getting the *detection* wrong
— matching the library's throw too loosely — would relabel unrelated failures as clones.

**Blocked by:** [03](03-one-live-grant-per-browser.md), which edits the adjacent lines.

**Status:** ready-for-agent

**Detecting it**

- [ ] The library throws at
      `node_modules/@simplewebauthn/server/esm/authentication/verifyAuthenticationResponse.js:182-188`,
      under `(counter > 0 || credential.counter > 0) && counter <= credential.counter`, with a
      message beginning `Response counter value`; it does so *before* `verifySignature` runs
      (`:192`). Cite those lines in a comment beside the catch and match on that stable prefix,
      never on `instanceof Error` alone; everything else stays on the generic branch
- [ ] Because the counter is judged before the signature, a forged response carrying a low counter
      reads as a regression, not as a bad signature. The sentence below must therefore not claim
      the passkey *was* cloned — only that its counter went backwards, which is what a clone
      produces. Say that in the same comment

**The sentence**

- [ ] The refusal, verbatim: "This passkey's counter went backwards, which can mean a copy of it
      exists somewhere. The check was refused. Remove this passkey from Settings → Passkeys and
      enrol it again." — a `ValidationError.form`, in the module's voice, using none of the words
      `CONTEXT.md:148` and `:156` forbid
- [ ] `console.error` keeps logging the library's own cause, as it does today
- [ ] Nothing else changes: no write, no grant, the challenge stays spent

**Tests**

- [ ] The existing "bumped stored counter" test in `tests/lock.test.ts:692-710` asserts the new
      sentence (today it asserts only `instanceof ValidationError` and the console spy) and gains
      the nothing-written assertion the wrong-key test at `:712-733` already makes — `counter`
      unchanged, `last_used_at` null, no grant
- [ ] A wrong-public-key refusal still answers the generic sentence — the two branches are told
      apart by a test, so a loosened match fails it
- [ ] No route test: the unlock screen already prints whatever `ValidationError` carries
      (`tests/routes/unlock.test.ts:332-348`, `:424-432`)

**Verification**

1. `npx vitest run tests/lock.test.ts` — real pass count.
2. `npm run typecheck`, `npm run build`, `npm test`.
