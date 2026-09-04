# 04 — One route, one action, and an honest message where it cannot run

_Part of [0019-the-lock.md](../0019-the-lock.md)._

**What to build:** The screen a locked browser gets. It states that the app is locked, offers one
control, and on that control runs the assertion ceremony through `@simplewebauthn/browser`. On
success it posts the response, the server verifies it, mints a grant, sets the cookie and returns the
reader to where they were. On failure it says which failure, in a sentence.

Its own ticket because it must exist before any passkey does. Enrolling the first passkey locks the
household, so shipping enrolment before the screen that lifts a lock would lock everyone out of their
own instance between two pull requests.

**Blocked by:** [03](03-the-middleware-that-refuses.md). The middleware is what sends a browser here.

**Status:** ready-for-agent

**The screen**

- [ ] One route, added to `app/routes.ts` by hand — dropping a file into `app/routes/` does nothing
- [ ] `@simplewebauthn/browser` is added here — this is the first module that imports it
- [ ] It is imported through a client-only seam, never at the module scope of a route that renders on
      the server. `npm run build` and a server render are what prove it, and the ticket is not done
      until both are clean: the bundle boundary rule is about what ships, not only about which file
      the import sits in
- [ ] Says the app is locked and that unlocking uses a passkey — the device's own provider, or another
      device the browser offers. Not "this device's own check", which is false in the cross-device
      flow, and never a fingerprint or a face, which the platform does not promise
- [ ] One button. No provider list, no QR code, no device picker: the browser draws all of that
- [ ] The return path arrives as one encoded parameter from ticket 03 and is validated by
      `safeReturn` in `app/lib/return-path.ts` — the existing single site for this, already used by
      `/masking` and `/refresh`, and the place that knows why `/\evil.test` has to be refused
- [ ] On success the reader lands back where they were

**When the ceremony cannot run**

- [ ] The server renders the button; a `<noscript>` block carries the message. With scripting off,
      `browserSupportsWebAuthn()` never runs, so the two cannot be alternatives the server chooses
      between
- [ ] Where scripting runs but WebAuthn is absent — an in-app WebView browser has none —
      `browserSupportsWebAuthn()` replaces the button with the same message. It changes what the
      reader is told and never what the server allows
- [ ] The message names the recoveries that exist: another browser on this device, a device that can
      reach one of the household's passkeys, or the operator. Not "an enrolled device" — `CONTEXT.md`
      rejects that phrasing because a passkey is not a device, and the interface should not reintroduce
      the model the glossary just ruled out. Not a dead end either
- [ ] No capability check anywhere decides whether a request is refused. An un-capable browser is
      locked because it never produces an assertion, which is a property rather than a rule

**Failures**

- [ ] A cancelled prompt says so and leaves the screen usable; it is not an error
- [ ] A refused assertion says which refusal, from the domain module's message
- [ ] A ceremony that times out can be retried without reloading

**The real-device checks this slice owes**

- [ ] Three things the spec says need a device rather than an argument are this ticket's to perform and
      record: the ceremony inside an installed iOS home-screen web app, whether a third-party password
      manager prompts or waves through after backgrounding, and whether the cross-device flow behaves
      the same in standalone display mode as in a tab
- [ ] Each is recorded as observed or as unavailable — an honest "could not check, no such device" is
      an acceptable outcome and an unstated one is not. Every other acceptance list here can pass while
      the household's primary device cannot unlock

**Tests**

- [ ] The route's action verifies through the domain module and sets the cookie only on success
- [ ] A refused assertion sets no cookie and mints no grant
- [ ] The return path is honoured, and an absolute URL is refused by `safeReturn`
- [ ] Rendered markup is asserted with `toContain` on `renderToStaticMarkup` output, as the house
      style does; the ceremony itself has no browser in the suite and is not simulated here
