# 05 — Enrolling a passkey, and saying honestly what it is

_Part of [0019-the-lock.md](../0019-the-lock.md)._

**What to build:** A Settings screen that lists the household's passkeys and enrols another. Each row
names the passkey, when it was enrolled, when it was last used, and whether it is synced or bound to
one device. Enrolling runs the registration ceremony and is refused unless the request is already
authorised — an unlocked browser, or a token from ticket 07.

Its own ticket because the honest reporting is the point, not a detail. A synced passkey in a password
manager whose vault is already unlocked can satisfy the check without prompting anybody, and the
household cannot weigh that unless the screen says which passkeys are synced.

**Blocked by:** [04](04-the-unlock-screen.md). Enrolling the first passkey locks every browser, so the
screen that unlocks one must already exist. Runs in parallel with [06](06-lock-now-and-coming-back.md).

**Status:** ready-for-agent

**The list**

- [ ] A tab under Settings, beside Display, listing every enrolled passkey
- [ ] Each row: the label, enrolled date, last used date or "never", and synced or device-bound read
      from the stored backup flags
- [ ] Backup state is refreshed from each successful assertion, so a row that changes is not stale
- [ ] The empty state says the instance is not locked and that enrolling a passkey locks it
- [ ] Dates render through the existing formatter; masking does not touch this screen, because none of
      it is an amount

**Enrolling**

- [ ] A control that runs the registration ceremony and posts the response
- [ ] The label is asked for before the ceremony, not derived from the user agent, because a family
      member naming their own phone is more useful than a parsed string
- [ ] The server refuses an enrolment from a request with neither a live grant nor a valid token, with
      a message the screen prints
- [ ] A duplicate enrolment of a credential already stored is refused rather than creating a second row

**The warning before the first one**

- [ ] Enrolling the first passkey shows, before it happens, that every other browser in the household
      becomes locked and that each will need its own passkey or a cross-device unlock
- [ ] It is a statement the person must pass, in the voice the unprotected-instance banner uses — this
      instance tells the truth about its own posture in the interface, not only in a document
- [ ] It is shown only when no passkey exists; enrolling a second one changes nothing for anybody

**Removing**

- [ ] Removing a passkey deletes it, and its grants with it through the cascade from ticket 01
- [ ] Removing the last passkey unlocks the instance, and the screen says that is what it is about to
      do before it does it
- [ ] Removal must be acknowledged first, the way closing an account already is

**Tests**

- [ ] An admitted request with no grant and no token cannot enrol; the message names why
- [ ] A request with a live grant can
- [ ] The first-passkey warning appears only when none exists
- [ ] Removing the last passkey leaves every screen rendering again, which is the same assertion
      ticket 03's no-op case makes
- [ ] A synced and a device-bound passkey render differently, from the stored flags
