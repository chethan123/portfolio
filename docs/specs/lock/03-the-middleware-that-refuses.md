# 03 — Locked by default, in one place

_Part of [0019-the-lock.md](../0019-the-lock.md)._

**What to build:** The root middleware that makes locked the default. It reads the grant cookie, asks
the domain module whether that grant is live, and either extends it and continues or refuses the
request before any loader runs. When the household holds no passkey it continues unconditionally, so
this ticket ships as a no-op on a live instance.

Alone because it is the boundary, and a boundary deserves a pull request whose whole diff a reviewer
can hold in their head. It is also what proves the refusal is structural: one place to read, not a
rule repeated in every loader the way masking's is.

**Blocked by:** [02](02-the-two-ceremonies.md). It asks that module every question it asks.

**Status:** ready-for-agent

**Where it goes, and what shape it is**

- [ ] A `middleware` export from `app/root.tsx`. This framework has no middleware slot in the route
      config, so `app/routes.ts` is not the site: middleware is exported by a route module, and root
      is the only module whose export runs for every route
- [ ] `app/root.tsx`'s standing comment says the gate used to be wired here as root middleware and
      that nothing replaces it. That sentence is now false and is corrected in this ticket, not left
      for the documents ticket
- [ ] It refuses **before** calling `next()`. The chart-range middleware is the only other one here
      and is the wrong shape to copy: it is registered on two routes and awaits `next()` to decorate
      the response, which would run every loader before refusing — the thing ADR-0012 forbids
- [ ] With no passkey enrolled it calls `next()` unconditionally; the instance is not locked and this
      pull request changes nothing a family member can see
- [ ] It fails closed. "No passkey" and "the query threw" are different answers and must not collapse
      into the same branch: `app/root.tsx`'s loader catches and continues twice, which is right for a
      first-run prompt and wrong here. A boundary that opens when Postgres hiccups is not a boundary
- [ ] With a passkey enrolled and no live grant, the browser is sent to the unlock screen and no
      loader runs
- [ ] A live grant is extended by the request that used it, which is what makes the window idle
      rather than absolute — but only once less than half the window remains, so the boundary is not
      an unconditional write on every document and data request
- [ ] The return path travels as one encoded parameter, not as the query it came from: the gate's own
      redirect truncates a target at the first ampersand, and an owner filter beside a chart range is
      exactly that target

**What sits outside**

- [ ] The unlock route, or the middleware would refuse the screen that lifts the refusal
- [ ] The health endpoint, which the gate already exempts for the same reason
- [ ] Nothing else, and the list is short because it can be. The service worker, the manifest and the
      icons are static files under `public/` served outside the router, so no route middleware runs
      for them and they need no exemption to name
- [ ] A test enumerates the exempt paths and fails when the list grows, so an addition is a decision
      somebody makes rather than a line somebody adds

**The cookie**

- [ ] Carries the grant's opaque id and nothing else — no claim, no timestamp, no signature, because
      the row is the authority and a copied value names a row that can be deleted
- [ ] `__Host-` prefixed, `Secure`, `HttpOnly`, `Path=/`, `SameSite=Lax`
- [ ] `Secure` and the prefix are where this parts company with the masking cookie, which omits both
      deliberately because it carries a preference and must survive an instance reached over plain
      http. This one carries a credential, and WebAuthn will not run outside a secure context anyway
- [ ] The dev loop serves plain http on localhost, where a `Secure` cookie is a browser-by-browser
      carve-out rather than a guarantee. Say in the module header whether the dev path works, having
      actually tried it, rather than leaving the next person to find out
- [ ] A test states why `Strict` is wrong: the gate's redirect through Google returns as a top-level
      cross-site navigation, and `Strict` would withhold the cookie and re-lock every browser every
      time the gate refreshed
- [ ] Cleared when the grant it names is gone, so a stale cookie does not survive to confuse the next
      unlock
- [ ] Parsed by reusing `readMaskingCookie`'s whole-name matching rather than a third hand-rolled
      parser; extract it if that is what reuse takes

**Tests**

- [ ] With no passkey, every screen renders — the no-op case, tested first because it is what the
      pull request ships
- [ ] With a passkey and no grant, the assertion that bites is that **`next()` was never invoked**.
      Asserting "the markup contains no figure" against a refusal that renders nothing passes
      unconditionally, which is the vacuous test this is trying to forbid
- [ ] `servedThrough` in `tests/support/routes.ts` cannot prove that today: its `next` closes over a
      stand-in response and records nothing, so a middleware that awaited `next()` and *then* threw is
      indistinguishable from one that refused first. This ticket changes that helper — an invocation
      flag, or an injected `next` — and that change is part of its diff, not an assumption about it
- [ ] A middleware that refuses by throwing never returns through the helper, so the test unwraps the
      thrown `Response` the way the existing helpers do
- [ ] A read failure refuses rather than continuing
- [ ] With a live grant, the same screen renders as it does today
- [ ] An expired grant refuses, and a grant extended by a request survives past its original expiry
- [ ] Each exempt path is reachable while locked; a non-exempt one is not
