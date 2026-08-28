# The gate — Google sign-in at the front door, and no passwords anywhere

Canonical here. See [ADR-0005](../adr/0005-auth-is-a-forward-auth-gate.md) for why a forward-auth
gate at the instance's own Caddy was chosen over a VPN, over the existing in-app password, and over
a self-hosted identity provider.

## Problem Statement

The instance runs on a home LAN that carries more than the household: guest devices, IoT, anything
that joins the wifi. Today the only thing between those devices and the family's complete financial
picture is the optional single shared password (`app/lib/auth.server.ts`) — one secret everyone
types, with no way to tell family members apart, no per-person revocation, and no protection at all
when `AUTH_PASSWORD` is unset. The household wants stronger, passwordless access — each member
signing in with the Google account already on their phone — without the app growing a user system.

The instance is *not* exposed to the public internet. TLS and the public hostname are terminated by
an existing house-wide Caddy that fronts all of the operator's apps; this stack's own Caddy receives
plain HTTP behind it. That external proxy is deliberately not trusted with enforcement: a LAN device
can reach this box's published port directly, so the gate must travel with the app.

## Solution

A forward-auth gate inside this compose stack. A new sidecar service (oauth2-proxy) speaks OIDC to
Google; this stack's Caddy asks it about every request and refuses any that lacks a valid session,
bouncing the browser straight to Google's own sign-in and back. Who may enter is a flat file of
family email addresses mounted into the sidecar — the only authorization there is. The app's own
password gate is deleted: no login page, no password, no session cookie of its own. The app keeps
exactly one honest notion — "an external gate fronts me" — which silences the open-instance warning
it would otherwise show, and it receives the authenticated email as a request header it does not yet
read: attribution for the future, never permission.

The gate is on by default and fail-closed: a fresh `docker compose up` refuses to start until the
operator has created a Google OAuth client and provided its credentials. That deliberately replaces
the old "works with no manual steps, open to anyone" posture with "fails loudly until protected".

## User Stories

1. As a family member on my phone, I want to open the portfolio and be let in via the Google account
   my phone is already signed into, so that I never type a password for this app.
2. As a family member whose session cookie has expired, I want the renewal to bounce through Google
   and back without showing me any screen, so that sign-in is a once-per-device event in practice.
3. As a guest on the household wifi who finds the instance by IP, I want to be met by a Google
   sign-in I cannot complete (my email is not on the allowlist), so that being on the LAN grants
   nothing.
4. As the operator, I want the set of admitted people to be a file of email addresses in my deploy
   directory, so that adding a family member is adding a line, not administering an identity server.
5. As the operator, I want a fresh deployment to fail loudly with a message naming the missing
   Google credentials rather than boot open, so that a half-configured instance can never leak.
6. As the operator whose uptime monitor probes `/healthz`, I want that one path to answer without
   credentials, so that monitoring keeps working through the gate.
7. As the operator responding to a lost phone, I want a documented way to kill every session at once,
   so that revocation does not depend on the phone's cooperation.
8. As a family member using the app, I want every screen to behave exactly as before — same routes,
   same masking, no new chrome — so that the gate is invisible once I am through.
9. As a developer running `npm run dev` or the test suite, I want the app to run without any gate in
   front and simply show its unprotected-instance warning, so that development needs no Google
   credentials.
10. As a developer adding a feature later that wants to know who acted, I want the verified email
    already arriving on every request, so that attribution is a small change instead of an auth
    redesign.

## Implementation Decisions

**Enforcement lives in this stack, not the house proxy.** The house-wide Caddy stays a dumb TLS
terminator and load balancer. This stack's Caddy is the enforcement point, because it is the only
component every path to the app shares — including a LAN device dialing the box's IP directly. The
existing invariant that `app` publishes no port (`compose.yaml`) is what makes the gate airtight and
is restated wherever the gate is documented.

**oauth2-proxy, pinned, as a fourth compose service named `gate`.** Chosen over Authelia (an
identity provider with its own user database — it does not delegate to Google, putting passwords
back), over authentik (a full identity platform: several containers to check a handful of emails),
and over the caddy-security plugin (a custom Caddy build from a single-maintainer project). The
sidecar is stateless — sessions live in an encrypted cookie — so it needs no volume and no database,
matching this stack's read-only-container posture.

**Straight to Google.** The sidecar's own interstitial sign-in page is skipped
(`skip_provider_button`); an unauthenticated browser goes directly to Google's account chooser. The
only login UI anyone ever sees is Google's.

**The allowlist is one flat file, and the only authorization.** `allowed-emails.txt`, one address
per line, gitignored (real family addresses never enter a public repo), mounted read-only into the
sidecar, with a committed `.example` showing the format. oauth2-proxy takes its list of individual
emails from a file — its only alternative would put the addresses into the committed Caddyfile —
which settles where the list lives. The Google consent screen is published (basic
scopes only, no review needed), so Google's console holds no second copy of the list — a stranger
can reach Google's account picker and gets refused by the allowlist, which costs nothing.

**Sessions are the sidecar's encrypted cookie.** Seven-day lifetime (the default), `SameSite=Lax`
pinned — after the app's own cookie is deleted this attribute is the instance's CSRF posture, so it
is set explicitly rather than inherited — and `Secure` set explicitly, since the browser only ever
meets this instance over the house proxy's TLS. Revocation has two levers, both runbook entries:
removing an address from the allowlist signs that one person out everywhere on their next request —
the gate re-validates every request's session email against the file, and watches the file for
changes — and rotating the cookie secret in `.env` signs out everyone on every device at once. The
runbook still says to restart the gate after editing the file, because a single-file bind mount can
silently stop following a file an editor replaces by rename.

**The redirect URI is LAN-only and that is fine.** Google redirects the *browser*, and the browser
is on the LAN or VPN; Google's servers never call the URI. The one server-to-server exchange is
outbound from the sidecar. The URI must merely be `https://` on the real domain the house proxy
serves.

**Only `/healthz` bypasses the gate.** It is read by machines, answers a pinned body, and exposes
no household data — the pending-migrations list it carries is the "version fingerprint" that
`operating.md` already documents, its exposure unchanged from today's gate exempting the same path.
Everything else — static assets included, which the old in-app gate left open — is
challenged. The compose-internal healthcheck already reaches the app directly and never crosses
Caddy.

**The app's password gate is deleted, not kept as a mode.** `AUTH_PASSWORD`, `SESSION_SECRET`, the
login route, and the session cookie all go. The app's remaining knowledge is a single config value
saying whether an external gate fronts it, which exists so the app never shows a false
"unprotected instance" warning behind the gate — the banner is real security signal and must not
train the family to ignore it. Keeping a password mode nobody deploys would be speculative
generality against `AGENTS.md`'s grain.

**Identity is attribution, never permission.** Caddy forwards the sidecar's verified email header to
the app on every request. The app ignores it today; nothing binds it to `person`, which remains an
ownership label. Any future feature that reads it may attribute actions but must not gate them —
every family member sees and can do everything. Recorded in `CONTEXT.md`.

**Fail-closed by default, and the compose contract rewritten to say so.** `compose.yaml`'s header
currently promises a working instance with no manual steps; that promise is retired deliberately.
Required gate variables use compose's `${VAR:?}` form so a missing credential stops `docker compose
up` with a message naming it, before any container runs half-configured.

## Testing Decisions

The gate itself is infrastructure — compose and Caddy configuration — and is not exercised by the
vitest suite; its ticket carries a manual smoke recipe instead. What the suite does pin is the app's
side of the seam:

- Config: the new gate-mode value parses, defaults to "no external gate", and the deleted variables
  are genuinely gone from the schema (a config test naming them would now fail to compile).
- The warning banner renders in the ungated mode and does not render in the gated mode.
- The login route, its tests, and every session-dependent assertion are removed with the code they
  tested — deleted behavior keeps no tests, per `AGENTS.md`.
- Routes that formerly threw redirects to the login page (via the root middleware) no longer do;
  the route-level tests that encoded those redirects are updated to the new reality.

## Out of Scope

- **Binding the authenticated email to `person`, or any per-person permission.** `person` stays an
  ownership dimension; DESIGN.md's note that multi-user auth would first mean revisiting the
  single-owner model stands.
- **A sign-out control in the UI.** Deliberately deferred, not rejected — the household finds its
  absence slightly iffy, so it is tracked as its own issue when this slice is filed with the
  tracker. The runbook documents the sidecar's sign-out URL in the meantime, and says plainly what
  it is worth: it clears only the gate's own cookie, and with straight-to-Google sign-in the next
  visit re-admits silently, so the real levers are the allowlist and the cookie secret.
- **TLS inside this stack.** The house proxy owns TLS; this stack still speaks plain HTTP behind it.
- **Any second authentication factor, rate limiting beyond what the gate provides, or lockout.**
  Google's own account security is the factor story.
- **A VPN or mesh network.** Rejected for this threat model, not merely deferred: the adversary is
  already on the LAN, which a VPN onto that LAN does nothing about (ADR-0005).
- **Multiple identity providers, or any provider other than Google.**

## Further Notes

**Broken into three implementation tickets** under [`docs/specs/auth-gate/`](auth-gate/): the gate
in compose and Caddy, the deletion of the in-app password gate, and the documentation and posture
rewrite. The first two are separated so each PR stands alone *and* deploys safely in order — the
gate must exist before the password it replaces is removed.

**Glossary and ADR land with this spec**, not with the tickets: `CONTEXT.md` gains **Gate** and
**Authenticated email** (and the Masked entry's "login gate" sentence is corrected), and
[ADR-0005](../adr/0005-auth-is-a-forward-auth-gate.md) records the trade-off, because the decision
is made even though the code is not yet.
