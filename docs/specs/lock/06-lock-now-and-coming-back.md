# 06 — The control that locks it, and the return that re-locks it

_Part of [0019-the-lock.md](../0019-the-lock.md)._

**What to build:** Two ways a browser becomes locked without waiting for the idle window. A control in
the chrome that locks the current browser immediately, and a re-entry rule that sends a browser to the
unlock screen when it comes back after being hidden longer than a short grace.

Separately from the unlock screen because these are the unlocked side of the feature, and because the
control is the part that actually answers the threat this slice names. Handing somebody your phone is
a thing you know you are about to do; one tap beforehand beats any timer.

**Blocked by:** [04](04-the-unlock-screen.md). Runs in parallel with
[05](05-enrolling-and-listing-passkeys.md).

**Status:** ready-for-agent

**Lock now**

- [ ] A control in the chrome beside the masking toggle, on both the rail and the mobile layout
- [ ] A real form posting to a resource route, the way the masking toggle does — this one *can* be
      progressive, and should be, because locking must work even where unlocking cannot
- [ ] The action deletes the grant, clears the cookie, and redirects to the unlock screen
- [ ] Its label states the action, not the state, matching the masking toggle's rule
- [ ] It sits beside masking without being mistakable for it: one hides amounts on a screen you are
      reading, the other ends the reading

**Coming back**

- [ ] On `visibilitychange` to hidden the client records the time; on return, if the gap exceeds the
      grace, it navigates to the unlock screen
- [ ] The grace is a constant named in one place, with the idle window from ticket 02
- [ ] This is courtesy and never enforcement: the comment says so, because the next person to read it
      will otherwise assume the security lives here. A hidden page cannot be trusted to run timers, and
      `visibilitychange` cannot tell a locked screen from an app switch
- [ ] Navigating rather than hiding, so the server decides — a client that re-locks by covering the
      page would leave the figures underneath it

**Tests**

- [ ] The action deletes the grant and clears the cookie; a subsequent request is refused
- [ ] The control renders in both layouts and posts as a real form
- [ ] The label states the action in both directions
- [ ] The re-entry behaviour has no browser in the suite and is not simulated; the constant and the
      server-side idle window are what the tests pin, as spec 0007 does for its client-side cookie write
