# 05 — Enrolling a passkey, and saying honestly what it is

_Part of [0019-the-lock.md](../0019-the-lock.md)._

**What to build:** A Settings tab that lists the household's passkeys, enrols another, and removes
one. Each row names the passkey, when it was enrolled, when it was last used, and whether it is
synced or bound to a single device. Enrolling is refused unless the request is authorised — a live
grant, or no passkey existing yet.

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
- [ ] Where a passkey already exists, the screen runs an **assertion first** and posts both: enrolling
      is one of the two writes that decide who may unlock in future, so a live grant is not enough
      authority for it. This is the prompt a bank app gives you when you add a device
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
- [ ] The browser that enrolled the first passkey is not locked out by its own success: verifying a
      registration mints a grant (ticket 02), so the redirect back to Settings still renders

**Removing**

- [ ] Removing a passkey requires a **fresh assertion** in the same request, for the same reason
      enrolling does. Otherwise somebody holding a briefly-unlocked phone can delete every passkey the
      household has, cascade away everyone's grants, and leave the instance open to be re-enrolled
- [ ] Removal deletes the passkey and its grants through ticket 01's cascade. That is how a lost device
      is revoked: unlock on another enrolled device and remove the lost one
- [ ] The acknowledgement lives in the domain module rather than on the screen, the way `closeAccount`
      requires its confirmation — a destructive write a replayed POST can reach silently was never
      acknowledged at all
- [ ] Removing the last passkey unlocks the instance, and the screen says that is what it is about to
      do before it does it

**Tests**

- [ ] A request with a live grant but no fresh assertion can neither enrol nor remove; the message
      names why
- [ ] A request with no grant can enrol when no passkey exists, and cannot once one does
- [ ] Enrolling the first passkey leaves the enrolling browser able to load the next screen
- [ ] The first-passkey warning appears only when none exists
- [ ] Removing a passkey ends its grants; removing the last leaves every screen rendering again,
      which is the same assertion ticket 03's no-op case makes
- [ ] A synced and a device-bound passkey render differently, from the stored flag
