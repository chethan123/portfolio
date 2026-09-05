# 04 — Narrow what a registration is allowed to store

_Part of [0020-the-lock-hardened.md](../0020-the-lock-hardened.md). Acts on the launch review's
[F5](../../research/2026-09-05-lock-slice-launch-review.md#f5--should-fix--a-hostile-registration-can-store-a-poisoned-or-unreadable-passkey-row)._

**What to build:** A Zod narrowing in `app/lib/lock.server.ts`, between `verifyRegistrationResponse`
returning and the insert, over the three values the module stores from the library's
`registrationInfo.credential`: `id`, `transports` and `counter`. The library hands them back as
the client sent them — the attested credential id with no length check and no comparison against
`response.id`, `transports` copied verbatim whatever its type — and the module stores them as they
are. The review reproduced a stored credential id of `""` that then rides in every browser's
`allowCredentials`, a 1024-byte one, a `transports` string that turns `joinTransports` into a 500,
and a stored `''` transport that migration 0012's comment says the writer must never write.

Its own ticket because it is one boundary check in one function with a printable refusal for
each shape, and because a wrong one would refuse real enrolments — the tests carry a real
registration through it as well as the hostile ones.

**Blocked by:** Nothing.

**Status:** ready-for-agent

**The narrowing**

- [ ] One schema, in the domain module beside `webAuthnResponseShape`, applied to
      `verified.registrationInfo.credential` before either insert:
      - `id`: a non-empty base64url string whose decoded length is between 1 and 1023 bytes (the
        specification's ceiling), and equal to the narrowed response's own `id` — the library
        compares `id` to `rawId` and never to the attested credential data
      - `transports`: absent, or an array of strings, each non-empty, at most 32 characters, and
        containing no comma (the column joins on commas; the vocabulary is deliberately not
        enforced, per migration 0012's comment, so an unknown transport is kept)
      - `counter`: an integer from 0 to 4294967295 — the column's own `check`, refused here as a
        sentence rather than surfaced as a raw `23514`
- [ ] Each refusal is a `ValidationError` with its own sentence, in the module's existing voice
      ("This passkey response could not be read" is too vague for a value the library accepted;
      say which value), never a 500. `joinTransports` is reached only with an array
- [ ] The refusal happens after the challenge is spent and before anything is written — the same
      place a failed verification already sits — so a hostile registration costs its author a
      fresh `beginEnrolment` and nothing else
- [ ] The module header's `unknown`-at-the-boundary paragraph gains one sentence: the library's
      *output* is narrowed too, for the three values stored, because it forwards client-chosen
      bytes it never validates

**Tests**

- [ ] `tests/lock.test.ts`, one `it` per shape, each asserting a `ValidationError` naming the value
      and that no `passkey` row was written: a zero-length attested credential id; a 1024-byte one;
      an attested id that differs from `response.id`; `transports` as a string, a number, `null`,
      `[""]`, `["a,b"]`, and a 40-character entry; `counter` above the 32-bit range if
      `registrationResponse` can be made to carry one (it writes `uint32BE`, so say in the test why
      the range refusal is pinned at the schema rather than through the fixture)
- [ ] The existing enrolment tests still pass unchanged — the fixture's own registration goes
      through the narrowing
- [ ] `tests/support/webauthn.ts`'s `registrationResponse` gains whatever options the shapes above
      need (an attested id override independent of `id`/`rawId`; a `transports` override typed as
      `unknown` for the hostile cases) with a header sentence on why each exists

**Verification**

1. `npx vitest run tests/lock.test.ts tests/routes/settings-passkeys.test.ts` — real pass counts.
2. The zero-length-id test and the string-`transports` test must fail on the parent commit (one
   stores a row, the other throws a `TypeError`) — confirm before the change.
3. `npm run typecheck`, `npm run build`, `npm test`.
4. If a browser is to hand: the drive script's S2 enrolment still lands one row with
   `transports` stored as the virtual authenticator reports it.
