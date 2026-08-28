# Authentication is a forward-auth gate at the instance's own front door

The household wanted passwordless, per-person access to an instance whose threat is other devices
on its own LAN — it is not exposed to the public internet, and TLS with the public hostname is
terminated by a house-wide proxy in front of this stack. We decided to authenticate with Google at
this stack's own Caddy: a pinned oauth2-proxy sidecar answers `forward_auth` for every request
except `/healthz`, admission is a flat gitignored file of family email addresses, and the app's own
password gate (`AUTH_PASSWORD`, the login page, its session cookie) is deleted rather than kept as
an unused mode. The gate ships on by default and fail-closed: compose refuses to start until the
Google OAuth credentials exist, retiring the old "boots open with a warning banner" contract.

Enforcement lives in this stack, not the house proxy, because a LAN device can reach this box
directly — protection that depended on the external proxy would be bypassable by exactly the
devices it exists to stop. The verified email is forwarded to the app on every request but is
attribution, never permission (`CONTEXT.md`): every family member still sees and can do everything,
and binding identity to `person` remains the separate design DESIGN.md says it is.

## Considered options

- **A VPN or mesh network** — the repo's own prior recommendation for remote access. Rejected
  because it answers the wrong threat: the adversary here is already on the LAN the VPN leads to.
- **Keeping the in-app password gate** — one shared secret, no per-person revocation, and the very
  password the household wanted rid of.
- **Authelia** — despite the name, an identity provider with its own user database; it does not
  delegate authentication to Google, so it reintroduces passwords under new management.
- **authentik** — delegates to Google, but is a full identity platform (several containers, its own
  database and admin UI) to check a handful of emails against a list.
- **caddy-security plugin** — no sidecar, but requires a custom-built Caddy image from a
  single-maintainer project sitting alone in front of financial data.

## Consequences

- A fresh deploy has a manual prerequisite for the first time: creating a Google OAuth client
  (recipe in `.env.example` and `operating.md`).
- The gate's cookie (`SameSite=Lax`, `Secure`, seven-day default) is now the instance's CSRF
  posture; the attribute is pinned in configuration, not assumed.
- Revocation is allowlist edit plus cookie-secret rotation — everyone, everywhere, at once. There
  is no per-device revocation and no sign-out control yet; the latter is tracked as an issue.
- A Google outage defers new logins until it passes; existing sessions ride through. The break-glass
  path is the operator's shell, not a second login system.
- Local development and the test suite run with no gate and no Google credentials; the app shows its
  unprotected-instance warning there, which is true.
