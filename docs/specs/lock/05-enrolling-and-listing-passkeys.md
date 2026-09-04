# 05 — Enrolling a passkey, and saying honestly what it is

_Part of [0019-the-lock.md](../0019-the-lock.md)._

**What to build:** A Settings tab that lists the household's passkeys, enrols another, and removes
one. Each row names the passkey, when it was enrolled, when it was last used, and whether it is
synced or bound to a single device. Enrolling and removing are each refused unless the request
carries a fresh assertion for that action; the one exception is the very first passkey, when none
exists and there is nothing yet to authorise.

Its own ticket because the honest reporting is the point rather than a detail. A synced passkey in a
password manager whose vault is already unlocked can satisfy the check without prompting anybody, and
the household cannot weigh that unless the screen says which passkeys are synced.

**Blocked by:** [04](04-the-unlock-screen.md). Enrolling the first passkey locks every browser, so
the screen that unlocks one must already exist. Runs in parallel with
[06](06-lock-now-and-coming-back.md).

**Status:** ready-for-agent

**Registering the screen**

- [ ] Three places: the route in `app/routes.ts` — which is the wasted hour CLAUDE.md actually warns
      about — plus the tab in `settings.tsx`'s tab list and the card in `settings/index.tsx`, which are
      this slice's own observation rather than a documented rule
- [ ] It sits beside Display, and carries no amount, so masking does not touch it

**The list**

- [ ] Each row: the label, enrolled date, last used date or "never", and synced or device-bound read
      from the stored backup-eligibility flag
- [ ] The empty state says the instance is not locked, and that enrolling a passkey locks it
- [ ] Dates render through the existing formatter

**Enrolling**

- [ ] A control that runs the registration ceremony and posts the response
- [ ] Where a passkey already exists, enrolling is **two deliberate steps**, each on its own tap:
      confirm with an existing passkey, then create the new one. They cannot be chained off one
      gesture — WebKit requires each call to sit inside its own user activation — and two prompts
      arriving unannounced from one tap would read as a bug
- [ ] The screen says what the first step is for, so the family member knows why they are being asked
      to prove themselves before adding a device
- [ ] The label is asked for before the ceremony, not derived from the user agent: a family member
      naming their own phone is more useful than a parsed string. It is also what the person's password
      manager will show, because it is the WebAuthn user name
- [ ] The server refuses an unauthorised enrolment with a message the screen prints
- [ ] A duplicate enrolment of a credential already stored is refused rather than creating a row

**The warning before the first one**

- [ ] Enrolling the first passkey shows, before it happens, that every other browser in the household
      becomes locked, and that each will need its own passkey or a cross-device unlock
- [ ] It is a statement the person must pass, in the voice the unprotected-instance banner uses —
      this instance tells the truth about its own posture in the interface, not only in a document
- [ ] It is shown only when no passkey exists; enrolling a second changes nothing for anybody
- [ ] While the household holds exactly one, the screen presses for a second and says why: removal
      needs an assertion, so a household on one passkey that loses the device holding it cannot revoke
      it and falls back to the operator
- [ ] The browser that enrolled the first passkey is not locked out by its own success: verifying a
      registration mints a grant (ticket 02), so the redirect back to Settings still renders

**Removing**

- [ ] Removing a passkey requires a **fresh assertion scoped to that passkey**, for the same reason
      enrolling does. Otherwise somebody holding a briefly-unlocked phone can delete every passkey the
      household has, cascade away everyone's grants, and leave the instance open to be re-enrolled
- [ ] Removal deletes the passkey and its grants through ticket 01's cascade. That is how a lost device
      is revoked: unlock on another enrolled device and remove the lost one
- [ ] Removing the passkey you just asserted with — retiring the phone in your hand — deletes the grant
      that assertion minted, so this browser is locked the moment it succeeds. The screen says so
      before, rather than appearing to have signed you out
- [ ] The acknowledgement is ticket 02's, in the domain module rather than on the screen; this screen
      collects it
- [ ] Removing the last passkey unlocks the instance, and the screen says that is what it is about to
      do before it does it

**Tests**

- [ ] A request with a live grant but no fresh assertion can neither enrol nor remove; the message
      names why
- [ ] An assertion minted for unlocking does not authorise a removal, and one minted to remove one
      passkey does not authorise removing another
- [ ] A request with no grant can enrol when no passkey exists, and cannot once one does
- [ ] Enrolling the first passkey leaves the enrolling browser able to load the next screen
- [ ] The first-passkey warning appears only when none exists
- [ ] Removing a passkey ends its grants; removing the last leaves every screen rendering again,
      which is the same assertion ticket 03's no-op case makes
- [ ] A synced and a device-bound passkey render differently, from the stored flag
