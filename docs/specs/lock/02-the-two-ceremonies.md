# 02 — The module that offers a challenge and judges the answer

_Part of [0019-the-lock.md](../0019-the-lock.md)._

**What to build:** One `.server.ts` domain module holding every rule in this slice: the options for
both WebAuthn ceremonies, the verification of both responses, minting and extending a grant, and the
judgement of whether a request is allowed to enrol a passkey at all. It wraps `@simplewebauthn/server`
and is the only module in the app that imports it.

In isolation because this is where the refusals live, and refusals are the part worth testing hard.
Every wrong answer a hostile or broken client can give — a replayed challenge, a challenge nobody
issued, an assertion signed for another origin, one with the verification flag cleared — is a test
here with no browser and no route in the way. Once this module is right, the routes above it are
translation.

**Blocked by:** [01](01-the-passkey-and-the-grant.md). It reads and writes both tables.

**Status:** ready-for-agent

**The dependency**

- [ ] `@simplewebauthn/server` added to dependencies and `@simplewebauthn/browser` alongside it for
      ticket 04's use; check the current major's own documentation rather than recalling its API
- [ ] The server package is imported by this module and nowhere else
- [ ] The browser package is imported by no `.server.ts` module and by no module reachable from one

**The relying party**

- [ ] The relying-party id and the expected origin are derived from the configured public origin —
      the one the gate's redirect already depends on — and stated in one place
- [ ] Configuration refuses at startup, with a message naming the variable, if that origin is not
      `https` or its host is not a domain: the specification forbids an IP address as a
      relying-party id, and the failure otherwise is silent until a family member cannot enrol
- [ ] `localhost` over `http` is accepted, because the specification carves it out and the dev loop
      needs it

**Registration**

- [ ] Options request a platform authenticator, `userVerification: "required"`, and no attestation
- [ ] Already-enrolled credential ids are excluded, so a device cannot silently enrol twice
- [ ] The challenge is generated server-side, stored, single-use, and expires
- [ ] Verification stores the credential id, public key, counter, both backup flags, the AAGUID and
      the label; a response that fails verification stores nothing

**Authentication**

- [ ] Options carry a fresh single-use challenge, `userVerification: "required"`, and the household's
      credential ids in `allowCredentials` — every passkey unlocks any browser, which is what makes a
      never-enrolled browser locked rather than exempt
- [ ] Verification refuses a challenge that was never issued, one already spent, and one that has
      expired, each with its own message
- [ ] Verification requires user verification, not merely user presence, and refuses when the flag is
      clear
- [ ] The signature counter is compared only under the condition the specification states, so a
      platform authenticator reporting a constant zero is not treated as a clone
- [ ] A counter regression refuses the assertion and says so, rather than being logged and ignored
- [ ] The stored counter, backup state and `last_used_at` are updated on success
- [ ] Success mints a grant with the rolling idle window; nothing else mints one

**Grants**

- [ ] Reading a grant by its opaque id returns nothing for an id that does not exist and nothing for
      one past its expiry, without the caller having to check the clock
- [ ] Extending a grant moves its expiry and never resurrects an already-expired one
- [ ] Whether the instance is locked at all is answered by whether any passkey exists, and by nothing
      else — there is no setting to read

**Enrolment authorisation**

- [ ] A request carrying a valid grant may enrol
- [ ] A request carrying a single-use enrolment token minted out of band may enrol, and the token is
      spent whether or not the ceremony then succeeds
- [ ] A request with neither is refused, as a `ValidationError` with a message a screen can print —
      never a 500, and never a silent success
- [ ] Passing the gate is not enrolment authorisation, and a test says so by name

**Tests**

- [ ] A registration response and an assertion are generated once and kept as fixtures, so the suite
      needs no browser
- [ ] Each refusal above has a test that reproduces it and asserts the message names the reason
- [ ] Money, dates and ids cross the driver boundary as strings as they do everywhere else
