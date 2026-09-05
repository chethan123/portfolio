# 06 — Say what a signature-counter regression means

_Part of [0020-the-lock-hardened.md](../0020-the-lock-hardened.md). Acts on the launch review's
[F6](../../research/2026-09-05-lock-slice-launch-review.md#f6--should-fix--a-signature-counter-regression-tells-the-family-try-again)._

**What to build:** One distinct refusal in `verifyScopedAssertion` (`app/lib/lock.server.ts`) for
the case the library throws because the assertion's signature counter did not advance past the
stored one. Today that throw is caught with every other verification failure and answered "This
passkey could not be verified. Try again." — and the family retries a message about the one
signal WebAuthn gives them that a copy of a passkey may exist. The refusal itself is right and
writes nothing (the review confirmed `counter`, `last_used_at` and the grant table untouched); only
the sentence is wrong. Ticket 02 of the lock slice asked that a regression "refuses the assertion
and says so".

Its own ticket because it is one message and one test, and because getting the *detection* wrong
— matching the library's throw too loosely — would relabel unrelated failures as clones.

**Blocked by:** Nothing.

**Status:** ready-for-agent

**Detecting it**

- [ ] Read `node_modules/@simplewebauthn/server/esm/authentication/verifyAuthenticationResponse.js`
      and cite, in a comment beside the catch, the exact line and the exact condition under which
      the library throws for the counter (`(counter > 0 || credential.counter > 0) && counter <=
      credential.counter`) and the message it throws with. Match on that message's stable prefix,
      never on `instanceof Error` alone; everything else stays on the generic branch
- [ ] The library evaluates the counter *before* the signature. Say so in the same comment: a
      forged response with a low counter reads as a regression, not as a bad signature, and the
      refusal below must therefore not claim the passkey *was* cloned — only that its counter went
      backwards, which is what a clone produces

**The sentence**

- [ ] A `ValidationError` in the module's voice, naming the fact and the action: the counter on
      this passkey went backwards, which can mean a copy of it exists elsewhere; the check was
      refused; remove this passkey from Settings → Passkeys and enrol it again. Avoid every word
      `CONTEXT.md`'s `Passkey` and `Locked` entries forbid
- [ ] `console.error` keeps logging the library's own cause, as it does today
- [ ] Nothing else changes: no write, no grant, the challenge stays spent

**Tests**

- [ ] The existing "bumped stored counter" test in `tests/lock.test.ts` asserts the new sentence
      (today it asserts only `instanceof ValidationError`), and still asserts nothing was written
- [ ] A wrong-public-key refusal still answers the generic sentence — the two branches are told
      apart by a test, so a loosened match fails it
- [ ] `tests/routes/unlock.test.ts`: the unlock screen prints the new sentence when the action's
      refusal carries it (it already prints whatever `ValidationError` carries; one `toContain`)

**Verification**

1. `npx vitest run tests/lock.test.ts tests/routes/unlock.test.ts` — real pass counts.
2. `npm run typecheck`, `npm run build`, `npm test`.
