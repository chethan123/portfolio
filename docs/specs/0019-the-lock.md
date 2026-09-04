# 0019 — The lock: a passkey between an admitted browser and the household's figures

> Triage label to apply when this is filed: `ready-for-agent`
>
> Read [ADR-0012](../adr/0012-a-browser-past-the-gate-is-shown-nothing.md) first. It decides the
> shape, states the three platform limits every claim here sits inside, and records what it costs.
> This spec builds what that ADR argues for and does not restate the argument.

**Status:** proposed · **Slice directory:** [`lock/`](lock/) · **ADR:** 0012 ·
**Vocabulary:** `Locked` and `Passkey` are already in [`CONTEXT.md`](../../CONTEXT.md)

## Problem Statement

The gate admits a person and then stops thinking about them for a week. Its cookie is a hard seven
days, it does not roll, and the sign-out URL clears only the gate's own cookie so the next visit
re-admits silently — DESIGN.md §14 records that as an accepted limitation and an issue tracks a
real control. Meanwhile the app is installed on family phones as a home-screen app that opens
straight onto net worth.

Put those together and an unlocked phone in somebody else's hands — borrowed, picked up off a
table, taken — is unchallenged access to every balance, every holding and every account for up to a
week. The household has no lever to pull that is narrower than the operator editing the allowlist.

Masking does not answer this. It replaces figures with dots on a screen you are reading, and
revealing them costs one tap; a person holding the device taps. ADR-0007 refused to cache anything
on phones for precisely this adversary, and left the live session untouched.

## Solution

The app refuses, rather than hides. What it refuses, what lifts the refusal, and what puts it back.

### What locked means

A browser holding no valid grant is shown the unlock screen, and no loader runs. The figures are
not dotted, not hidden by CSS, and not present in the serialised loader data — they are never
fetched. Enforcement is a `middleware` export from `app/root.tsx` — the one place in this framework a
rule runs ahead of every route — so the refusal is a single site a test can pin rather than a
discipline spread over every loader. It is deliberately not the shape of the chart-range middleware,
the only other one here, which is registered on two routes and awaits `next()` to decorate the
response; this one refuses before `next()` is called.

Two router paths sit outside it: the unlock route itself, and the health endpoint the gate already
exempts. The service worker, the manifest and the icons need no exemption — they are static files
under `public/` that never reach the router, and ADR-0007 already made the offline page
self-contained, so there is nothing for it to fetch.

### Unlocking

The unlock screen offers one action. It calls `navigator.credentials.get()` with a server-issued
single-use challenge, the household's enrolled credential ids in `allowCredentials`, and
`userVerification: "required"`. The browser owns everything the family member sees from that point
— the provider chooser, the operating system's own prompt, and, where the local device holds no
matching passkey, the cross-device flow it draws itself. This app renders no QR code and no
provider list.

The server verifies the assertion in full — challenge, origin, relying-party id hash, the user
presence and user verification flags, the signature over the authenticator data, and the signature
counter under the condition the specification actually states, since platform authenticators report
a constant zero. Only then does it mint a grant.

### The grant

A row, addressed by an opaque id in a cookie. The row is the authority; the cookie carries no
claim, so a forged or copied cookie value names nothing. It carries a rolling idle expiry: each
request that passes the middleware extends it, and a browser left alone past the window is locked
again with no client involvement.

The row is scaffolding, not history — the same category `upload_draft` occupies, and it is swept on
the same principle. It records which passkey unlocked it and when, which is what lets removing a
passkey end its grants with it.

### Enrolling a passkey

Enrolling a passkey, and removing one, each require a **fresh assertion** — not merely a live grant.
This is the difference between a lock and a lock that can be picked from inside: the adversary this
slice names is somebody holding a phone that is already unlocked, and a grant is exactly what they
inherit. If a grant were enough, a borrowed phone would convert a few minutes of access into a
passkey of the adversary's own and, worse, into deleting the household's. So both of those two
actions re-run the ceremony immediately before they are allowed, which is also what a bank app does
when you add a device.

Everything else an unlocked browser does needs only the grant. It is those two writes — the ones that
change who may unlock in future — that are held to the higher bar.

The first passkey needs no authorisation at all, because at that moment there is nothing to
authorise: with no passkey enrolled the instance is not locked, and anyone the gate admitted already
sees every figure. So the rule is one sentence — a live grant, or no passkey exists yet — and there
is no token, no script and no second path. Recovery when every enrolled passkey is unreachable is the
operator deleting them, which opens the instance; ADR-0005 already names the operator's shell as this
instance's break-glass and this slice adds nothing to it.

### Turning it on and off

There is no switch. The instance is locked whenever the household holds at least one passkey and
open when it holds none. Enrolling the first passkey therefore locks every other browser in the
household at once, and the enrolment screen says so before it is done, in the voice the
unprotected-instance banner already uses. Removing the last passkey turns the lock off.

### What re-locks it

The idle expiry on the grant is the guarantee, and it is the only thing enforced server-side:
**fifteen minutes**, extended by the requests that use it. On top of it, a browser hidden longer than
a **sixty second** grace navigates to the unlock screen when it comes back, which is a courtesy — a
hidden page cannot be trusted to run timers, and `visibilitychange` cannot tell a locked screen from
an app switch. Both numbers are stated here and named once in code; this repository names its
constants rather than leaving them to be discovered.

Separately, an explicit control locks the current browser immediately. For the threat this slice
exists to answer — handing somebody your phone — that control is the most direct answer in the
slice, and it sits in the chrome beside the masking toggle.

### Masking is unchanged

Both controls ship, and they answer different questions. `CONTEXT.md` already carries the
distinction; ADR-0002 needs its now-false sentence amended in the bracketed form it already uses.

## User Stories

1. As a family member whose phone is picked up by somebody else, I want the app to show nothing
   until it is unlocked, so that being past the gate is not the same as being able to read the
   figures.
2. As a family member about to hand my unlocked phone to somebody, I want one control that locks
   the app immediately, so that I do not have to remember to close it.
3. As a family member returning to the app after a while away, I want it to ask me to unlock, so
   that a phone left on a desk does not stay open.
4. As a family member switching apps for a few seconds, I want to come back without being asked
   again, so that the lock is not so tiresome that somebody turns it off.
5. As a family member unlocking, I want my device's own prompt — face, finger or passcode, whichever
   it offers — so that there is no new secret to remember.
6. As a family member on a new device, I want to unlock by approving it from a device I have already
   unlocked, so that adding a device does not need the operator.
7. As the household operator setting this up for the first time, I want to enrol the first passkey
   from the interface like any other, so that turning the lock on does not need a second mechanism
   that exists only once.
8. As the household operator, I want the enrolment screen to tell me that enrolling the first
   passkey locks everyone else's browser, so that I find out before it happens rather than from a
   family member.
9. As a family member, I want Settings to list the household's passkeys and say which are synced and
   which are bound to one device, so that I can see how strong this actually is.
10. As a family member reading the portfolio with somebody beside me, I want masking to keep working
    exactly as it does now, so that the lock has not replaced the thing I actually use on a bus.
11. As the household operator, I want removing an address from the allowlist to still end that
    person's access immediately, so that the lock has not weakened the gate.
12. As a family member whose gate session expires while I am using the app, I want the sign-in bounce
    to leave me unlocked as I was, so that the two clocks do not compound into a double prompt.
13. As the household operator, I want a browser that cannot run a passkey check to be locked rather
    than let through, so that the lock is not something a client can decline.
14. As the household operator, I want the instance to be open again if every passkey is removed, so
    that a lock that goes wrong is recoverable and the recovery is the one I already have.
15. As a family member whose phone is gone for good, I want to remove its passkey from a device I can
    still unlock, so that losing a device does not mean turning the lock off for everybody.

## Implementation Decisions

**The dependency.** `@simplewebauthn/server` for registration and assertion verification and
`@simplewebauthn/browser` for the two ceremonies. Hand-rolling CBOR parsing and signature
verification beside financial data is not a saving. The browser package must never be imported into
module scope that runs during server rendering; the server package belongs behind the `.server.ts`
boundary like every other domain module.

**One domain module owns the rules.** Ceremony options, verification, grant minting, expiry and
enrolment authorisation live in one `.server.ts` module. Routes translate and render; the middleware
asks one question and acts on the answer. No route states a lock rule and no route imports the
WebAuthn packages directly.

**The relying-party id comes from `PUBLIC_ORIGIN`, which the app cannot read today.** The variable
exists, but only as a Compose-level value the gate consumes for its redirect: `server/config.ts` has
no such key and discards anything outside its schema, and DESIGN.md §10.1 states that split as a
rule. So this slice adds the key to the config schema, the line to the `app` service's environment,
the row to §10.1's table, and an amendment to `.env.example`'s existing entry, which sits today under
the gate's heading saying the gate builds its redirect from it — one variable read by two services,
named as the deliberate duplication it is rather than added twice. It is validated at startup by the
existing `refine` shape, as a domain and never an IP address, because the failure otherwise is every
family member enrolling a credential that cannot be used.

**That validation, not the middleware, is this slice's one breaking change — and it is not only a
deploy.** `vitest.config.ts` sets exactly one variable on purpose, and `tests/config.test.ts` asserts
that a minimal configuration is short; a second required key turns that test and every route test
reaching `getConfig()` red inside the same pull request. So the ticket that adds the key also updates
the test harness, the dev path and the Compose line, and lands them together.
**Registration asks for a platform authenticator and user verification, and does not ask for
attestation.** This is a single-tenant household instance with no policy about which authenticator
models are acceptable and no metadata service to check one against.

**Backup eligibility is recorded at enrolment and not re-read.** One flag, not two: whether a passkey
is *eligible* for backup is what "synced" means to a reader and is fixed when it is created, while
the separate current-state flag would be a write on every unlock to keep one adjective fresh. The
AAGUID is not stored at all — nothing in this slice reads it.

**Money and dates keep their existing rules.** Nothing in this slice computes an amount. Timestamps
cross the driver boundary as strings like every other date.

## Testing

Against real Postgres, through the existing helpers, in the house style — `withDatabase`, the
fixture builders, the route helpers, full-sentence `it` names.

- The middleware is the boundary, so it gets the boundary's tests: with no passkey enrolled every
  screen renders; with one enrolled and no grant every screen is refused; with a grant every screen
  renders; with an expired grant every screen is refused again. The refusal is asserted on the
  rendered markup containing no figure, not merely on a redirect.
- Assertion verification is tested for what it refuses: a replayed challenge, one that was never
  issued, one that has expired, a wrong origin, a wrong relying-party id, and a counter regression
  where the specification's condition applies. A fixture assertion is generated once and stored, and
  each refusal is provoked by varying the *server's* expectation rather than the fixture — flipping a
  flag inside the signed authenticator data would break the signature and the test would pass for the
  wrong reason. That user verification is required is asserted on the options and on the call, not by
  forging an assertion.
- Enrolment authorisation is tested for the hole it exists to close: an admitted request with no
  grant may not enrol, and the refusal names why.
- The grant's cookie attributes are pinned the way masking's are pinned — the same kind of test, not
  the same values. `SameSite=Lax` with a test saying why `Strict` is wrong, plus `Secure`, `HttpOnly`
  and the `__Host-` prefix, which masking deliberately omits for reasons that do not transfer to a
  credential.
- Turning the lock on and off is tested through the passkey count, not through a setting.
- Masking's existing tests must still pass untouched; a masked *and* locked instance is not a new
  rendering path, because locked renders no screen to mask.

## Out of Scope

- **Any change to the gate** — its cookie lifetime, its refresh behaviour, or the sign-out control.
  Shortening that window is worth doing and is not this slice.
- **A household dial for the idle window or the grace.** Both are constants named in one place until
  somebody is actually annoyed by them.
- **A recovery code, a PIN, or any second factor that is not a passkey.**
- **Per-person locks, per-person visibility, or anything that makes the authenticated email decide
  what may be seen.** ADR-0008 refuses this and nothing here reopens it.
- **Suppressing the operating system's app-switcher preview.** A web app cannot.
- **Rate limiting.** The instance has none anywhere, and a single-use challenge plus the platform's
  own throttling is the posture this slice inherits rather than changes.

## Further Notes

**Three things need checking on real devices rather than arguing about.** Whether the ceremony
works inside an installed iOS home-screen web app, which no primary Apple source confirms or denies;
whether a third-party password manager prompts or waves through after the app has been backgrounded,
which decides how strong this actually is on the devices the household uses; and whether the
cross-device flow behaves the same in standalone display mode as in a tab.

**The gate's return-path bug is in this slice's way, and one ticket works around it.** Caddy builds
its sign-in redirect by interpolating the request URI without percent-encoding it, so a target
carrying more than one query parameter truncates at the first ampersand — already tracked as an
issue. The unlock screen's return path is exactly such a target once an owner filter and a chart
range are in the address, so it is carried as one encoded parameter rather than as the query it came
from.

**The offline page and the lock do not compose.** The service worker answers a rejected navigation
with guidance; a locked browser that is also offline cannot unlock, because unlocking is a round
trip. That is correct and worth saying out loud rather than discovering.

## Tickets

- [`lock/01-the-passkey-and-the-grant.md`](lock/01-the-passkey-and-the-grant.md) — the schema, the
  generated types, and the sweep.
- [`lock/02-the-two-ceremonies.md`](lock/02-the-two-ceremonies.md) — the domain module: options,
  verification, grants, and what each refuses.
- [`lock/03-the-middleware-that-refuses.md`](lock/03-the-middleware-that-refuses.md) — locked by
  default, and the short list of what sits outside.
- [`lock/04-the-unlock-screen.md`](lock/04-the-unlock-screen.md) — one route, one action, and an
  honest message where the ceremony cannot run.
- [`lock/05-enrolling-and-listing-passkeys.md`](lock/05-enrolling-and-listing-passkeys.md) — the
  Settings screen, the synced-or-not column, removal, and the warning before the first one.
- [`lock/06-lock-now-and-coming-back.md`](lock/06-lock-now-and-coming-back.md) — the chrome control
  and the re-entry grace.
- [`lock/07-documents-and-the-limit.md`](lock/07-documents-and-the-limit.md) — every document
  brought level, ADR-0002 amended, the limitation stated in DESIGN.md §14, and the operator's
  recovery runbook.
