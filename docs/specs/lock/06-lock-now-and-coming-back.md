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
      grace, it navigates to the unlock screen
- [ ] The grace is a constant named beside ticket 02's idle window, in one place
- [ ] It navigates rather than covering the page, so the server decides. A client that re-locked by
      drawing over the screen would leave the figures underneath it
- [ ] The module header says this is courtesy and never enforcement, because the next person to read
      it will otherwise assume the security lives here. A hidden page cannot be trusted to run timers,
      and `visibilitychange` cannot tell a locked screen from an app switch

**Tests**

- [ ] The action deletes the grant and clears the cookie; a subsequent request is refused
- [ ] The control renders in both chrome positions and posts as a real form
- [ ] The re-entry behaviour is not simulated: there is no browser in the suite, and spec 0007 made
      the same call for masking's client-side cookie write. The constant and ticket 02's server-side
      idle window are what the tests pin
