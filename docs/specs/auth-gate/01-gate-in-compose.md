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
      implementation time, and specifically the `-alpine` flavour: the default image is distroless
      (no shell, no wget), and a compose healthcheck execs inside the container; no volume and no
      database — sessions live in its encrypted cookie
- [ ] The gate publishes no port, same as `app`, and the compose comment says why it is
      load-bearing here too: with its reverse-proxy setting on, the sidecar trusts forwarded
      headers from whatever reaches it, so "only Caddy can" must hold for the gate as well
- [ ] Google is the provider; client ID, client secret, and cookie secret arrive from `.env` via
      compose `${VAR:?}` interpolation, so `docker compose up` without them stops with a message
      naming the missing variable rather than starting a crash-looping container
- [ ] The redirect URL is built from a new `PUBLIC_ORIGIN` variable (the `https://` origin the house
      proxy serves this instance at); `.env.example` documents it beside the other gate variables
- [ ] The allowlist is `authenticated_emails_file` pointing at a mounted `./allowed-emails.txt`
      (read-only), one address per line; `email_domains` is not set — the file is the whole policy
- [ ] `allowed-emails.txt` is gitignored; a committed `allowed-emails.example.txt` shows the format
- [ ] The allowlist mount uses long-form bind syntax with `create_host_path: false`, so a missing
      file stops `docker compose up` with a message — Docker's short syntax would instead create a
      *directory* at that path and hand the sidecar a crash loop plus junk in the deploy dir
- [ ] Cookie attributes are explicit, not defaulted: `SameSite=Lax` (the instance's CSRF posture
      once ticket 02 deletes the app cookie), `Secure` on (the browser only meets this instance over
      the house proxy's TLS), expiry left at the seven-day default
- [ ] `skip_provider_button` is on: an unauthenticated browser goes straight to Google, never to an
      interstitial page
- [ ] The sidecar is told it is behind reverse proxies (its reverse-proxy setting), and its ping
      endpoint backs the compose healthcheck (`wget` against it, which is why the image flavour
      above matters); `caddy` depends on it being healthy, same as it does `app`
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
- [ ] This stack's Caddy trusts the house proxy it sits behind (`trusted_proxies`), so the original
      `X-Forwarded-Proto`/`X-Forwarded-For` survive to the app — ARCHITECTURE.md §2's trust row
      (forwarded headers believed unconditionally *because* `app` publishes no port) now extends
      one hop and must keep holding
- [ ] The Caddyfile's header comment still tells the truth about what the file does

**`.env.example` and `.gitignore`**

- [ ] A new gate section documents the Google client variables, the cookie secret (with a
      generation command), `PUBLIC_ORIGIN`, and the allowlist file — including the one-time Google
      Cloud recipe: create an OAuth client, publish the consent screen with basic scopes, set the
      redirect URI to `PUBLIC_ORIGIN` plus the sidecar's callback path
- [ ] The section states the fail-closed contract in one sentence: nothing starts until these exist
- [ ] `allowed-emails.txt` is gitignored, and the example file is not

**CI's smoke test keeps passing — with the gate in the stack, not around it**

The fail-closed `${VAR:?}` interpolation breaks `scripts/smoke-test.sh` as it stands (CI runs it
via the workflow, and the publish job gates on it): the script composes up with no gate variables
and asserts `/healthz` through Caddy. oauth2-proxy never contacts Google at startup, so CI can run
the real gate with throwaway values.

- [ ] The workflow (or the script) supplies dummy gate variables — a well-formed cookie secret,
      fake client ID and secret, a `PUBLIC_ORIGIN` — and writes a CI `allowed-emails.txt`
- [ ] The script's own header prose stops promising no-manual-steps, matching compose.yaml's
      rewritten contract, and its failure-path `docker compose logs` line includes `gate`
- [ ] The script's existing assertion set still passes (`/healthz` is exempt), and gains the two
      cheap gate assertions from the recipe below that need no Google account

**Smoke recipe — agent-runnable with dummy credentials (real client optional until the last group)**

- [ ] Fresh `docker compose up` with no gate variables fails naming the first missing one
- [ ] `curl` of `/healthz` through Caddy answers without credentials
- [ ] `curl` of `/` through Caddy is refused and the redirect points at Google's authorization
      endpoint with the configured client ID and redirect URL in it
- [ ] `/oauth2/*` paths answer from the sidecar, not the app

**Smoke recipe — operator-only, needs the real client and an allowlisted account (in the PR
description; no agent can complete the Google leg)**

- [ ] With credentials and an allowlisted address: browser reaches Google, returns, sees the app
- [ ] A non-allowlisted Google account is refused after Google, by the gate
- [ ] The app receives `X-Auth-Request-Email` (visible with a temporary log line or header echo,
      removed before merge)
