# 04 — Narrow what a registration is allowed to store

_Part of [0020-the-lock-hardened.md](../0020-the-lock-hardened.md). Acts on the launch review's
[F5](../../research/2026-09-05-lock-slice-launch-review.md#f5--should-fix--a-hostile-registration-can-store-a-poisoned-or-unreadable-passkey-row)._

**What to build:** Two small checks in `app/lib/lock.server.ts`, one at each end of
`completeRegistration`. On the way in, `transports` is client input the library copies verbatim
(`node_modules/@simplewebauthn/server/esm/registration/verifyRegistrationResponse.js:202`), so it
belongs in the existing boundary narrowing — a registration-specific extension of
`webAuthnResponseShape` (`lock.server.ts:653-656`) used by `narrowRegistration` (`:674`). On the way
out, the credential id the library returns comes from the attested credential data with no length
check and is never compared to `response.id` (`verifyRegistrationResponse.js:42` compares `id` to
`rawId` only; `parseAuthenticatorData.js:34-36` reads any length, and `:121`'s `!credentialID`
passes an empty array), so two checks sit after verification and before either insert. The review
reproduced a stored credential id of `""` that then rides in every browser's `allowCredentials`, a
1024-byte one, a `transports` string that turns `joinTransports` into a 500, and a stored `''`
transport that migration 0012's comment says the writer must never write.

Its own ticket because a wrong check would refuse real enrolments — the tests carry the fixture's
own registration through it as well as the hostile ones — and because the counter case the review
listed turns out to be unreachable, which is worth saying once.

**Blocked by:** Nothing. Ticket 09 waits for this one.

**Status:** ready-for-agent

**On the way in**

- [ ] `narrowRegistration` narrows `response.response.transports` as: absent, or an array of
      strings, each non-empty, at most 32 characters, containing no comma. The vocabulary is
      deliberately not enforced (migration 0012's comment on the column: an unknown transport is
      still worth keeping). A refusal here happens before the challenge is spent, which is fine —
      the author is a gate-admitted family member either way — and answers its own sentence, in
      the module's voice, naming the value
- [ ] Assertions are untouched: the shared shape stays as it is and the extension is
      registration-only

**On the way out**

- [ ] Two checks on `verified.registrationInfo.credential.id`, after `verified.verified` and
      before either insert: its decoded length is between 1 and 1023 bytes (the specification's
      ceiling; `isoBase64URL.toBuffer` is already imported), and it equals `parsedResponse.id`.
      Each refusal is a `ValidationError` with its own sentence; neither is a schema — two `if`s
      with this paragraph as their comment
- [ ] No `counter` check: the library reads it with `getUint32`
      (`parseAuthenticatorData.js:27`), so a value outside the column's range cannot arrive through
      `completeRegistration`. The review's `4294967295` case is a *maximal* counter the range
      accepts and the column's own check already guards. Say so in the comment beside the two
      checks, so nobody adds it later on the review's word
- [ ] The module header's `unknown`-at-the-boundary paragraph gains one sentence: the library's
      *output* is checked too, for the one value stored that it forwards from client-chosen bytes
      without validating

**Tests**

- [ ] `tests/lock.test.ts`, one `it.each` over the hostile `transports` values — a string, a
      number, `null`, `[""]`, `["a,b"]`, a 40-character entry — asserting a `ValidationError` and
      no `passkey` row; and one `it` each for the zero-length attested id, the 1024-byte one and
      the id that differs from `response.id`, asserting the sentence and no row
- [ ] The existing enrolment tests pass unchanged — the fixture's registration goes through both
      checks
- [ ] `tests/support/webauthn.ts`'s `registrationResponse` gains an option to set the *attested*
      credential id independently of `id`/`rawId` (today all three derive from one value,
      `webauthn.ts:205-210`, `:222-223`) and a `transports` override typed `unknown` for the hostile
      cases (today the module constant at `:139` is baked in at `:227`), each with a header
      sentence on why it exists

**Verification**

1. `npx vitest run tests/lock.test.ts tests/routes/settings-passkeys.test.ts` — real pass counts.
2. The zero-length-id test and the string-`transports` test must fail on the parent commit (one
   stores a row, the other throws a `TypeError` from `app/lib/lock.ts:74`) — confirm before the
   change.
3. `npm run typecheck`, `npm run build`, `npm test`.
4. If a browser is to hand: the drive script's S2 enrolment still lands one row with `transports`
   stored as the virtual authenticator reports it.
