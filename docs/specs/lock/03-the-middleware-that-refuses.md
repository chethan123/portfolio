# 03 — Locked by default, in one place

_Part of [0019-the-lock.md](../0019-the-lock.md)._

**What to build:** The middleware that makes locked the default. It runs ahead of every route,
reads the grant cookie, asks the domain module whether that grant is live, and either extends it and
continues or stops the request before any loader runs. A browser with no cookie, an unknown id, or an
expired grant is locked. When the household holds no passkey the middleware continues unconditionally,
so this ticket ships as a no-op on a live instance.

Alone because it is the boundary, and a boundary is worth a pull request whose whole diff a reviewer
can hold in their head. It is also the ticket that proves the refusal is structural: there is one
place to read, not a rule repeated in every loader the way masking's is.

**Blocked by:** [02](02-the-two-ceremonies.md). It asks that module every question it asks.

**Status:** ready-for-agent

**The middleware**

- [ ] Registered in `app/routes.ts` beside the chart-range middleware, which is the shape to copy
- [ ] With no passkey enrolled it continues, always — the instance is not locked and this ticket
      changes nothing a family member can see
- [ ] With a passkey enrolled and no live grant, the request is stopped and the unlock screen is what
      the browser gets; no loader runs and no figure is fetched
- [ ] A live grant is extended by the request that used it, which is what makes the window idle rather
      than absolute
- [ ] The redirect carries the originating path and query so ticket 04 can return the reader to it
- [ ] The expired-grant sweep is called from here, throttled so it is not a query on every request

**What sits outside**

- [ ] The unlock route, or the middleware would refuse the screen that lifts the refusal
- [ ] The health endpoint, which the gate already exempts for the same reason
- [ ] The service worker, the manifest and the icons — the offline page must still render for a
      browser that cannot reach the server, and none of them carries a figure
- [ ] Nothing else. A test enumerates the exempt paths and fails when the list grows, so an addition
      is a decision somebody makes rather than a line somebody adds

**The cookie**

- [ ] Carries the grant's opaque id and nothing else — no claim, no timestamp, no signature, because
      the row is the authority
- [ ] `SameSite=Lax`, `HttpOnly`, `Path=/`, and a test that states why `Strict` is wrong: the gate's
      redirect through Google returns as a top-level navigation, and `Strict` would re-lock every
      browser every time the gate refreshed
- [ ] Cleared when the grant it names is gone, so a stale cookie does not survive to confuse the next
      unlock
- [ ] Parsed with whole-name matching, the way the masking cookie already is

**Tests**

- [ ] With no passkey, every screen renders — the no-op case, tested first because it is what the
      pull request ships
- [ ] With a passkey and no grant, a screen's rendered markup contains no figure at all; asserting
      only the redirect would pass even if a loader had run
- [ ] With a live grant, the same screen renders as it does today
- [ ] An expired grant refuses, and a grant extended by a request survives past its original expiry
- [ ] Each exempt path is reachable while locked; a non-exempt one is not
