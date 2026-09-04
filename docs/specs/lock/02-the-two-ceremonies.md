# 02 — The module that offers a challenge and judges the answer

_Part of [0019-the-lock.md](../0019-the-lock.md)._

**What to build:** One `.server.ts` domain module holding every rule in this slice — the options for
both WebAuthn ceremonies, the verification of both responses, minting and extending a grant, and
whether a request may enrol at all — plus the one configuration change the slice needs. It wraps
`@simplewebauthn/server` and is the only module in the app that imports it.

In isolation because this is where the refusals live, and refusals are the part worth testing hard.
Every wrong answer a broken or hostile client can give is a test here with no browser and no route in
the way.

**Blocked by:** [01](01-the-passkey-and-the-grant.md). It reads and writes both tables.

**Status:** ready-for-agent

**The configuration change, which is this slice's one breaking deploy**

- [ ] `PUBLIC_ORIGIN` added to `configSchema` in `server/config.ts`. It exists today only as a
      Compose-level value the gate consumes; `loadConfig` builds its `present` set from the schema's
      own keys, so an unlisted variable is discarded even when set
- [ ] The `app` service's `environment:` block in `compose.yaml` gains the line, and `.env.example`
      gains the entry
- [ ] DESIGN.md §10.1 says the gate's settings are not in the environment table because the app never
      reads them. That is now half true: the row is added and the sentence is corrected to name the
      one variable both services read
- [ ] Validated through the existing `refine` shape, and refused at startup with a message naming the
      variable when the origin is not `https` or its host is not a domain — the specification forbids
      an IP address as a relying-party id, and the failure otherwise is silent until somebody cannot
      enrol
- [ ] `http://localhost` is accepted for the dev loop. The carve-out is Secure Contexts', not
      WebAuthn's — WebAuthn asks only for a valid domain string, which `localhost` is
- [ ] `.env.example` already carries `PUBLIC_ORIGIN` under the gate's heading, saying the gate builds
      its redirect from it. That entry is amended and moved, not duplicated
- [ ] This is not only a deploy change. `vitest.config.ts` deliberately sets one variable and
      `tests/config.test.ts` asserts a minimal configuration is short; a second required key turns that
      and every route test reaching `getConfig()` red. The harness, the dev path and the Compose line
      are updated in this same pull request
- [ ] DESIGN.md §10.1's table and its sentence about the gate's settings are this ticket's to fix, not
      the documents ticket's

**The dependency**

- [ ] `@simplewebauthn/server` added to dependencies and `@simplewebauthn/browser` alongside it for
      ticket 04; check the current major's own documentation rather than recalling its API
- [ ] The server package is imported by this module and nowhere else
- [ ] The browser package is imported by no `.server.ts` module and by nothing reachable from one

**Registration**

- [ ] Options request a platform authenticator, `userVerification: "required"`, and no attestation
- [ ] The user entity is a real decision, not a formality: the name is the label the person typed, so
      their password manager shows something they recognise, and the id is random per enrolment. A
      shared id would let an authenticator treat a second enrolment as replacing the first, and this
      household wants several passkeys to coexist
- [ ] Already-enrolled credential ids are excluded, so a device cannot silently enrol twice
- [ ] The challenge is generated server-side, held in the module's map, single-use, and expires
- [ ] Verification stores the credential id, public key, counter, backup eligibility and the label; a
      response that fails verification stores nothing

**Authentication**

- [ ] Options carry a fresh single-use challenge, `userVerification: "required"`, and the household's
      credential ids in `allowCredentials` — every passkey unlocks any browser, which is what makes a
      never-enrolled browser locked rather than exempt
- [ ] Handing those ids to a browser that has not unlocked is accepted, not hidden: everyone past the
      gate is a family member. The slice will hold discoverable passkeys anyway — the platform
      providers create them whatever the options ask for — so this is a choice about the request, not
      a property of the credentials
- [ ] Each entry carries the stored transports, so the browser can offer the cross-device flow
- [ ] Verification refuses a challenge that was never issued, one already spent, and one that has
      expired, each with its own message
- [ ] The library's `requireUserVerification` default is left alone rather than restated, and a test
      asserts it is in force
- [ ] The signature counter is compared only under the condition the specification states, so a
      platform authenticator reporting a constant zero is not treated as a clone
- [ ] A counter regression refuses the assertion and says so, rather than being logged and ignored
- [ ] The returned user handle is checked against the stored one
- [ ] The stored counter and `last_used_at` are updated on success; backup eligibility is not re-read
- [ ] Success mints a grant whose window is the idle window named in one place with ticket 06's grace:
      fifteen minutes, and sixty seconds
- [ ] Verifying a *registration* mints one too, and that is the only other thing that does. Registration
      also carries the user-verification flag, so it is the same proof — and without it, enrolling the
      first passkey would lock the browser that just enrolled it out on its own redirect back

**Grants**

- [ ] Reading a grant by its opaque id returns nothing for an id that does not exist and nothing for
      one past its expiry, without the caller having to check the clock
- [ ] Extending a grant moves its expiry and never resurrects an already-expired one
- [ ] The extension is skipped while more than half the window remains, so the boundary is not an
      unconditional write on every document and data request — the same reasoning that kept the sweep
      off this path
- [ ] Expired grants are swept here, in the same statement path that mints one — minting is the
      moment this table is guaranteed to be looked at, which is the rule `upload_draft` already
      states and `createDraft` already follows. No scheduler and no throttle
- [ ] Whether the instance is locked at all is answered by whether any passkey exists, and by nothing
      else — there is no setting to read
- [ ] A failure to answer that question is not an answer of "no". The read is allowed to throw, and the
      caller refuses; the pattern in `app/root.tsx`'s loader of catching and continuing is right for a
      first-run prompt and wrong for a boundary

**Enrolment and removal authorisation**

- [ ] Enrolling a passkey and removing one each require a **fresh assertion**, verified in the same
      request, not a live grant. A grant is what somebody holding an already-unlocked phone inherits,
      and these two writes decide who may unlock in future
- [ ] A request may enrol with no assertion only when no passkey exists at all: the instance is not
      locked at that moment, so there is nothing to bypass and anyone the gate admitted already sees
      every figure
- [ ] That zero-passkey window is a check-then-act, and it is closed by the insert rather than by the
      check: two browsers reading zero may both enrol, which is harmless, and the write decides the
      order. The window on the other side — after the last passkey is removed — is the design, and
      reaching it now requires an assertion, so it can no longer be walked into from a borrowed phone
- [ ] Any other request is refused, as a `ValidationError` with a message a screen can print — never a
      500, and never a silent success
- [ ] There is no enrolment token and no second path. Recovery when every passkey is unreachable is
      the operator deleting them, which returns the instance to the unlocked case above

**Tests**

- [ ] A registration response and an assertion are generated once and kept as fixtures, so the suite
      needs no browser, and ticket 01's builder seeds the matching public key
- [ ] Each refusal is provoked by varying the server's expectation — a wrong origin, a wrong
      relying-party id, a spent or unknown or expired challenge, a bumped stored counter. Flipping a
      flag inside the signed authenticator data would break the signature and the test would then
      pass for the wrong reason
- [ ] An admitted request with a live grant but no fresh assertion cannot enrol and cannot remove
- [ ] An admitted request with no grant can enrol before any passkey exists, and cannot after
- [ ] A read failure while answering "is the instance locked" propagates rather than
      returning false
- [ ] Money, dates and ids cross the driver boundary as strings as they do everywhere else
