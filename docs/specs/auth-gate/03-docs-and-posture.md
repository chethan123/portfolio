# 03 — Every document that said "password" now tells the truth

_Part of [0011-auth-gate.md](../0011-auth-gate.md)._

**What to build:** The documentation and posture rewrite that tickets 01 and 02 leave owing. The
repo documents itself deliberately, and today four authoritative places describe a password gate
that no longer exists and a threat model ("a household LAN, not the open internet") that this slice
has widened to "a household LAN that is not trusted either". Each document below is updated at its
own altitude per `docs/README.md` — mechanism for contributors, decisions for the operator, symptoms
for 2am — rather than receiving one pasted paragraph.

**Blocked by:** 01 and 02 — this ticket documents shipped state, not intent.

**Status:** ready-for-agent

**DESIGN.md**

- [ ] §10.1's environment table replaces the `AUTH_PASSWORD`/`SESSION_SECRET` rows with the
      gate-mode variable and points at the compose gate for everything else
- [ ] "Authentication is not multi-user" is rewritten: authentication is now *outside the app
      entirely*; what remains true — no per-person permissions, single-owner accounts, and that
      binding identity to `person` means revisiting §4.2 first — is restated around the gate
- [ ] The accepted-limitations list gains the gate's own: sign-out is a URL not a control (tracked),
      and a Google outage defers login until sessions expire

**ARCHITECTURE.md**

- [ ] §7.6's threat-model sentence changes: the LAN is no longer the trust boundary; the gate is,
      and the section says what enforces it and why `app` publishing no port is what makes it airtight
- [ ] The authorisation row still says "none — every session sees everything", now citing the
      glossary's attribution-never-permission rule
- [ ] The §2 trust table's forwarded-headers row (trusted unconditionally because `app` publishes
      no port) extends to the house proxy hop that ticket 01 configured, and the forwarded-email
      header joins the forwarded-header rows
- [ ] The closing "an instance exposed to the internet needs…" paragraph is rewritten against the
      new posture

**operating.md**

- [ ] The install walkthrough gains the one-time Google OAuth client recipe (deliberate duplication
      with `.env.example`, named in place, as that file already does elsewhere)
- [ ] "Reverse proxy and TLS" describes the house-proxy topology this slice assumes and what a
      single-Caddy operator must do differently
- [ ] The security-posture section replaces the password story: what the gate checks, what the
      allowlist is, the fail-closed contract, and what the "Five things the code does not do" list
      looks like now that rate limiting and sessions are the gate's
- [ ] Session lifetime, allowlist edits, and cookie-secret rotation are documented as the
      operator's levers, stated at their real strength: an allowlist removal alone signs that
      person out everywhere (the gate re-checks each request's email against the live-watched
      file), rotation signs out everyone at once, and the sign-out URL clears only the gate's
      cookie — the next visit re-admits silently

**runbook.md**

- [ ] "A family member's phone is lost or stolen" — remove the address from the allowlist, then
      restart the gate: removal alone revokes that person's sessions, and the restart is insurance
      because a single-file bind mount can stop following a file an editor replaces by rename.
      Rotating the cookie secret is the wider lever, signing everyone out everywhere
- [ ] "Nobody can log in" — is it Google, the gate container, or the allowlist file; the commands
      that tell them apart, and the reminder that existing sessions keep working through a Google
      outage
- [ ] "The monitor says the instance is down but the app works" — the `/healthz` exemption and what
      to check when it regresses
- [ ] The old "there is no sign-out control" entry now gives the gate's sign-out URL *with its
      limits* (own cookie only; silent re-admission on the next visit) and links the tracked issue
      for a real control, which inherits those limits as its motivation

**README.md and the guide**

- [ ] The README's run-an-instance section reflects fail-closed setup and links `operating.md` for
      the recipe
- [ ] `docs/guide/first-run.md` and every guide page that mentions the password or login screen now
      describe signing in with Google in household words; the guide explains how, never why
- [ ] Screenshot editorial notes (`docs/screenshots/README.md`, `docs/guide/images/README.md`)
      are re-read against the new reality: any note about "the no-password banner left in" and any
      capture showing the old login or banner is retaken or re-justified, per the rule that a screen
      change is not finished until screenshots are

**Superseded specs and ADRs** (the repo's precedent: stale claims in earlier specs are corrected in
place, as `dynamic-chart-resolution/02` did to spec 0008)

- [ ] `docs/specs/foundation/08-optional-password-gate.md` gets a supersession note pointing here
      and at ADR-0005; the auth-cookie bullet in `foundation/09` gets the same in one line
- [ ] Password and "inside the gate" mentions in `0001-foundation-day-zero.md`, `foundation/01`,
      and `0007-masking.md` are checked and annotated where they now mislead
- [ ] ADR-0002's sentence naming the login gate as "the only boundary this application has" gets a
      bracketed pointer to ADR-0005 — the masking decision itself stands, only its scenery moved

**Filing**

- [ ] The slice and its tickets are published to the tracker per `docs/agents/issue-tracker.md`,
      including the deferred sign-out-control issue this spec promises
