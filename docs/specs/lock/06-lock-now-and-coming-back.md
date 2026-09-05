# 06 — The control that locks it, and the return that re-locks it

_Part of [0019-the-lock.md](../0019-the-lock.md)._

**What to build:** Two ways a browser becomes locked without waiting out the idle window. A control in
the chrome that locks the current browser immediately, and a re-entry rule that sends a browser to the
unlock screen when it comes back after being hidden longer than a short grace.

Separate from the unlock screen because these are the unlocked side of the feature, and because the
control is the part that actually answers the threat this slice names. Handing somebody your phone is
a thing you know you are about to do, and one tap beforehand beats any timer.

**Blocked by:** [04](04-the-unlock-screen.md). Runs in parallel with
[05](05-enrolling-and-listing-passkeys.md).

**Status:** ready-for-agent

**Lock now**

- [ ] A control in the chrome, in both places `MaskingToggle` is rendered from `app/root.tsx`: the
      rail's foot, and the top bar drawn below the rail's breakpoint. Not the phone's bottom nav,
      which holds neither of them
- [ ] Drawn only while the instance is locked at all. With no passkey enrolled it would clear a grant
      that does not exist and send the reader to a screen no credential can satisfy, while every route
      stays open behind it — a control that appears to do something and cannot
- [ ] A real form posting to a resource route, the way the masking toggle does. This half *can* be
      progressive and should be, because locking has to work in a browser where unlocking cannot
- [ ] The action deletes the grant, clears the cookie, and redirects to the unlock screen
- [ ] Its label states the action rather than the state, matching the masking toggle's rule. Unlike
      that toggle it has one direction only — a locked browser is not rendering the chrome — so there
      is no second label to write or to test
- [ ] It sits beside masking without being mistakable for it: one dots the amounts on a screen you
      are reading, the other ends the reading

**Coming back**

- [ ] On `visibilitychange` to hidden the client records the time; on return, if the gap exceeds the
      grace, it **posts the lock action** — the same route the control uses. Navigating to the unlock
      screen alone would leave the grant row and its cookie live, so Back or a typed URL would be
      admitted and nothing would have been locked
- [ ] The grace uses the constant ticket 02 names beside the idle window — sixty seconds, and fifteen
      minutes — rather than declaring a second one here
- [ ] It navigates rather than covering the page, so the server decides. A client that re-locked by
      drawing over the screen would leave the figures underneath it
- [ ] A `pageshow` guard sits beside the `visibilitychange` one: on a restore with `event.persisted`
      true, ask the server rather than trust the page handed back — a revalidation, not an
      unconditional lock post, because a persisted restore is not by itself evidence the grant is gone
- [ ] The module header says the *trigger* is courtesy and never enforcement, because the next person
      to read it will otherwise assume the security lives here. A hidden page cannot be trusted to run
      timers, and `visibilitychange` cannot tell a locked screen from an app switch — what it fires is
      a server-side deletion, which is not a courtesy at all
- [ ] What locking cannot reach is said here too: another tab of the same browser keeps its rendered
      figures until it next asks the server for something. Ticket 03's `no-store` is *not* what stops a
      back-forward restore handing a page back without asking, not in every engine: Chrome has admitted
      a `no-store` document to its bfcache by default since 2025, caps such an entry's life at three
      minutes, and evicts it early only when this browser's own cookies change, never when a grant or
      passkey was removed elsewhere. Firefox refuses the cache outright regardless of protocol; Safari's
      refusal is narrower — WebKit guards it on the response's protocol being HTTPS, so the identical
      page over plain HTTP (this app's own local dev loop) is left eligible, and only a production
      instance's HTTPS origin gets Safari's refusal for free. A `pageshow` guard beside the
      `visibilitychange` one is what closes the gap that remains — Chrome always, and Safari's own
      local-dev loop. The guarantee is that the lock ends the reading, not that it wipes what is already
      drawn

**Tests**

- [ ] The action deletes the grant and clears the cookie; a subsequent request is refused
- [ ] The control renders in both chrome positions and posts as a real form, and does not render at
      all while the household holds no passkey
- [ ] After the action, a request carrying the old cookie is refused — the grant is gone, not merely
      redirected past
- [ ] The screenshots are deferred to ticket 07's single capture pass, not retaken here: the capture
      path (`scripts/capture-screenshots.ts`, `scripts/seed-demo.ts`) seeded no passkey at all, so
      `isLocked()` is false throughout capture and neither chrome layout this ticket changes ever
      renders the control. Making it render needs a seeded passkey *and* a live grant plus the cookie
      on the capture browser — one change to the capture scripts that serves tickets 05 and 06
      together, rather than three tickets fighting over the same PNGs. (What shipped does it in
      `capture-screenshots.ts` alone, and ticket 07's own box carries the why.)
- [ ] `watchReentry`'s own wiring is simulated with a plain `document`/`window` stand-in (two listener
      methods on each, a clock) — no jsdom, no real browser, following spec 0007's call for masking's
      client-side cookie write on the pieces that genuinely need nothing more. `shouldPostLock`'s
      boundary and the grace constant are what the tests pin beneath that
