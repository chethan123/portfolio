# 07 — Hedge the cross-device promise, and write the walk that removes the hedge

_Part of [0020-the-lock-hardened.md](../0020-the-lock-hardened.md). Acts on the launch review's
[F7](../../research/2026-09-05-lock-slice-launch-review.md#f7--should-fix--cross-device-unlock-is-promised-without-condition-and-is-conditional)
and its §5, gap 6._

**What to build:** Two sentences of copy and one section of the operator's document. The
enrolment acknowledgement (`app/routes/settings/passkeys.tsx`, the `<strong>` inside the
first-passkey checkbox) and the guide's "Unlocking a browser" section both promise that a browser
without a passkey can be unlocked from another device. The app does its part — `allowCredentials`
carries each stored transport — but whether a browser offers the cross-device path is decided by
the transports the *registering* client reported: WebKit and Chromium both hide it when every
allowed credential lists `internal` alone. Current iCloud Keychain and Google Password Manager
report `hybrid` too; older Safari and Android values are unverified, and no real device has been
tried. So the promise holds for most households and is an unbacked sentence for some, and the one
who finds out is the family member on a second device after the first enrolment has locked them
out.

Its own ticket because the copy is what a person reads before locking everyone else out, and
because the check that would remove the hedge is one an operator performs on the household's own
phones — no agent can.

**Blocked by:** [05](05-say-what-the-family-will-see.md), which edits the same guide file.

**Status:** ready-for-agent

**The copy**

- [ ] The acknowledgement's `<strong>` says what is certain and hedges what is not: every other
      browser is locked immediately and will need its own passkey; *whether* it can instead be
      unlocked by approving from a device that already holds one depends on the provider that made
      the first passkey, and the operator's document says how to check before relying on it. Keep
      it one sentence longer than today, not a paragraph; keep the voice the unprotected-instance
      banner uses (`app/components/open-instance-banner.tsx`)
- [ ] `docs/guide/passkeys.md`, "Unlocking a browser", the paragraph beginning "If this particular
      device does not hold a passkey": "Your browser offers a way to reach another device" becomes
      "your browser *may* offer…", says that the scanner is a phone or tablet (never a laptop), and
      says what to do when the option is not there — another browser on this device, a device that
      holds a passkey, or the operator — which is the unlock screen's own list
- [ ] The tests that pin the acknowledgement text (`tests/routes/settings-passkeys.test.ts`, the
      `toContain("Enrolling this passkey locks every other browser")` assertions) are updated to the
      new sentence, asserting a fragment that survives a later tightening

**The walk, in `docs/operating.md` under "The lock"**

- [ ] A subsection "Before the household's first passkey", between "A fresh instance is not
      locked" and "Enrolling the first one locks everyone else": enrol the first passkey on the
      household's primary phone; then, on a second device holding no passkey, open the instance,
      press **Unlock**, and confirm that the browser offers a way to use another device and that
      approving on the phone completes the unlock. If it does not: `delete from passkey;` (the
      recovery the runbook already documents) returns the instance to open, and the household
      should enrol first from a device whose provider is known to sync — the section names the
      two that are known to (iCloud Keychain, Google Password Manager) and says the rest are
      unverified
- [ ] The subsection records that this was not performed by the slice that shipped the lock (the
      review's §9), so the next reader knows it is owed and not done
- [ ] `docs/runbook.md` gains the symptom — "a second device sees no way to use another device on
      the unlock screen" — pointing at the operating section for the why and at the existing
      recovery for the how; the runbook explains nothing itself

**When the walk has been done**

- [ ] The hedge comes out on evidence, not on time: once the operator records, in the same
      subsection, which providers were tried and what each offered, the acknowledgement may name
      what was observed. That is a later pull request, by whoever holds the phones

**Verification**

1. `npx vitest run tests/routes/settings-passkeys.test.ts` — real pass count after the text change.
2. `grep -n "offers a way to reach another device" docs/guide/passkeys.md` returns nothing.
3. `npm run typecheck`, `npm run build`, `npm test`.
4. The acknowledgement renders in the screenshot the capture script takes of Settings → Passkeys
   with no passkey; retake it if the wrap changed visibly (05 retakes the set; this ticket retakes
   only if its own sentence moved the layout).
