# Operating an instance

Everything a self-hoster needs that is not in the [README](../README.md): what the containers are,
what to put in `.env`, how it sits behind your own proxy, the security decisions that are yours
rather than the code's, what to watch, backing the data up, restoring it, and upgrading.

When something is already broken and you want a procedure, that is [`runbook.md`](runbook.md). This
file is how the instance is meant to be run.

- [What runs here](#what-runs-here)
- [Installing](#installing)
- [Environment variables](#environment-variables)
- [Reverse proxy and TLS](#reverse-proxy-and-tls)
- [Installing on a phone](#installing-on-a-phone)
- [Security](#security)
- [Monitoring](#monitoring)
- [Backups](#backups)
- [Restoring](#restoring)
- [Upgrading](#upgrading)
- [Growth and limits](#growth-and-limits)

---

## What runs here

The services defined in [`compose.yaml`](../compose.yaml), under the project name `portfolio`.

| Service | What it is | Published port |
|---|---|---|
| `db` | Postgres. All persistent state, in the named volume `db-data` | none |
| `app` | The application: pages, uploads, and the price refresh loop, in one process | none |
| `gate` | oauth2-proxy. Answers "may this request in?" against Google and the allowlist | none |
| `caddy` | The ingress front door, and where the gate is enforced | **`80:8080`, on every interface** — host side still 80; 8080 is Caddy's own listener |

A request goes browser → `caddy` → `gate` → `caddy` → `app` → `db`: Caddy asks the gate about every
request except `/healthz` before it forwards anything. Only `caddy` is reachable from your LAN;
`app`, `db` and `gate` are reachable only on the compose network. That is not a hardening extra — it
is the assumption both the app's trust of `X-Forwarded-*` and the gate's own trust of them rest on,
and [Security](#security) says what breaks if you publish either port yourself.

They start in dependency order: `app` waits for `db` to report healthy, and `caddy` waits for both
`app` and `gate`.

**`gate` is pinned to an exact release**, not a floating major like `app`. Nobody here watches that
image for a breaking change, and it is the thing that keeps everyone out. It is the `-alpine`
flavour specifically, because its healthcheck needs `wget`, which the default distroless image does
not carry.

**`gate` is stateless.** The session is an encrypted cookie in the browser, so there is no volume
and no database behind it — only the read-only bind mount of `./allowed-emails.txt`, which is the
whole of who may enter.

**`app` is stateless and enforced as such.** It writes nothing to its own filesystem, so it can be
destroyed and recreated freely, and every upgrade does exactly that.

**Every service holds only the privileges it was proved to need.** All four drop every Linux
capability, set `no-new-privileges`, and run on a read-only root filesystem, with a tmpfs over what
each still writes to — `/tmp` for `app` and `gate`, Postgres's socket directory for `db`, `/config`
and `/data` for `caddy`. Three run as an unprivileged uid: `app` as `node`, `db` as the
image's `postgres` (70), `caddy` as 65532. Two capabilities are granted back, each argued in
`compose.yaml` from a start failure without it: `DAC_READ_SEARCH` on `gate`, which is
[still root](#security), so that it can open your allowlist whatever its mode and owner; and
`NET_BIND_SERVICE` on `caddy`, which its binary needs in order to `exec` at all rather than to bind
anything. `scripts/smoke-test.sh` asserts all of it against a running stack — nothing else would
notice a container quietly regaining root.

**`app` is pulled, not built.** The image is `ghcr.io/chethan123/portfolio-app`, published by CI
for `linux/amd64` and `linux/arm64` when a version tag is pushed. `compose.yaml` has no `build:`
stanza on purpose: if the registry is unreachable or the tag does not exist, the deploy fails and
says so, rather than starting a multi-minute Node build on this machine. Which tag it runs is
[`APP_VERSION`](#environment-variables), and it defaults to the floating major.

**`db-data` is the only named volume, and it is everything.** Every statement, every stored original
CSV, every price. `docker compose down` leaves it alone; `docker compose down -v` deletes it.

---

## Installing

**Host requirements.** Docker Engine with the Compose v2 plugin — `docker compose`, two words, not
the older `docker-compose` script. Port 80 free. Outbound HTTPS to `ghcr.io`, because the app image
is pulled, and to `quay.io`, because the gate image is. A Google account for each family member, and
one Google Cloud project to hold the OAuth client. `linux/amd64` and `linux/arm64` are both
published, so a Raspberry Pi or an ARM NAS needs nothing special. There is no build step and
therefore no build-memory requirement — that is the whole point of publishing the image, and it is
what makes a small NAS or VPS a reasonable host.
Node itself is a requirement for *working on* this, not for running it.

**Bringing it up is one command, and it belongs to the README:**
[Running an instance](../README.md#running-an-instance). It is deliberately not repeated here — that
reader has installed nothing and needs the whole shape; you are at a terminal and need what comes
after.

**It will refuse to start until the gate is configured, and that is the design.** There is no mode
in which this stack boots open: every variable in the gate section of `.env` is interpolated with
Compose's `${VAR:?}` form, so a missing or empty one stops `docker compose up` before any container
runs, with a message naming the variable. A missing `allowed-emails.txt` stops it the same way.
Everything in this section up to [Verify it actually worked](#verify-it-actually-worked) is
therefore prerequisite, not optional hardening.

### One-time Google setup

**[`google-sign-in.md`](google-sign-in.md) is the walkthrough, and it is deliberately not repeated
here.** It is the one document for standing the gate up: the Google Cloud project, the consent
screen and why it is published, the OAuth client and the redirect URI Google matches character for
character, the gate's settings, the allowlist, and how to prove that a real sign-in and a real
refusal both work. Read it before the first `up` — you need the public origin your house proxy will
serve this instance at decided first, because the redirect URI is built from it.

What it leaves here: the credentials it produces are `GATE_CLIENT_ID`, `GATE_CLIENT_SECRET`,
`GATE_COOKIE_SECRET` and `PUBLIC_ORIGIN` in `.env` ([Environment variables](#environment-variables)),
and none of them reaches the application — they configure the `gate` service alone.

### Who may enter

`./allowed-emails.txt`, beside `compose.yaml`, one Google address per line, bind-mounted read-only
into the gate and re-checked on every request. It is gitignored;
[`allowed-emails.example.txt`](../allowed-emails.example.txt) is the committed copy showing the
format, and [`google-sign-in.md`](google-sign-in.md#step-5--the-allowlist) is where it gets written.

There is no domain rule and deliberately no option for one: the narrowest domain that would admit
this household also admits every other Gmail account on earth. The file is the only authorization
this instance has, and everyone on it sees and can do everything. Editing it is
[a lever with real teeth](#revocation-and-the-levers-you-have).

### What to put in `.env`

`cp .env.example .env`, then fill in its gate section — [`google-sign-in.md`](google-sign-in.md)
walks you through where each of those values comes from. Beyond them, every setting has a working
default except `DATABASE_URL`, which Compose supplies. One more is worth deciding before the first
`up`:

- `POSTGRES_PASSWORD` — because it is read only when the data directory is first created. Setting it
  later is a different, more annoying operation ([Environment variables](#environment-variables)).

The full surface, with defaults, is the table in [Environment variables](#environment-variables).

### Running against your own Postgres

Set `DATABASE_URL` in `.env` to point at it. Four things that catch people:

- The connection is made from inside a container, so `localhost` in that URL means the *app
  container*, not your host. Use a hostname or address the container can actually reach.
- The bundled `db` service still starts, still creates `db-data`, and `app` still waits for it to
  report healthy. Setting `DATABASE_URL` does not remove it — delete the `db` service and `app`'s
  `depends_on` block if you do not want it running.
- Migrations run at every container start, against whatever `DATABASE_URL` names, so the role needs
  to be able to create tables. There is no separate migrate step to run.
- Every `pg_dump` command below runs *inside* the bundled `db` container. On your own Postgres,
  backups become your Postgres's problem, and [Backups](#backups) is then about `.env` and the
  allowlist only.

### Verify it actually worked

```sh
docker compose ps
curl -i http://localhost/healthz
```

All four services `running` and `healthy` — `caddy`'s own check requests `/healthz` through its full
proxy path to `app`, so a healthy `caddy` means the hop works and not merely that the process is up.
And `/healthz` answering `200` with exactly:

```json
{"status":"ok","database":true,"migrations":"current","pendingMigrations":[]}
```

Any other body on that endpoint means something, and [Monitoring](#monitoring) says what.

`/healthz` is the one path the gate does not challenge, so a `200` there proves nothing about
sign-in. Check the front door separately:

```sh
curl -sS -o /dev/null -w '%{http_code} %{redirect_url}\n' http://localhost/
```

A `302` to `/oauth2/sign_in` is the gate refusing an unauthenticated request, which is what you
want. A `200` means the gate is not in the path and every device on your LAN has the instance.

The last leg — a real Google account completing a real sign-in — is yours to walk once, from a
browser at your public origin. Nothing in CI can do it, and nothing on the box can either.

> **`scripts/smoke-test.sh` is a CI tool and it destroys data.** It runs `docker compose down -v`
> before it starts and again from an exit trap, which deletes the `db-data` volume — every
> statement, every stored original, every price. It exists to prove that a *fresh* machine refuses
> to start until the gate is configured and then comes up whole, using throwaway Google credentials
> that never contact Google. Never point it at an instance you care about.

---

## Environment variables

The complete configuration surface an operator has. Every deployment setting is an environment
variable, with one exception — who may enter is [a file](#who-may-enter), because it is a list that
grows. The household's own settings (the capital gains rate, the masking policy, the refresh
cadence) are database rows edited under Settings instead, not here. [`.env.example`](../.env.example)
is this same table with the reasoning attached; copy it to `.env` and fill in the gate section.

All of them are validated once at startup. A missing or malformed value stops the container
immediately with a message naming the variable, rather than failing hours later on the request that
happens to need it.

| Variable | Required | Default | What it does |
|---|---|---|---|
| `DATABASE_URL` | **Yes** | — | Postgres connection string. Compose supplies one pointing at its own `db` service, so you only set this to run against your own Postgres. |
| `AUTH_GATE` | No | `none` | Whether the app has been *told* that something in front of it authenticates. `external` silences the unprotected-instance banner; `none` draws it. `compose.yaml` hardcodes `external` because the `gate` service is right there, so you do not set this — a developer running the app with nothing in front of it does. It is a description of the deployment, not a switch: setting it protects nothing. |
| `PORT` | No | `3000` | The port the app listens on *inside* the compose network, and the port Caddy proxies to. It is **not** the published host port: that is the fixed `80:8080` in [`compose.yaml`](../compose.yaml). Moving the host side means editing the left half of that line; the right half is Caddy's listener and is also the `Caddyfile`'s site address, so those two only ever move together. |
| `MAX_UPLOAD_MB` | No | `10` | The most a statement upload may carry, in whole mebibytes, minimum 1. A brokerage CSV is tens of kilobytes, so the cap bounds an accident, not real use. **Not wired through `compose.yaml`** — see below. |
| `MARKET_TIMEZONE` | No | `America/New_York` | IANA zone for deciding whether the market is open, and for reading which trading day a quote belongs to — so it picks the date a daily close is filed under. No effect on how timestamps are stored, which is UTC. |
| `TZ` | No | `UTC` | Container clock. The database stores UTC whatever this says, so this only affects how the app's own log lines read. Leaving it at `UTC` is recommended. |

**One variable this table used to carry is gone.** How often quotes are refreshed is the
household's dial rather than the deployment's, so it moved into the application: set it at
Settings → Prices (whole minutes, 1–1440, default 15; the automatic poll still runs in the app
process and only while the market is open — the **Refresh now** control on any figure screen spends
a request at any hour). An environment that still sets the old
`PRICE_POLL_INTERVAL_MINUTES` is ignored without error — if you had tuned it, re-enter the value
once on that screen after upgrading.

**The gate's own settings are Compose-level too, and they are the required ones.** `GATE_CLIENT_ID`,
`GATE_CLIENT_SECRET`, `GATE_COOKIE_SECRET` and `PUBLIC_ORIGIN` configure the `gate` service; the
application never sees any of them. They have no defaults on purpose, and `compose.yaml`
interpolates them with `${VAR:?}`, so `docker compose up` stops on the first one that is unset *or
empty* and names it — before a container exists, which is why the message is Compose's rather than
the startup validator's. Two of them have specific shapes:

- `GATE_COOKIE_SECRET` must decode to exactly 16, 24 or 32 bytes; the gate builds an AES cipher from
  it and refuses to start otherwise, naming `cookie_secret` in its log. Generate one with
  `openssl rand -base64 32 | tr -- '+/' '-_'`. Rotating it is
  [the blunt revocation lever](#revocation-and-the-levers-you-have).
- `PUBLIC_ORIGIN` is the `https://` origin your house proxy serves, no trailing slash. The gate
  builds its Google redirect URL as `PUBLIC_ORIGIN` + `/oauth2/callback`, which must match what is
  registered on the OAuth client exactly ([One-time Google setup](#one-time-google-setup)).

**Two more that Compose reads and the application never sees.** `POSTGRES_PASSWORD` is the `db`
service's password, covered under [Running against your own Postgres](#running-against-your-own-postgres).
`APP_VERSION` is the published image tag the `app` service runs — it defaults to `1`, the floating
major, which is what makes `docker compose up -d` an upgrade. Pin a full version (`APP_VERSION=1.0.3`)
to hold this instance where it is, or to go back to a known-good image; see
[There is no rollback](#there-is-no-rollback) first, because the image alone is not one. Neither
variable is validated at startup: they are resolved by Compose before a container exists, so a typo
surfaces as a failed pull, not as the message naming the variable that the settings below get.

**An empty value reads as unset, not as "configured to empty" — on both sides, in opposite
directions.** For the application's own variables an empty assignment falls back to the default, so
`AUTH_GATE=` in `.env` means `none` and the app draws its warning banner: it errs towards claiming
less protection than it has, never more. For the gate's own settings, empty is a refusal to start. Neither
can leave you quietly unprotected.

**`MAX_UPLOAD_MB` does not reach the container under the bundled Compose file.** It is validated and
read by the application, but it is missing from the `app` service's `environment:` block, so setting
it in `.env` changes nothing and the cap stays at 10. To raise it, add the variable to that block
yourself:

```yaml
    environment:
      MAX_UPLOAD_MB: ${MAX_UPLOAD_MB:-10}
```

`POSTGRES_PASSWORD` also appears in `.env.example`. It configures `compose.yaml` rather than the
app, which is why it is not in the table above.

**It only takes effect on an empty volume.** Postgres reads it when it first initialises its data
directory and never again. On an instance that has already run, changing `POSTGRES_PASSWORD` and
`DATABASE_URL` together does not rotate the password — it leaves the app unable to authenticate and
crash-looping. Change it inside the database instead, then update `DATABASE_URL` to match:

```sh
docker compose exec db psql -U portfolio -d portfolio \
  -c "alter role portfolio with password 'the-new-one'"
```

---

## Reverse proxy and TLS

**Two proxies, and they do different jobs.** This stack assumes you already run a house-wide
reverse proxy that terminates TLS and owns the public hostname; the bundled `caddy` container sits
behind it, speaks plain HTTP on the box's port 80, and is where the gate is enforced. Caddy's
configuration lives in [`Caddyfile`](../Caddyfile) at the repository root.

| | Terminates TLS, owns the hostname | Enforces the gate |
|---|---|---|
| Your house proxy | **yes** | no |
| This stack's `caddy` | no | **yes** |

**Enforcement is deliberately not the house proxy's.** A device on your LAN can dial this box's
published port 80 directly and land on the bundled Caddy, skipping the house proxy entirely — and
that device is the whole reason the gate exists. So the gate travels with the app, in the one
container every path to it shares.

`caddy` is also still the only container that publishes a port. `app`, `db` and `gate` are reachable
only on the compose network, which is what keeps those ports off your LAN rather than relying on you
to bind them to loopback.

**Point your house proxy at this box's port 80**, and serve it at the origin you put in
`PUBLIC_ORIGIN`. Nothing else has to be configured there: the bundled Caddy sets the forwarded
headers the gate and the app need, and trusts the ones your proxy set
([Forwarded headers](#forwarded-headers)).

**The session belongs to that origin.** The gate issues its cookie `Secure` and scoped to the host
the browser used, so a browser that reaches this stack any other way — the box's IP over plain HTTP,
a second hostname — holds no cookie the gate will accept, and is bounced to Google and back to
`PUBLIC_ORIGIN` rather than being let in where it stands. That is the gate working, not a
misconfiguration.

### If this stack's Caddy is your only Caddy

Everything above assumes a proxy in front. Running without one is supported, but five things change,
and all five are yours to do:

- **Give the site block a real hostname** instead of `:8080` in the `Caddyfile`, so Caddy requests
  and renews a certificate for it, and add `http_port 8080` / `https_port 8443` to its global block.
  Then publish `443:8443` alongside the existing `80:8080`. Caddy is pinned to an unprivileged uid
  and cannot bind 80 or 443 inside the container; those two options are Caddy's own answer to exactly
  that — the ports it listens on internally, with the public ones forwarded onto them — and they do
  not change what a browser connects to. 80 still carries the redirect and the ACME HTTP challenge,
  one hop further in.
- **Swap Caddy's two tmpfs mounts for named volumes** before the first certificate is issued. The
  section below is then about you, and it is a replacement rather than an addition.
- **`PUBLIC_ORIGIN` is that hostname**, and the redirect URI registered with Google is that hostname
  plus `/oauth2/callback`. There is no second place to change.
- **Keep the `handle` blocks as they are.** The `/healthz` exemption, the `/oauth2/*` passthrough to
  the sidecar and the `forward_auth` on everything else are the gate. Adding TLS is editing the site
  address and the global block, never the body.
- **Adjust the container healthcheck, and any uptime monitor** — the end of the section below has
  the working shape.

The `trusted_proxies` line stays correct either way: with no proxy in front there is simply nothing
sending `X-Forwarded-*` for Caddy to believe.

### Before you enable TLS, give Caddy volumes

Relevant only if you terminate TLS here rather than at a house proxy. `compose.yaml` puts Caddy's
`/data` and `/config` on tmpfs, so both die with the container. `/data` is where it keeps the ACME
account key and every certificate it has ever issued. Recreating the container throws all of it away
— and recreating the container is exactly what the `docker compose up -d` in
[Upgrading](#upgrading) does, every time. The next start asks the certificate authority for
everything again from scratch. Enough of those in a week and Let's Encrypt's rate limit refuses,
which leaves the site with no certificate at all and a wait before it can have one.

**Replace the tmpfs entries; you cannot add volumes beside them.** Compose refuses two mounts on one
target — `target /data already mounted as services.caddy.tmpfs` — so the whole `tmpfs:` block goes:

```yaml
  caddy:
    # delete the `tmpfs:` block; these two take its place
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config

volumes:
  db-data:
  caddy_data:
  caddy_config:
```

**A fresh volume needs nothing more.** Volumes seed from the image, and the image's storage
directories — `/data/caddy`, `/config/caddy` — are world-writable, so uid 65532 writes them from the
first start. (The root-owned `0755` parents are why the tmpfs entries carry `mode=1777`: a tmpfs
seeds nothing.) A volume created any other way must have `/data/caddy` writable to 65532 — an
unwritable one fails at config load, `provisioning CA … permission denied`. Probe the storage path,
not its parent:

```sh
docker compose exec caddy sh -c 'touch /data/caddy/ok && rm /data/caddy/ok'
```

`caddy_data` is the one that matters. `caddy_config` only saves re-deriving the autosaved config,
and costs nothing to add at the same time.

**One more thing then needs adjusting: the container healthcheck, and any uptime monitor.** The
check requests `http://127.0.0.1:8080/healthz`, which on a hostname site meets the HTTPS redirect —
and pointing busybox `wget` at the TLS listener fails on SNI. Keep a plain-HTTP site carrying only
the exemption beside the hostname block:

```
http://127.0.0.1:8080 {
	handle /healthz {
		reverse_proxy app:{$APP_PORT:3000}
	}
}
```

External monitors move to `https://<hostname>/healthz` — plain-HTTP `/healthz` now answers only from
inside the container.

### Forwarded headers

The gate **trusts `X-Forwarded-*`**, and the bundled Caddy sets them itself — nothing to configure
there. The application now reads no forwarded header at all; the two it used to read went with the
password it served.

| Header | Who reads it | Effect |
|---|---|---|
| `X-Forwarded-Proto`, `X-Forwarded-Host` | `gate` | The scheme and host the sign-in redirects are built with. Without them the sidecar would build them from this stack's internal plain HTTP and nobody could follow them. |
| `X-Forwarded-For`, `X-Real-IP` | `gate` | The client address in the sidecar's own log lines. Nothing is authorised on either. |
| `X-Auth-Request-Email` | nothing, yet | The [authenticated email](../CONTEXT.md) the gate vouched for, forwarded to `app` on every admitted request. The app reads it nowhere today — it is attribution, never permission — and Caddy deletes any value a browser sent before copying the gate's, so nobody can assert their own identity. |

**The Caddyfile trusts these from any private address**, not from one named proxy: it sets
`trusted_proxies static private_ranges`, because the house proxy's address is yours and not this
repository's. The honest reading is that a peer on your LAN can forge `X-Forwarded-*` at this stack.
That is affordable only because nothing decides anything on them — the gate's verdict comes from a
session cookie it decrypts itself, and its redirect URL is pinned in `compose.yaml` rather than read
from a header. If you want it tighter, replace `private_ranges` with your proxy's address.

The database is never exposed either: `compose.yaml` publishes no port for it, and the app reaches
it over the compose network.

---

## Installing on a phone

**The instance installs as an app, at `PUBLIC_ORIGIN` and nowhere else.** The application ships a
web app manifest and a service worker, so a browser signed in through the house proxy's HTTPS
origin can add it to the home screen as a real install — its own icon, a standalone window.
Everything involved stays behind the gate, with no asset path exempted in the `Caddyfile` for it —
[`ARCHITECTURE.md` §7.7](../ARCHITECTURE.md#77-the-installed-shell) holds the mechanism.

Two properties are decisions rather than gaps
([ADR-0007](adr/0007-the-service-worker-stores-nothing.md)):

- **Nothing is stored on the phone.** The service worker is network-only — no cached screens, no
  last-known figures. Off the VPN, the installed app shows a branded connect-the-VPN page and
  nothing else, so a phone that leaves the household holds no balances.
- **A LAN address does not install.** Service workers require a secure context; the house proxy's
  TLS supplies it at [`PUBLIC_ORIGIN`](#reverse-proxy-and-tls), plain-HTTP LAN addresses supply
  none — and the gate refuses those requests anyway.

---

## Security

[`ARCHITECTURE.md` §7.6](../ARCHITECTURE.md#76-security-posture) holds the control table — what each
mechanism is and why it was built that way. **That table is deliberately not repeated here.** This
section is the other half: the decisions that are yours, and the consequences you inherit whether or
not you make them.

### What the gate checks, and what an attacker on your LAN reaches

Every request that arrives at the bundled Caddy — including routes that do not exist yet, and
including the JavaScript bundles, the CSS and the font, which the old in-app gate left open — is
put to the `gate` sidecar before Caddy will forward it. The sidecar admits it only if all of this
holds:

- the request carries the gate's session cookie, and that cookie decrypts with `GATE_COOKIE_SECRET`;
- the email inside it is on `allowed-emails.txt`, **re-checked on every single request**, not only
  at sign-in;
- and the person got that cookie by completing a real Google sign-in at `PUBLIC_ORIGIN`.

Anything else is a redirect to Google. A guest on your wifi who finds the instance by IP gets the
account picker and, if they sign in with an address that is not listed, an error from the gate — not
a page.

**`/healthz` is the one exemption**, so uptime monitoring keeps working without a Google account.
It carries no household data, but it does name the *filenames* of any migration the image carries
that the database has not applied — a version fingerprint available to anyone who can reach port 80.
That is unchanged from before the gate, which exempted the same path.

**The allowlist is the whole of authorization.** Everyone it admits sees and can do everything:
every balance, every account, every uploaded statement, and every screen that writes. There is no
read-only mode, no per-person permission, and no admin. The authenticated email the gate attaches to
each request is attribution, never permission, and nothing in the app reads it.

### Fail-closed, and what that buys you

There is no configuration of this stack that serves the application to an unauthenticated visitor.
A missing or empty gate credential stops `docker compose up` before a container exists; a missing
`allowed-emails.txt` stops it the same way; a `GATE_COOKIE_SECRET` of the wrong length stops the
sidecar; and a stopped sidecar means Caddy answers nothing but `/healthz`. The failure mode is an
instance that is **down**, never one that is open. That is the trade the old
"boots with no manual steps" contract was exchanged for, and it is deliberate.

The application still carries its unprotected-instance banner, and behind this stack you will never
see it — `compose.yaml` tells the app a gate fronts it. **If that banner ever appears on your
instance, believe it**: something is serving the app without the gate in front.

### What the code still does not do, that you may assume it does

**Rate limiting and lockout are Google's, not yours.** There is no password to guess here any more,
so the brute-force surface moved to Google's own sign-in — which does have rate limiting, lockout
and whatever second factor each family member has enabled. What is *not* rate limited is the gate
itself: an unlisted address can be offered at it as fast as the network allows, and each attempt is
refused with nothing counting them. Nothing in the Caddyfile limits rates either; the stock
`caddy:2-alpine` image has no rate-limiting module.

**Session handling is the sidecar's, and its shape is fixed in `compose.yaml`.** The cookie is
encrypted rather than merely signed, `SameSite=Lax` and `Secure` are set explicitly, and the
lifetime is the seven-day default — which is what makes signing in a once-per-device event rather
than a weekly ritual, because the renewal bounces through Google without showing anyone a screen.
There is no server-side session store, so there is nothing to revoke a single cookie against; see
[the levers below](#revocation-and-the-levers-you-have).

**There is no CSRF token anywhere.** `SameSite=Lax` on the gate's cookie is the whole of it, and now
that the app carries no cookie of its own it is the entire posture — which is why `compose.yaml`
pins the attribute rather than inheriting it. Against a signed-in household that covers the ordinary
cross-site form post.

**No security headers are set at all.** No CSP, no HSTS, no `X-Frame-Options`, no
`X-Content-Type-Options`: the app sets none and the Caddyfile sets none. If you want them, a `header`
block in the Caddyfile is where they go. Nothing in the app depends on their absence, but nothing has
been run behind a strict CSP either, so test it rather than assuming.

**The gate container runs as root, holding one capability.** `app`, `db` and `caddy` do not; `gate`
does, because the published `-alpine` image sets no `USER` and `compose.yaml` argues that pinning a
uid here would be the worse choice — it would decide on your behalf that your allowlist file is
readable by that uid, and hand you a sidecar that will not start over a file mode nobody mentioned.
What bounds it: every capability dropped but `DAC_READ_SEARCH`, which is exactly the root power being
kept — opening a file it does not own, whatever its mode — plus `no-new-privileges`, a `read_only`
filesystem with a tmpfs `/tmp`, no volume and no published port. Uid 0 holding one capability is a
far smaller soft spot than root was, and it is still written down rather than left to be discovered.

**A LAN peer can forge `X-Forwarded-*` at this stack**, because the Caddyfile trusts them from any
private address rather than from one named proxy ([Forwarded headers](#forwarded-headers)). That is
affordable only for as long as nothing authorises on them, which today nothing does.

### Revocation, and the levers you have

Three, in ascending order of blast radius. The first two are the real ones.

**Remove the address from `allowed-emails.txt` — this signs that person out everywhere.** The gate
re-validates every request's email against the file and watches the file for changes, so their next
request is refused and their cookie is cleared, on every device, without touching anyone else's
session. **Restart the gate afterwards anyway:**

```sh
docker compose restart gate
```

Not because the removal needs it, but because a single-file bind mount can stop following a file an
editor replaces by rename — you would be left with the gate holding the old list and no sign that
anything went wrong. The restart is cheap and removes the doubt.

**Rotate `GATE_COOKIE_SECRET` — this signs out everyone, on every device, at once.** Every existing
cookie stops decrypting the moment the new secret is in place. There is no rotation list, no grace
period and no overlap window, so plan it for an evening. This is the lever for a leaked cookie or a
lost device you cannot be sure about.

```sh
# In .env: GATE_COOKIE_SECRET=$(openssl rand -base64 32 | tr -- '+/' '-_')
docker compose up -d gate
```

**The sidecar's sign-out URL is `PUBLIC_ORIGIN` + `/oauth2/sign_out`, and it is worth less than it
sounds.** It clears the gate's own cookie in that one browser and nothing else: the Google session
on the device is untouched, and sign-in goes straight to Google with no screen of our own in the
way, so the next visit bounces out to Google and back and is re-admitted without anyone typing
anything — silently, on a device signed into one Google account. It is useful for handing a phone to
someone for a minute. It is not revocation, and there is no sign-out control in the UI — that is
deliberately deferred and tracked as [issue #89](https://github.com/chethan123/portfolio/issues/89),
and these limits are the argument for it.

### One thing that leaves the house

The app makes outbound requests to exactly one destination: the price provider. What goes out is the
list of ticker symbols being priced, plus your public IP. Quantities, balances, account names, people
and filenames do not. There is no analytics or error-reporting SDK anywhere in the image. It is still
worth knowing that the symbol list reveals *what* is held, if not how much — an operator who objects
can price instruments manually or block egress and accept permanently stale prices. The app degrades
to the last known price, never to zeros.

### Can I put this on the internet?

The honest answer changed with the gate, but not all the way to yes. The threat this was built
against is a device on the household's own LAN — the guest phones and the IoT that share the wifi —
which is why the gate is enforced here rather than at your house proxy
([`ARCHITECTURE.md` §7.6](../ARCHITECTURE.md#76-security-posture),
[ADR-0005](adr/0005-auth-is-a-forward-auth-gate.md)). Everything a stranger on the internet would
meet is the same gate, and the sign-in behind it is Google's. What does not change is that every gap
above stays yours to compensate for, in front of the app.

If you are going to do it:

- [ ] TLS terminated in front, with a real certificate, and — if that is this stack's own Caddy —
      its `/data` [on a volume](#before-you-enable-tls-give-caddy-volumes) so it survives an
      upgrade.
- [ ] `PUBLIC_ORIGIN` and the registered redirect URI on the public hostname, not a LAN one.
- [ ] `GATE_COOKIE_SECRET` generated fresh and not reused from anything else.
- [ ] The allowlist re-read as what it now is: the only thing between the internet and the
      household's finances.
- [ ] Rate limiting in front of `/oauth2/*`, if you want the gate itself bounded rather than only
      Google. The stock `caddy:2-alpine` image has no rate-limiting module, so this means a custom
      Caddy build or a different proxy.
- [ ] Accept that you are now responsible for patching an internet-facing surface — including the
      pinned `gate` image, which nothing here updates for you — on whatever schedule the internet
      decides.

One addition to §7.6's error-disclosure row, because it is a deployment fact rather than a code fact:
in a production build React Router replaces a thrown error's message with a generic one before it
reaches the page, so a Postgres error does not leak from the shipped image. That is a mitigation for
the deployed case only. It is not true under `react-router dev`, which should never face anything.

**A VPN is not the answer here, and that is a decision rather than an oversight.** It was the old
recommendation, and [ADR-0005](adr/0005-auth-is-a-forward-auth-gate.md) rejects it for this threat
model: a VPN onto the LAN does nothing about an adversary already on that LAN. Run one if you want
remote access without publishing a port — but run it as well as the gate, never instead of it.

---

## Monitoring

[`ARCHITECTURE.md` §7.4](../ARCHITECTURE.md#74-observability) lists the signals and where each one
comes from. **That table is not repeated here.** This section is what the answers mean, and — more
usefully — what they do not.

### `/healthz`

No credentials, `Cache-Control: no-store`, `200` or `503`. **Point your monitor at this path and no
other**: it is the one Caddy exempts from the gate, so anything else you probe answers with a
redirect to Google and reads as an outage. The response body is an API contract
pinned by a test (`tests/routes/healthz.test.ts` asserts it key for key, precisely so a rename cannot
break your dashboard silently), which is why it is quoted here rather than described:

```json
200  {"status":"ok","database":true,"migrations":"current","pendingMigrations":[]}
503  {"status":"unhealthy","database":false,"migrations":"current","pendingMigrations":[]}
503  {"status":"unhealthy","database":true,"migrations":"pending","pendingMigrations":["…","…"]}
```

Alert on `status`. Read `database` before `migrations`, and read `migrations` only when `database` is
true: the migration ledger lives *in* the database, so when the database is unreachable there is
nothing to read and the field still says `current`. **`migrations` is meaningless whenever `database`
is false**, and the second line above is what that looks like.

### What `/healthz` does not catch

**A database that is ahead of the code.** The check compares migrations on disk against migrations
applied, in one direction only: what is on disk and unapplied. It never asks the reverse. So an older
image against a newer database — a rollback, or a spare machine on an old tag — finds every migration
it ships already applied and reports `200` `"ok"` `"current"`, while the code queries a schema it was
never written against. **Rolling an image back is completely invisible to health checking.** It
surfaces as 500s on individual pages, never as an unhealthy instance. If you take one thing from this
section, take this one, and see [Upgrading](#upgrading).

**Writes failing.** The probe is `select 1`. A full disk, a read-only tablespace, a revoked `insert`
grant — all of them leave that succeeding. The container is healthy, the dashboard is green, and
every upload returns a 500.

**The price provider, deliberately.** A third-party outage must not make Compose restart a perfectly
healthy app. Stale prices are a UI signal — the "as of" line — not a health signal.

**Whether anybody can actually get in.** `/healthz` is the one path Caddy does not put to the gate,
which is what lets a monitor probe it without a Google account — and means a gate that is down,
crash-looping on a bad secret, or holding an allowlist that no longer has anyone on it leaves this
endpoint answering `200` while the household is locked out. Nothing watches the gate's verdict for
you, and `gate`'s own container healthcheck only asks whether the sidecar is alive, not whether it
would admit anyone.

**Disk and memory.** Nothing here watches either. `caddy` does now carry a healthcheck — a
`/healthz` request through its own proxy path to `app`, so an ingress that is up but cannot reach the
app shows as unhealthy. It still says nothing about whether anybody can sign in.

One shape worth being able to recognise: if the ledger read itself throws, the body comes back
`"database":true` and `"migrations":"current"` with `"status":"unhealthy"` — the healthy body with a
single field changed. Another reason to alert on `status` rather than on the fields.

### An unhealthy container is not restarted

`restart: unless-stopped` fires when the process **exits**, not when the healthcheck fails. An app
that is wedged but still running stays unhealthy, stays in service, and stays that way indefinitely.
`docker compose restart app` is a manual step. Whatever you point at `/healthz` therefore has to be
able to *act*, not only to alert — or you have to be the one who acts.

### Logs

`docker compose logs -f app` is the entire pipeline; there is no metrics endpoint, no tracing and no
log shipping. `docker compose logs -f gate` is the second half of it, and the only place a refused
sign-in is recorded at all — the application no longer sees one. The stems below are for grepping
and may drift — the code owns the wording:

- **One line per HTTP request** from the server's built-in request logger: method, path, status,
  duration. Note that the container healthchecks — the app's own and Caddy's — hit `/healthz` every
  ten seconds, and on an idle instance that is essentially the whole log.
- **One line per refresh the poller actually runs** — stem `Price refresh`. Informational when
  everything priced, a warning when anything came back stale. A tick that runs no refresh writes no
  line at all — [below](#there-is-no-price-line-in-the-log-has-four-causes) lists which silences
  are ordinary.
- **A provider outage** at error level — stem `Price provider failed` — every selected instrument
  is marked stale and the last known prices are kept. Other refresh failures (the pool, the
  advisory lock, the transaction) log `Price refresh failed`; the same failure on a **Refresh now**
  press logs `Manual price refresh failed`, so grep for `price refresh failed` case-insensitively
  to catch both. A single symbol refused over its currency logs `Price refused`. None of them
  zeroes anything.
- **Database trouble on the page path** at error level — stems `Database health check failed` and
  `Migration status check failed` — the lines behind a `/healthz` 503.
- **Startup**, in order: the configuration check, one line per migration file (applied or skipped),
  then a `Migrations OK` line. A failure names the offending file and the Postgres error, and the
  server is never started — stem `Migrations`.

And in `gate`'s log, which is a different program with a different vocabulary:

- **The allowlist, at startup and again on every change it notices** — stem
  `authenticated emails file`. A line after you have edited the file is the gate confirming it
  re-read it; no line is the case [the restart exists for](#revocation-and-the-levers-you-have).
- **A session refused** — stem `Invalid authorization via session` — someone whose address is no
  longer on the list, arriving with a cookie that used to work. Their cookie is cleared as part of
  the refusal.
- **A refusal to start**, which crash-loops the container rather than serving anything: a
  `cookie_secret` of the wrong length is the one to expect, and it names the variable.

### "There is no price line in the log" has four causes

Only the last is a fault:

1. **Nobody has loaded a page since the container started.** The refresh timer is started from the
   first page render, because the app is served by the framework's own server and there is no server
   entry file to hook it to. A booted instance nobody has visited does zero refreshes, forever. The
   container healthcheck does not count — `/healthz` is a resource route and does not run the root
   loader.
2. **The market is closed.** A tick outside market hours returns without spending a request and
   without logging anything.
3. **Another refresh was already running or held the lock.** A tick that lands while one is still
   going, or while another process holds the advisory lock, is dropped silently — never queued.
4. **The poller failed to start.** That one *does* log, once, at error level.

A *successful* **Refresh now** press writes no `Price refresh` line: its outcome is reported on the
screen that pressed it. The attempt still lands a `price_poll` row, and a currency refusal along
the way still logs `Price refused`.

There is also a quiet period by design: the first tick is one full interval after the first page
view, with no immediate poll, so a freshly recreated container is silent for up to the refresh
cadence even with somebody looking at it. (The timer boots at the seeded 15 minutes and picks up a
different saved cadence on its first in-session tick.)

What to do about any of this is [`runbook.md`](runbook.md).

---

## Backups

**Backups are not a built-in feature and will not become one.** Self-hosters have their own, and a
half-built backup feature is worse than none — it is the one that looks like it is working.

There is exactly one thing to back up for **data**: the `db-data` named volume, through `pg_dump`.
The application container is stateless — it writes nothing to its own filesystem, and `compose.yaml`
mounts it `read_only: true` so that stays true. Uploaded CSVs are kept in Postgres rather than on
disk (DESIGN.md §5.2) precisely so that this stays a single target. The image is rebuildable and
needs no backup.

**Budget for the dump growing faster than it used to.** The price observation log is the largest
table on an instance that has been running a while ([Growth and limits](#growth-and-limits)), and it
is mostly archived JSON, which compresses well — so a custom-format dump is far smaller than the
table, and still on a path to gigabytes rather than megabytes. Nothing about the commands below
changes; what changes is how long they take and where you can afford to keep the output. If you keep
a dump per day for a year, size the destination against the table, not against the 11 MB the demo
household weighs.

Dump the database without stopping the instance:

```sh
docker compose exec -T db pg_dump -U portfolio -d portfolio --format=custom \
  > "portfolio-$(date +%F).dump"
```

`pg_dump` runs inside the `db` container, so no Postgres client is needed on the host and the tool
always matches the server version. The custom format is compressed and is what `pg_restore` reads;
for a plain-SQL dump you can read yourself, use `--format=plain` and restore it with `psql`.

**The `>` creates the file whether or not the dump worked.** The shell opens the redirect before
`pg_dump` runs, so a dump that dies halfway leaves a plausible-looking file of plausible size behind,
and an unattended script that ignores the exit status will collect those happily for months. Check
the status, and check the file is readable as an archive:

```sh
set -e
DUMP="portfolio-$(date +%F).dump"

docker compose exec -T db pg_dump -U portfolio -d portfolio --format=custom > "$DUMP"
docker compose exec -T db pg_restore --list < "$DUMP" | head
```

`pg_restore --list` reads the archive's table of contents without touching a database. If it prints
the objects, the file is a real archive; if it errors, you found out today rather than on the night
you needed it.

Automate it with whatever already runs on the host — cron, a systemd timer, your NAS. A daily dump
kept for a few weeks is proportionate for a household.

### The second thing to keep is `.env`, and the third is the allowlist

"Nothing outside Postgres" is true of *data* and false of *configuration*. `.env` and
`allowed-emails.txt` are both gitignored and dockerignored on purpose, so nothing else in the world
has a copy of them. What is in them that is not recoverable from anywhere:

- `GATE_CLIENT_ID` and `GATE_CLIENT_SECRET` — recoverable, but only from the Google Cloud console,
  and the secret may have to be regenerated there rather than read back.
- `GATE_COOKIE_SECRET` — regenerating it signs the household out. Recoverable, and annoying.
- `POSTGRES_PASSWORD` — the worst of them, because the `db-data` directory was initialised with it
  and still expects it. A restored dump does not help; see [`runbook.md`](runbook.md).
- `allowed-emails.txt` — losing it is a locked-out household until you retype it, because the stack
  will not start without the file at all.

Keep them wherever you keep passwords, which is not the directory you keep the dumps in.

> **A backup you have never restored is not a backup.** Rehearse it — the
> [drill below](#rehearse-it-without-an-outage) does that without taking the instance down.

---

## Restoring

Restore into an empty database rather than over a live one, so a partial restore cannot leave a
half-old, half-new schema behind:

```sh
DUMP=portfolio-2026-08-17.dump      # the file you are restoring

docker compose stop app

docker compose exec -T db dropdb   -U portfolio portfolio
docker compose exec -T db createdb -U portfolio -O portfolio portfolio
docker compose exec -T db pg_restore --exit-on-error --single-transaction \
  -U portfolio -d portfolio < "$DUMP"

docker compose start app
```

**`--exit-on-error --single-transaction` is what makes the sentence above true.** Left to itself
`pg_restore` continues past failures and reports a count at the end, which is precisely the
half-old, half-new schema this is trying to avoid. With both flags the restore is one transaction
that either lands whole or leaves the empty database alone.

Stopping `app` first is what keeps it from writing to a database that is being replaced underneath
it — and the price refresh loop inside it is the connection holder that would otherwise make
`dropdb` fail. `caddy` stays up throughout and answers `502` until `app` is back; that is the
restore working, not a second fault.

**`docker compose stop app` survives a reboot.** `stop` records that you wanted it stopped, and
`restart: unless-stopped` honours that across a daemon restart and across a host reboot. A restore
you walked away from half-finished stays half-finished — the site keeps answering 502 and nothing
brings the app back on its own. `docker compose start app` is the only thing that does.

On start `app` applies any migrations the dump predates, so a backup taken from an older version
restores into the current one without a manual step.

### Rehearse it without an outage

Restore into a *separate* database on the same server. Nothing stops, nobody sees a 502, and the
live database is never dropped:

```sh
DUMP=portfolio-2026-08-17.dump

docker compose exec -T db createdb -U portfolio -O portfolio portfolio_drill
docker compose exec -T db pg_restore --exit-on-error --single-transaction \
  -U portfolio -d portfolio_drill < "$DUMP"

docker compose exec -T db psql -U portfolio -d portfolio_drill \
  -c "select count(*) from holding"

docker compose exec -T db dropdb -U portfolio portfolio_drill
```

The count is the point. A truncated archive that still restores cleanly into an *empty* schema is the
failure this catches, and a restore that reports success while producing no rows will not be noticed
any other way. Compare it against the same query on `portfolio` and be suspicious of a large gap.

`portfolio_drill` is never migrated and the app is never pointed at it; it exists for the length of
the drill and is dropped at the end.

### Rebuilding a machine from nothing

Install Docker, clone this repository, restore your `.env` **and your `allowed-emails.txt`** — with
either one missing nothing starts at all — then bring up the database **on its own** before anything
else:

```sh
docker compose up -d db
# then the restore above, minus the `docker compose stop app` line
docker compose up -d
```

A plain `docker compose up -d` here would start `app`, which would create and migrate an empty schema
that you are about to drop, and would hold a connection to the database while you try to drop it.
Bringing up `db` alone avoids both.

---

## Upgrading

```sh
docker compose exec -T db pg_dump -U portfolio -d portfolio --format=custom \
  > "portfolio-pre-upgrade-$(date +%F).dump"
docker compose images app    # write the tag down: it is half of your way back
docker compose up -d
curl -sf http://localhost/healthz
```

There is no `git pull` and no build. The `app` service is set `pull_policy: always`, so
`docker compose up -d` fetches whatever the pinned tag currently points at and recreates the
container; with the default floating `APP_VERSION=1` that is the newest `v1.x.y` release. A
checkout of this repository is not needed to run or upgrade an instance — only `compose.yaml`,
`Caddyfile`, your `.env` and your `allowed-emails.txt`.

**This does not upgrade the gate.** `gate` is pinned to an exact release with no variable in front
of it, so `docker compose up -d` recreates the container on the same image forever. Moving it is
editing the tag in `compose.yaml`, and it is worth doing deliberately when oauth2-proxy publishes a
security release — nothing here will tell you one exists.

**Upgrading across a major means changing `APP_VERSION`.** The floating tag deliberately does not
cross `1` → `2`, because a major is where a breaking change would be. Read the release notes, set
`APP_VERSION=2` in `.env`, then run the same procedure above.

The entrypoint validates the configuration, applies any new migrations to completion, and only then
starts serving — so a request is never served against a half-migrated schema. Migrations are
idempotent, so a restart is always safe, and `GET /healthz` returns a non-200 if the image ever
carries a migration the database has not recorded.

### There is no rollback

Migrations are forward-only, and comprehensively so: there are no `down` files, there is no rollback
command, and the ledger records filenames only — no checksums, no content hashes. Two consequences
that bite in opposite directions.

**Editing a migration that has already been applied does nothing, forever.** The ledger matches on
the filename, so the edited file is still recorded as applied and is silently skipped on every future
start. Ship a new file instead.

**An older image against a newer database reports perfect health.** Nothing compares applied
migrations against the ones on disk in that direction, so every check passes while the code queries a
schema it has never seen ([Monitoring](#monitoring)). Setting `APP_VERSION` back to the previous
version is therefore not a rollback — it is an instance that has stopped being able to tell you it
is wrong. Pinning a tag is easy now, which makes this *easier* to do by accident than it used to be,
not harder.

**The only true rollback is the old image *plus* the backup taken before the upgrade.** That is why
the dump and the tag you wrote down are the first two lines above, and why "take a backup before
upgrading" is not a formality here. Pin the old version with `APP_VERSION` in `.env` and restore the
dump; either one alone leaves you worse off than before.

### Upgrading Postgres across a major version

`compose.yaml` pins a Postgres major version by tag. Raising it does **not** migrate the data
directory: the new server finds a directory written by the previous major version and refuses to
start, over and over, with `db-data` left exactly as it was. Nothing is damaged, and nothing works.

The dump-and-restore procedure above *is* the upgrade path:

1. **Dump on the old version, before you change the tag.** An archive written by a newer `pg_dump`
   cannot be loaded into an older server, so doing this in the wrong order also removes your way
   back to the version that still runs.
2. `docker compose down` (no `-v`), then remove the volume deliberately:
   `docker volume rm portfolio_db-data`.
3. Change the tag and `docker compose up -d db`, letting it initialise an empty directory.
4. Restore into it, then `docker compose up -d`.

Step 3 is also the one moment `POSTGRES_PASSWORD` is read again, because the data directory is empty
again — so it is the easy time to change it, and the time to make sure `DATABASE_URL` agrees.

---

## Growth and limits

Measured against the demo household in [`scripts/seed-demo.ts`](../scripts/seed-demo.ts) — two
people, six accounts, sixteen instruments, three years of statements — the whole database is about
11 MB, of which the daily price history is about 2 MB. That is the largest dataset this has actually
been run against, and it seeds a single trading session's observations rather than years of them, so
it does not measure the term below that actually grows.

Nothing is ever pruned: no code deletes a price, anywhere. Two tables grow, at very different rates.

**The daily spine grows slowly and is not worth thinking about.** `price_daily` gains one row per
priced instrument per trading day, so roughly 250 rows per instrument per year. At the design target
of about a hundred instruments that is on the order of 25,000 rows a year, and low single-digit
megabytes.

**The observation log is the one that costs real disk, and it does so by decision.**
[ADR-0006](adr/0006-intraday-quotes-are-an-observation-log.md) stopped the refresh discarding the
prices it fetches between two closes: every distinct one is now kept forever in `price_observation`,
with the provider's raw entry archived beside it. The arithmetic, at the design target of about a
hundred feed instruments and the seeded fifteen-minute cadence:

| Cadence | Refreshes a session | Rows a year | Roughly |
|---|---|---|---|
| 15 minutes (the default) | ~26 | ~650,000 | half a gigabyte a year |
| 5 minutes | ~78 | ~2,000,000 | one and a half gigabytes a year |
| 1 minute | ~390 | ~10,000,000 | seven or eight gigabytes a year |

Two things make those upper bounds rather than forecasts. A price that has not moved writes nothing —
the log is keyed on the instant the provider stamped, so a mutual fund, which strikes one NAV a day,
contributes one row a day whatever the cadence says. And the payload is the bulk of each row; it is
stored out of line, so a query that reads only prices does not pay for it. A sibling `price_poll`
table adds one row per refresh attempt — about twenty-six a day, which is nothing.

**So: there is still deliberately no retention policy, but it is now a priced choice rather than a
free one.** The premise this section used to rest on — that a household instance grows by a few
megabytes a year — is superseded; the conclusion survives, because the owner would rather spend the
disk than throw away data whose future use is unknown, and because any pruning scheme would cost
more attention than the disk it saved. The dial that sets the price is the refresh cadence at
Settings → Prices, and that screen states the figure where the choice is made. **Check the number
against your own instance rather than against this table** — it is the design target, not a
measurement:

```sh
docker compose exec -T db psql -U portfolio -d portfolio -c \
  "select pg_size_pretty(pg_total_relation_size('price_observation'))"
```

Two more terms are unbounded, and only one of them is data.

**Retained statement originals.** Every upload keeps its complete CSV in the database, forever, on
purpose — it is what makes an old import auditable. A brokerage CSV is tens of kilobytes and the
design target is a handful of uploads a quarter. Abandoned upload drafts are swept once they are a
day old, but only when the *next* upload starts: there is no scheduler, so an instance nobody uploads
to keeps its last abandoned draft indefinitely.

**Container logs, which is the one likely to matter first.** `compose.yaml` has no `logging:` block,
so every service uses Docker's default `json-file` driver with no size limit and no rotation. An idle
instance still writes a request line every ten seconds from its own healthcheck, and a second from
Caddy's. Cap it per service:

```yaml
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
```

or set the same options once as the daemon default in `/etc/docker/daemon.json`, which covers
everything on the host rather than only this.

**No resource limits are set on any service** — no memory limit, no CPU limit, no `pids_limit`. On a
machine that runs only this, that is the right default. On a shared host it means one runaway query
can take the box; `deploy.resources.limits` is where you would add them.

**The design target is a target, not a measurement.**
[`ARCHITECTURE.md` §10](../ARCHITECTURE.md#10-performance-and-scale-envelope) states it — one
household, two to four people, a dozen accounts, of the order of a hundred instruments, three or four
statement uploads a quarter — and says plainly that there is no benchmark behind it. If your instance
is meaningfully larger than that, §10 is also the list of which choices break first, in what order.
