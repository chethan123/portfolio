# Setting up Google sign-in

Configure Google sign-in and the household email allowlist before the first `docker compose up`.
The bundled deployment requires the gate credentials and allowlist file.

The `gate` service (oauth2-proxy) checks Google identity and the allowlist. Caddy enforces that
check before forwarding app requests, except `/healthz`
([ADR-0005](adr/0005-auth-is-a-forward-auth-gate.md)). The app also has a separate
[passkey lock](guide/passkeys.md).

Running the instance day to day — the proxy in front, backups, upgrades, the security decisions that
are yours — is [`operating.md`](operating.md). When something is broken and you want a procedure,
that is [`runbook.md`](runbook.md).

## Before you start

**Decide the public origin first.** `PUBLIC_ORIGIN` is the `https://` origin your house-wide proxy
serves this instance at, with no trailing slash — `https://portfolio.example.com`. Everything below
is built from it, and Google compares the redirect URI you register against it character for
character, so changing your mind afterwards means editing the console and `.env` together.

Google redirects the *browser*, never its own servers, so that origin only has to resolve for the
family's devices: a hostname on your LAN or VPN, behind your own proxy, is fine. It does have to be
`https://` — the gate's session cookie is set `Secure`, and TLS is the outer proxy's job
([`operating.md`](operating.md#reverse-proxy-and-tls)). The one server-to-server call is outbound
from `gate` to Google.

You also need:

- **A Google account of your own** to hold the Cloud project. It does not have to be one that will
  use the instance.
- **The Google address each family member will sign in with.** Whatever address the account signs in
  as is the string that has to appear on the allowlist.
- **A terminal on the Docker host**, in the directory holding `compose.yaml` and `.env`.

You do not need a billing account. Nothing below enables a billable API — see the end of step 1.

## Step 1 — a Google Cloud project

Sign in at [console.cloud.google.com](https://console.cloud.google.com) and create a project from
the project picker in the header, or select one you already own.

Prefer a fresh project over an existing one. The consent screen is a property of the project, and its
app name is what your family reads on Google's own sign-in screen; putting this client inside a
project you made for something else means the household is asked to sign in to that something else.
The project's own name is internal and nobody sees it.

**There is no API to enable for this.** Enabling one is for an application that goes on to *call* a
Google API after sign-in; the gate calls none. It exchanges the authorization code, reads the
address out of the result, and stops — Google's OpenID Connect endpoints answer that without
anything being turned on in the API library. If a walkthrough somewhere tells you to enable the
People API, it is written for an application that wants profile details this one never asks for.

## Step 2 — the consent screen, and publishing it

In the console's OAuth configuration (currently under **APIs & Services**, on the pages Google groups
as its auth platform — the labels have moved more than once, the decisions have not), set up the
screen a person sees when they sign in. What has to be right:

- **Audience: External.** Internal is offered only inside a Google Workspace organisation and admits
  only that organisation's accounts. A household on ordinary Google accounts has no such
  organisation, so External is the only setting that can work.
- **App name.** This is the name on the sign-in screen. Something the family will recognise as this
  instance.
- **A contact address.** Google needs somewhere to write about the project. Yours.

This guide uses **Production** for the deployed client. The local email allowlist still controls
who enters the app; publishing does not make the instance publicly accessible or approve its brand.

The pinned oauth2-proxy Google provider requests `profile email`. These basic sign-in scopes do
not require sensitive-scope verification; Google’s app-branding requirements are separate.
[Provider scopes](https://github.com/oauth2-proxy/oauth2-proxy/blob/v7.15.4/providers/google.go).

### Why not leave it in Testing

Testing is also possible. Google exempts basic profile, email, and OpenID sign-in from Testing’s
test-user restriction and seven-day authorization expiry. Publishing is not needed to avoid those
limits for this client. [Google’s audience rules](https://support.google.com/cloud/answer/15549945?hl=en).

## Step 3 — the OAuth client

Still in the console: **Credentials → Create credentials → OAuth client ID**, of type **Web
application**.

**Add one authorized redirect URI**: your `PUBLIC_ORIGIN` with `/oauth2/callback` on the end.

```
https://portfolio.example.com/oauth2/callback
```

Google compares this by exact string against the URI the gate sends, and refuses the sign-in on any
difference — scheme, host, port, case, and a trailing slash all count. The gate builds what it sends
as `PUBLIC_ORIGIN` + `/oauth2/callback` and nothing else
([`compose.yaml`](../compose.yaml)), so the two agree exactly when the origin you typed in `.env` and
the origin you typed here are the same characters. That path belongs to the sidecar — the
[`Caddyfile`](../Caddyfile) hands `/oauth2/*` straight to it rather than putting those paths through
the gate's own check — so moving it means editing both files.

Leave the authorized JavaScript origins empty. This is a server-side redirect flow; nothing in the
browser here talks to Google directly.

**Copy the client ID and the client secret into `.env`**, as `GATE_CLIENT_ID` and
`GATE_CLIENT_SECRET`. Copy the secret before you leave that panel: Google shows a client secret in
full exactly once, at creation, and masks it in the console afterwards — a client made today gives
you the last few characters as an identifying aid and nothing more. A secret you cannot read again is
replaced rather than recovered ([Day two](#day-two)).

## Step 4 — the rest of the gate's settings

`cp .env.example .env` if you have not already, and fill in the gate section. Every variable in it is
required and none has a default: [`compose.yaml`](../compose.yaml) interpolates each with Compose's
`${VAR:?}` form, so `docker compose up` stops before any container exists and names the first one
that is unset or empty. Half-configured is not a state Compose lets by — with one blind spot, next.

Beyond the client ID and secret from step 3:

- **`PUBLIC_ORIGIN`** — the origin from [Before you start](#before-you-start), no trailing slash.
  This is the one gate setting Compose cannot catch: `.env.example` ships it pre-filled with an
  example origin, so a copied file passes the `${VAR:?}` check unedited and the mistake surfaces
  later, as Google's `redirect_uri_mismatch` page at sign-in. Edit it.
- **`GATE_COOKIE_SECRET`** — the key the gate encrypts its session cookie with. It must decode to
  exactly 16, 24 or 32 bytes: the sidecar builds an AES cipher from it and refuses to start
  otherwise, naming `cookie_secret` in its log. Generate one with the command
  [`.env.example`](../.env.example) gives, which is the authority for it:

  ```sh
  openssl rand -base64 32 | tr -- '+/' '-_'
  ```

  It is not a password anyone types and there is no reason to choose it yourself. Keep it: it is one
  of the things a backup has to carry ([`operating.md`](operating.md#backups)), and rotating it signs
  everyone out everywhere at once.

> The shapes of these settings are also stated in [`.env.example`](../.env.example), beside the
> blanks they fill. That duplication is deliberate: this file is read once, before an instance
> exists, and that one is read with `.env` open. `.env.example` sits next to the code and is the one
> to believe if they ever disagree.

## Step 5 — the allowlist

Who may enter is not a variable. It is `allowed-emails.txt`, beside `compose.yaml`, one Google
address per line, bind-mounted read-only into the gate and re-checked on every single request rather
than only at sign-in. [`allowed-emails.example.txt`](../allowed-emails.example.txt) is the committed
copy showing the format:

```sh
cp allowed-emails.example.txt allowed-emails.txt
$EDITOR allowed-emails.txt
```

Put the household's real addresses in it, one per line; blank lines and lines starting with `#` are
ignored, and an address is matched whole and case-insensitively, so a typo admits nobody. The real
file is gitignored — the example is committed under a different name precisely so the real one never
follows it into a repository.

**There is deliberately no domain rule, and no option for one.** The narrowest domain that would
admit this household also admits every other account on that domain — every Gmail account on earth,
in the ordinary case. The file is the only authorization this instance has, and everyone on it sees
and can do everything.

It has to exist before the first `up`: the mount is declared so that a missing file stops
`docker compose up` with a message, rather than Docker silently creating a directory in its place.

## Step 6 — start it, and prove it works

Complete the [installation prerequisites](operating.md#installing), including the database and dump
directories, ownership, and non-Google `.env` settings, before starting.

```sh
docker compose up -d
```

Then walk [`operating.md`'s Verify it actually worked](operating.md#verify-it-actually-worked),
which has the commands: every service running and healthy, `/healthz` answering its pinned body, and
the front door answering an unauthenticated request with a redirect to `/oauth2/sign_in` rather than
a page. A `200` at `/` means the gate is not in the path.

Those prove the stack. The last leg is Google, and only a browser can walk it:

1. **Open `PUBLIC_ORIGIN` in a browser that is not signed in to this instance.** You should land on
   Google's own account chooser. If you get an error from Google here, it is the client or the
   redirect URI — see [When it does not work](#when-it-does-not-work).
2. **Choose an account that is on the allowlist.** A new instance opens Overview. If a passkey has
   already been enrolled, a new browser first shows the [unlock screen](guide/passkeys.md).
3. **Prove the refusal, once, in a private window.** Sign in with a Google account that is *not* in
   `allowed-emails.txt` — your own work address will do. Google will succeed, and then the gate
   refuses with a `403` and its own error page. You never reach the application, and nothing about
   the household is on that page.

That last check is worth the two minutes. It is the difference between believing the allowlist is
enforced and having watched it refuse someone.

## What your family sees the first time

The gate sends them to Google without showing its own sign-in page. They need an allowlisted
Google address and the instance link. If the household has enrolled a passkey, they also need access
to an enrolled passkey to unlock the app. See [Passkeys](guide/passkeys.md).

The gate keeps sign-in in an encrypted browser cookie with a seven-day lifetime. Later Google
sign-ins may reuse the device's existing Google session. The app's passkey lock has its own idle
timeout, separate from that cookie.

## Day two

**Adding a family member.** Append their address to `allowed-emails.txt`, restart the gate, and send
them the link.

```sh
$EDITOR allowed-emails.txt
docker compose restart gate
```

The restart is not what makes the address work — the gate watches the file — but a single-file bind
mount can stop following a file an editor replaces by rename, and the restart removes the doubt.

**Removing one.** Delete their line and restart the gate the same way. That is genuine revocation:
the address is re-checked on every request, so their next one is refused on every device they hold.
[`operating.md`](operating.md#revocation-and-the-levers-you-have) has the teeth — what that lever
does, what rotating `GATE_COOKIE_SECRET` does instead, and why the sidecar's sign-out URL is worth
less than it sounds.

**Rotating the client secret.** Add a new secret to the existing OAuth client in the console, put it
in `GATE_CLIENT_SECRET`, and bring the gate back up:

```sh
docker compose up -d gate
```

Then delete the old secret in the console, and not before — until the new one is running, the old one
is the only thing signing anybody in. Rotating it does not clear anyone's session: the gate's
sessions are its own encrypted cookies, and the lever that clears those is `GATE_COOKIE_SECRET`.

**Changing `PUBLIC_ORIGIN`.** The registered redirect URI has to change in the same sitting, or
nobody can sign in. Edit both, update your HTTPS proxy, then `docker compose up -d app gate`.
The app also uses this origin for passkey verification. If the hostname changes, existing passkeys
will not work: follow the [passkey reset procedure](runbook.md#every-browser-is-locked-and-no-passkey-can-be-reached)
and enrol new ones at the new hostname.

## When it does not work

Keyed by what you actually see.

**Google says the redirect URI does not match** (`redirect_uri_mismatch`). The URI the gate sent is
not one of the client's authorized redirect URIs, compared character for character. Check
`PUBLIC_ORIGIN` + `/oauth2/callback` against the list in the console for a `http`/`https` slip, a
missing or extra trailing slash, a port, or a different hostname than the one the browser is at. Fix
whichever is wrong. If `PUBLIC_ORIGIN` changes, follow [Day two](#day-two), including the app restart
and any passkey reset.

**Google refuses the client itself** (`invalid_client`, or a page saying the client is unknown).
`GATE_CLIENT_ID` or `GATE_CLIENT_SECRET` is wrong — a partial copy, stray whitespace, credentials
from a different project, or a secret that was replaced in the console after `.env` was written.
Re-copy both from the client's page and `docker compose up -d gate`.

**Google refuses access before the app opens.** Read Google’s error and check the client’s actual
requested scopes, audience, and any Workspace administrator restrictions. Testing mode alone is
not a sufficient diagnosis for this client’s basic sign-in scopes; see step 2.

**Google succeeds, and you come back to a 403 from the gate.** The address that signed in is not on
`allowed-emails.txt`. This is the allowlist working. If it should have been admitted, read the file
*inside the container* — a truncated file, or one the mount stopped following, looks exactly like a
missing line: [`runbook.md`, Nobody can sign in](runbook.md#nobody-can-sign-in).

**`docker compose up` refuses to start anything, naming a variable or `./allowed-emails.txt`.** That
is the fail-closed interpolation: something in the gate section of `.env` is unset or empty, or the
allowlist file does not exist. `docker compose config --quiet` reproduces it without starting
anything — [`runbook.md`](runbook.md#docker-compose-up-refuses-to-start-anything).

**The `gate` container restarts in a loop**, with `cookie_secret` in its log.
`GATE_COOKIE_SECRET` does not decode to 16, 24 or 32 bytes. Generate a new one with the command in
step 4.

**Everything answers `502` except `/healthz`.** The gate is down, and Caddy will not forward a
request it cannot get a verdict on. That is the fail-closed shape working as intended; its log says
why ([`runbook.md`](runbook.md#the-site-does-not-answer-at-all)).
