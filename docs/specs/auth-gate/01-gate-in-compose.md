# 01 — The gate arrives in compose, in front of an unchanged app

_Part of [0011-auth-gate.md](../0011-auth-gate.md)._

**What to build:** A fourth compose service, `gate` (oauth2-proxy, image pinned to an exact
version), and the Caddyfile changes that make this stack's Caddy refuse every request the gate has
not vouched for. The app is not touched by this ticket: it still carries its password gate, which
simply stops being reachable by strangers. That ordering is the point — the new lock goes on the
door before the old one comes off (ticket 02).

The deployment contract changes here, deliberately: `compose.yaml`'s header promise of a working
instance with no manual steps is retired, and the file's comments must argue the new posture —
fail-closed until a Google OAuth client exists — as clearly as they argue the old one today.

**Blocked by:** Nothing.

**Status:** ready-for-agent

**The `gate` service**

- [ ] oauth2-proxy from the official image, pinned to an exact released version checked current at
      implementation time; no volume and no database — sessions live in its encrypted cookie
- [ ] Google is the provider; client ID, client secret, and cookie secret arrive from `.env` via
      compose `${VAR:?}` interpolation, so `docker compose up` without them stops with a message
      naming the missing variable rather than starting a crash-looping container
- [ ] The redirect URL is built from a new `PUBLIC_ORIGIN` variable (the `https://` origin the house
      proxy serves this instance at); `.env.example` documents it beside the other gate variables
- [ ] The allowlist is `authenticated_emails_file` pointing at a mounted `./allowed-emails.txt`
      (read-only), one address per line; `email_domains` is not set — the file is the whole policy
- [ ] `allowed-emails.txt` is gitignored; a committed `allowed-emails.example.txt` shows the format,
      and compose fails comprehensibly when the real file is absent
- [ ] Cookie attributes are explicit, not defaulted: `SameSite=Lax` (the instance's CSRF posture
      once ticket 02 deletes the app cookie), `Secure` on (the browser only meets this instance over
      the house proxy's TLS), expiry left at the seven-day default
- [ ] `skip_provider_button` is on: an unauthenticated browser goes straight to Google, never to an
      interstitial page
- [ ] The sidecar is told it is behind reverse proxies (its reverse-proxy setting), and exposes its
      ping endpoint as the compose healthcheck; `caddy` depends on it being healthy, same as it does
      `app`
- [ ] Restart policy and read-only-container posture match the neighbouring services where the image
      permits

**The Caddyfile**

- [ ] Every request is checked with `forward_auth` against the gate's auth endpoint before being
      proxied to `app` — static assets included
- [ ] Exactly one path is exempt: `/healthz`, proxied straight to the app so uptime monitoring never
      needs credentials
- [ ] The gate's own OAuth paths (`/oauth2/*` — sign-in, callback, sign-out) are routed to the
      sidecar, not to the app
- [ ] An unauthenticated browser request ends up at Google and, on success, back at the page it
      asked for; the exact Caddy directives for the 401-to-redirect handoff follow the current Caddy
      + oauth2-proxy documentation, checked at implementation time, not recalled
- [ ] The verified email header (`X-Auth-Request-Email`) is copied from the gate's response onto the
      request forwarded to `app`; nothing else from the gate's response is
- [ ] This stack's Caddy trusts the house proxy it sits behind, so the original
      `X-Forwarded-Proto`/`X-Forwarded-For` survive to the app — the trust argument in
      ARCHITECTURE.md §2 ("only Caddy can reach `app`") now extends one hop and must keep holding
- [ ] The Caddyfile's header comment still tells the truth about what the file does

**`.env.example` and `.gitignore`**

- [ ] A new gate section documents the Google client variables, the cookie secret (with a
      generation command), `PUBLIC_ORIGIN`, and the allowlist file — including the one-time Google
      Cloud recipe: create an OAuth client, publish the consent screen with basic scopes, set the
      redirect URI to `PUBLIC_ORIGIN` plus the sidecar's callback path
- [ ] The section states the fail-closed contract in one sentence: nothing starts until these exist
- [ ] `allowed-emails.txt` is gitignored, and the example file is not

**Smoke recipe (manual, in the PR description — this ticket has no vitest surface)**

- [ ] Fresh `docker compose up` with no gate variables fails naming the first missing one
- [ ] With credentials and an allowlisted address: browser reaches Google, returns, sees the app
- [ ] A non-allowlisted Google account is refused after Google, by the gate
- [ ] `curl` of `/healthz` through Caddy answers without credentials; `curl` of `/` does not
- [ ] The app receives `X-Auth-Request-Email` (visible with a temporary log line or header echo,
      removed before merge)
