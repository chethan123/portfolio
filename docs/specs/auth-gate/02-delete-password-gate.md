# 02 — The password gate comes out of the app

_Part of [0011-auth-gate.md](../0011-auth-gate.md)._

**What to build:** Deletion, mostly. With the gate (ticket 01) enforcing at Caddy, the app's own
password gate — one password, one signed cookie, one login page — is removed rather than kept as a
mode nobody deploys. What replaces it is a single honest config value: the app knows whether an
external gate fronts it, and that knowledge exists for exactly one purpose — never showing a false
"unprotected instance" warning to a family that just authenticated with Google, because a banner
people learn to ignore is worse than no banner.

The deleted module's own header says it was "deliberately shaped so that adding [users] would be a
rewrite rather than an extension"; this ticket honours that by rewriting.

**Blocked by:** 01 — the new lock must be on the door before this one comes off. A deploy of this
ticket without the gate in front is an open instance (with the banner showing, but open).

**Status:** ready-for-agent

**Configuration**

- [ ] `AUTH_PASSWORD` and `SESSION_SECRET` leave the schema in `server/config.ts`, along with their
      cross-field rule; the config tests that pinned that rule go with them
- [ ] A new variable (working name `AUTH_GATE`, values `external` and `none`, default `none`)
      says whether an external gate fronts the instance; it is a union of string literals, never a
      boolean, so a third posture later is a value rather than a redesign
- [ ] `compose.yaml` sets it to `external` — the same change that ships the gate keeps the app's
      self-description true
- [ ] An unrecognised value fails startup naming the variable, like every other config refusal
- [ ] `.env.example`'s authentication section now describes this variable and states plainly that
      the app itself authenticates no one

**Deletion**

- [ ] `app/lib/auth.server.ts` is deleted; nothing replaces its middleware — with no open-path list
      left in the app, the gate's `/healthz` exemption in the Caddyfile is the single such list
- [ ] The `login` route file and its entry in `app/routes.ts` are deleted; `npm run typecheck`
      regenerates the route types
- [ ] The root route (`app/root.tsx`) no longer calls `requireSession`; its middleware block goes
- [ ] The masking route carries no session check of its own — only comments deferring to the root
      gate and to `auth.server.ts`'s cookie reasoning; those comments are rewritten against the new
      reality rather than left pointing at deleted code
- [ ] `app/lib/forwarded.server.ts` and its test go too: after the gate and the login page leave,
      it has no production importer — the masking cookie deliberately never carried `Secure` and
      reads nothing from it, and future attribution will read the gate's email header, not this
      module. Deleting beats keeping it dead "for later"
- [ ] `compose.yaml` drops the `SESSION_SECRET` and `AUTH_PASSWORD` interpolations from the app's
      environment — stale but harmless is still stale
- [ ] A repo-wide grep for the deleted names (`authGate`, `requireSession`, `AUTH_PASSWORD`,
      `SESSION_SECRET`, `LOGIN_PATH`, the cookie name) turns up only documentation slated for
      ticket 03
- [ ] Tests of the deleted behavior are deleted, not skipped: the login flow, the open-path list,
      redirect-to-login assertions in route tests, and any fixture or helper that minted a session

**The banner**

- [ ] The open-instance banner keys off the new config value: rendered when no external gate is
      declared, absent when one is
- [ ] Its wording shifts from "no password set" to "nothing in front of this instance" — written in
      the component, not transcribed here
- [ ] Component tests assert presence and absence by mode on `renderToStaticMarkup` output, as the
      house style has it

**The forwarded email**

- [ ] The app reads nothing new: `X-Auth-Request-Email` arrives (ticket 01) and is deliberately
      unread — attribution, never permission, per `CONTEXT.md`. A comment where the old gate was
      wired (the root route) is the one place the code says so, pointing at the glossary

**Dev and tests after the deletion**

- [ ] `npm run dev` with no gate variables runs open-with-banner, exactly as an unset
      `AUTH_PASSWORD` does today; no Google credentials are ever needed to develop or test
- [ ] The suite passes with no session anywhere: any test that logged in to reach a route now
      reaches it directly
