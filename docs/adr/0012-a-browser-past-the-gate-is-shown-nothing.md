# A browser past the gate is shown nothing until a passkey is checked

The gate (ADR-0005) decides which *person* may reach this instance, and then holds that answer in a
cookie for seven days that does not roll. There is no working sign-out — DESIGN.md §14 records it,
and a real control is tracked as an issue. So a family phone that is unlocked and in somebody
else's hands is a week of unchallenged access to every balance, and nothing in the stack answers
that. ADR-0007 named this exact adversary — a cache "is readable by whoever holds the unlocked
phone" — and answered it for *stored* data by refusing to store any. This ADR answers it for the
live session.

The app now refuses, in root middleware — a `middleware` export from `app/root.tsx`, which is the
one place a rule can run ahead of every route in this framework. A browser holding no valid grant is
turned away before `next()` is called, so no loader runs and the figures are not merely hidden but
never fetched. This is deliberately not the shape of the chart-range middleware, the only other one
here, which awaits `next()` and decorates the response it gets back.
Unlocking is a WebAuthn assertion with `userVerification: "required"` against a passkey the
household has enrolled; the grant it mints is a row in Postgres with a rolling idle expiry, addressed
by an unguessable random id in a `SameSite=Lax` cookie. Enrolling a passkey and removing one each
require a *fresh* assertion rather than a live grant, because a grant is precisely what the adversary
named above inherits — otherwise a borrowed phone turns minutes of access into a passkey of its own,
and into deleting everybody else's. That raises the cost of those two writes; it does not close
them, for the reason the next section gives about freshness, and no document here should claim
otherwise. The lock is on whenever the household holds
at least one passkey and off when it holds none — there is no switch to set, and removing the last
passkey is how it is turned off.

## What this is not

**It is not the gate, and it does not weaken it.** The gate still refuses before a request reaches
this process, so taking an address off the allowlist still ends that person's access on the next
request whether or not their browser holds a grant. The gate keeps a *person* out; the lock keeps a
*browser* out.

**It is not masking, and it does not replace it.** Masking (ADR-0002) is for a screen you are
reading while somebody sits beside you: names, dates and structure stay legible and only the
figures become dots. The lock cannot serve that, because locked means nothing renders at all. The
two answer different threats and both survive. What does not survive is ADR-0002's sentence that
"the login gate (§10) is the only boundary this application has" — see below.

## What the platform can and cannot promise

Three limits are properties of the web platform, not of this implementation, and every claim made
about the lock has to be made inside them.

**The check is not a biometric and cannot be required to be one.** WebAuthn verifies the user by
whatever means the authenticator accepts — the specification's own examples are "a touch plus pin
code, password entry, or biometric recognition" — and Level 3 removed the `uvm` extension that used
to report which was used. The device passcode satisfies user verification exactly as a fingerprint
does. `Passkey`'s `_Avoid_` line in `CONTEXT.md` carries *biometric* and *fingerprint* for this
reason.

**There is no freshness signal.** The assertion carries no timestamp, and no option asks for user
verification newer than some age; the working group's `timeSinceUv` proposal is open and not in the
Recommendation. A provider whose vault is already unlocked may legitimately return `UV=true`
without prompting anyone. The server therefore treats the assertion as an authorisation event bound
to a single-use challenge and a short-lived grant, and never as proof that a human was checked N
seconds ago.

**A passkey the household enrols may be synced.** Backup eligibility is visible to us — the BE and
BS flags in the authenticator data — but refusing backup-eligible passkeys would exclude iCloud
Keychain and Google Password Manager, which is where a phone's own passkey goes. So they are
accepted and recorded, and Settings marks the eligibility — never proof a copy has actually been
made anywhere. The honest statement of the guarantee is that
**the lock is only as strong as whatever unlocks the passkey provider on that device.**

## Considered options

**Auto-mask on idle or on re-entry.** The cheap answer, and spec 0007 deferred exactly this as out
of scope rather than rejecting it. Rejected here as an answer to *this* threat: revealing costs one
tap, so the person holding the device simply taps. Re-masking defends a glance, which masking
already did.

**Shorten the gate's cookie and make sign-out work.** Not rejected — it is cheaper, it is
complementary, and it should happen. Rejected only as *sufficient*: a shorter window is still a
window, and the phone in somebody's hand is inside it.

**A signed cookie instead of a row.** Stateless and one fewer table. Rejected because revoking one
device would then mean rotating a signing secret and ending every device's grant at once — the
precise pain ADR-0005 already records about the gate — and because it reintroduces
`SESSION_SECRET`, deleted by name in `auth-gate/02-delete-password-gate.md`.

**A household PIN as the thing that unlocks.** Rejected: it is one shared secret with no per-person
revocation, which is the password that slice removed.

**Withhold the amounts and let the rest render.** Rejected because it puts the boundary in every
loader. That is masking's shape, and masking already leaks it — `app/routes/upload/columns.tsx`
renders raw statement cells with no masking at all, and `tests/masking-boundary.test.ts` misses it
because it guards the four formatters rather than raw strings. A refusal spread over every loader
is a refusal that will be forgotten somewhere.

**Per-device opt-in, the way a bank app does it.** Rejected because a bank app's account is
per-person and this instance's is not. A browser that never opted in would be a browser with no
lock: on iOS the installed web app and Safari hold separate cookie jars, so the same phone offers a
second, unlocked way in.

## Consequences

- **The app holds per-request state again**, for the first time since the password gate was
  deleted. It is a session cookie in the mechanical sense — the documents that say this app issues
  none become false and ticket 07 corrects them — and it is not a session in the sense those
  documents meant, which was an identity the app authenticates and carries. A grant says one browser
  was unlocked and
  when, nothing else.
- **The unlock screen is the first screen that requires JavaScript.** `navigator.credentials.get()`
  has no progressive-enhancement path, so with scripting off the instance is simply locked. This is
  a deliberate exception to the pattern every other control in the app follows.
- **ADR-0002's payload decision is reversed for this surface.** Masking leaves the amounts in the
  serialised loader data on purpose, so unmasking costs no round trip; a locked browser is sent
  none, and unlocking is a round trip. Masking's own behaviour is unchanged.
- **ADR-0002's stated limit is now wrong where it says the gate is the only boundary this
  application has.** It is amended in place, in the bracketed form it already carries from ADR-0005.
- **The app reads the instance's public origin for the first time.** `PUBLIC_ORIGIN` exists today as
  a Compose-level variable the gate consumes, and DESIGN.md §10.1 says plainly that the app never
  reads the gate's settings. The relying-party id has to come from somewhere stable, so the app
  gains another variable shared with the sidecar — not its first: `compose.yaml` already passes
  `TZ` to both, and the app validates and uses that one too — and the environment table that records
  the split gains a row.
- **The grant cookie is `Secure` and `__Host-` prefixed**, where masking's is neither. Masking's
  cookie is deliberately unprefixed and insecure because it carries a preference and an instance
  genuinely reached over plain http must still get it; this one carries the id of a live unlock, and
  WebAuthn will not run outside a secure context anyway, so the attributes cost nothing and the
  prefix is free.
- **A live grant is a bearer token**, and the honest limit of one is stated where the row is defined
  (`migrations/0012_lock.sql`, [`../data-model.md`](../data-model.md)): a copied cookie is as good as
  the original until the row ends — by its idle window, by "Lock now", or with the passkey that
  minted it.
- **A browser without a live grant cannot unlock without running the ceremony** once a passkey
  exists — many in-app WebView browsers offer no *completable* ceremony (`app/lib/unlock-ceremony.ts`'s
  own hedge, which this document matches rather than overstating). A browser that already holds one
  is unaffected: the middleware checks only whether a live grant exists, never whether this browser
  could complete the ceremony again, so this limit is about getting back in rather than about staying
  in. It is not enforced by a capability check, which the client would control; it falls out of the
  server refusing until an assertion arrives, which only a browser with no live grant is ever asked
  for. The unlock screen names two self-service recoveries first — another browser on this device, or
  a device that can reach a passkey the household has enrolled — and only after those does it point
  at the operator.
- **The relying-party id is the instance's public hostname** and cannot be an IP address. Changing
  the hostname orphans every enrolled passkey, and every family member enrols again.
- **A runtime dependency arrives** in a repository that prunes them deliberately. Verifying a
  WebAuthn assertion by hand is not a thing to do beside financial data.
- **Revoking one passkey is in this slice, and it works for a household that holds more than one.**
  Deleting a passkey cascades to its grants, so a family member who loses a phone unlocks on another
  enrolled device and removes the lost one. A household holding exactly one passkey cannot: removal
  needs an assertion, and the only credential that can give one is on the lost device. That case
  falls back to the operator, which is why the enrolment screen presses for a second passkey rather
  than leaving the household on one.
- **What stays deferred is only the gate's own sign-out and cookie lifetime**, which this slice does
  not touch.
- **The grant cookie must be `SameSite=Lax`, never `Strict`.** The gate's redirect through Google
  returns as a top-level navigation; `Strict` would withhold the cookie and re-lock every browser
  every time the gate refreshed, which would read as a random bug.
