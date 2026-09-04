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
fetched. Enforcement is one middleware ahead of every route, beside the chart-range middleware that
already exists, so the refusal is a single site a test can pin rather than a discipline spread over
every loader.

Three things sit outside it: the unlock route itself, the health endpoint, and the service worker
and the static assets it needs to render its offline page. Nothing else.

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
the same principle. It records which passkey unlocked it and when, which is what makes the deferred
revocation work a `delete` rather than a redesign.

### Enrolling a passkey

Enrolling is authorised by an unlock, never by the gate alone. A browser that is already unlocked
may enrol a passkey for itself or approve one for another browser; a browser that reached an unlock
through the cross-device flow is unlocked, so it may then enrol its own. Admission through the gate
is not enough on its own, because the person holding your unlocked phone has that.

The first passkey has no unlock to be authorised by, so the operator's shell mints a single-use
enrolment token — the same break-glass shape ADR-0005 already names as this instance's answer when
the front door cannot help.

### Turning it on and off

There is no switch. The instance is locked whenever the household holds at least one passkey and
open when it holds none. Enrolling the first passkey therefore locks every other browser in the
household at once, and the enrolment screen says so before it is done, in the voice the
unprotected-instance banner already uses. Removing the last passkey turns the lock off.

### What re-locks it

The idle expiry on the grant is the guarantee, and it is the only thing enforced server-side. On
top of it, a browser that has been hidden longer than a short grace navigates to the unlock screen
when it comes back, which is a courtesy: a hidden page cannot be trusted to run timers, and
`visibilitychange` cannot tell a locked screen from an app switch.

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
7. As the household operator setting this up for the first time, I want a documented shell path that
   mints one enrolment token, so that the first passkey does not require a way in through the front
   door.
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
14. As the household operator, I want the instance to be open again if I remove every passkey, so
    that a lock that goes wrong is recoverable without a database console.

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

**The relying-party id comes from the configured public origin**, which the gate's redirect already
depends on, so there is one place it is stated and one thing to get wrong. It is validated at
startup against the rules the specification imposes — a domain, never an IP address — because the
failure mode otherwise is every family member enrolling into a credential that cannot be used.

**Registration asks for a platform authenticator and user verification, and does not ask for
attestation.** This is a single-tenant household instance with no policy about which authenticator
models are acceptable and no metadata service to check one against.

**Backup eligibility is recorded at enrolment and re-read on every assertion**, because it can
change, and it is what the Settings list reports.

**Money and dates keep their existing rules.** Nothing in this slice computes an amount. Timestamps
cross the driver boundary as strings like every other date.

## Testing

Against real Postgres, through the existing helpers, in the house style — `withDatabase`, the
fixture builders, the route helpers, full-sentence `it` names.

- The middleware is the boundary, so it gets the boundary's tests: with no passkey enrolled every
  screen renders; with one enrolled and no grant every screen is refused; with a grant every screen
  renders; with an expired grant every screen is refused again. The refusal is asserted on the
  rendered markup containing no figure, not merely on a redirect.
- Assertion verification is tested for what it refuses: a replayed challenge, a challenge that was
  never issued, a wrong origin, a wrong relying-party id, a cleared user-verification flag, a
  cleared user-presence flag, and a counter regression where the specification's condition applies.
  A fixture assertion is generated once and stored, so the suite needs no browser.
- Enrolment authorisation is tested for the hole it exists to close: an admitted request with no
  grant may not enrol, and the refusal names why.
- The grant's cookie attributes are pinned the way masking's are, `SameSite=Lax` included, with a
  test that says why `Strict` is wrong.
- Turning the lock on and off is tested through the passkey count, not through a setting.
- Masking's existing tests must still pass untouched; a masked *and* locked instance is not a new
  rendering path, because locked renders no screen to mask.

## Out of Scope

- **Revoking one passkey on a lost device.** Removing the last passkey is the only off switch this
  slice ships. The graded control belongs with the sign-out work the gate already owes.
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

**The gate's return-path bug is in this slice's way.** Caddy builds its sign-in redirect by
interpolating the request URI without percent-encoding it, so a target carrying more than one query
parameter truncates at the first ampersand — already tracked as an issue. The unlock screen's return
path is exactly such a target once an owner filter and a chart range are in the address.

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
- [`lock/07-the-operators-first-passkey.md`](lock/07-the-operators-first-passkey.md) — the shell
  path that mints one enrolment token, and the runbook for it.
- [`lock/08-documents-and-the-limit.md`](lock/08-documents-and-the-limit.md) — every document
  brought level, ADR-0002 amended, and the limitation stated in DESIGN.md §14.
