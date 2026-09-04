# 04 — One route, one action, and an honest message where it cannot run

_Part of [0019-the-lock.md](../0019-the-lock.md)._

**What to build:** The screen a locked browser gets. It states that the app is locked, offers one
control, and on that control runs the assertion ceremony through `@simplewebauthn/browser`. On
success it posts the response, the server verifies it, mints a grant, sets the cookie and returns the
reader to where they were. On failure it says which failure, in a sentence.

It is its own ticket because it must exist before any passkey does. Enrolling the first passkey locks
the household, so shipping enrolment before the screen that lifts a lock would lock everyone out of
their own instance between two pull requests.

**Blocked by:** [03](03-the-middleware-that-refuses.md). The middleware is what sends a browser here.

**Status:** ready-for-agent

**The screen**

- [ ] One route, added to `app/routes.ts` by hand — dropping a file into `app/routes/` does nothing
- [ ] Says the app is locked and that unlocking uses this device's own check; it does not promise a
      fingerprint or a face, because the platform does not
- [ ] One button. No provider list, no QR code, no device picker: the browser draws all of that
- [ ] Carries the return path through the ceremony and returns the reader to it on success
- [ ] The return path is validated the way the masking route's already is — a relative path within
      this app, never an absolute URL

**When the ceremony cannot run**

- [ ] `browserSupportsWebAuthn()` decides whether the button or a message is rendered; it changes what
      the reader is told and never what the server allows
- [ ] With scripting off, the screen renders and says the app cannot be unlocked in this browser. There
      is no form to post, because there is nothing a form could send
- [ ] The message names the recoveries that exist — another browser on this device, a device already
      enrolled, or the operator — rather than leaving the reader at a dead end
- [ ] No capability check anywhere decides whether a request is refused: an un-capable browser is
      locked because it never produces an assertion, which is a property, not a rule

**Failures**

- [ ] A cancelled prompt says so and leaves the screen usable; it is not an error
- [ ] A refused assertion says which refusal, from the domain module's message, without leaking
      whether a given credential id exists
- [ ] A ceremony that times out can be retried without reloading

**Tests**

- [ ] The route's action verifies through the domain module and sets the cookie only on success
- [ ] A refused assertion sets no cookie and mints no grant
- [ ] The return path is honoured, and an absolute URL is refused
- [ ] Rendered markup is asserted with `toContain` on `renderToStaticMarkup` output, as the house
      style does — the ceremony itself has no browser in the suite and is not simulated here
