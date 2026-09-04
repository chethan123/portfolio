# 07 — The first passkey, from the operator's shell

_Part of [0019-the-lock.md](../0019-the-lock.md)._

**What to build:** A script the operator runs on the box that mints one single-use enrolment token,
and the runbook that says when to reach for it. It is how the first passkey gets enrolled, since there
is no unlock to authorise it, and how the household recovers when every enrolled passkey is
unreachable.

Last of the working tickets because it is the smallest and the most dangerous: it is a path that
creates enrolment authority without passing the lock. It is worth its own review for that reason
alone.

**Blocked by:** [05](05-enrolling-and-listing-passkeys.md). The token is spent by that screen's
ceremony, so there is nothing to test against until it exists.

**Status:** ready-for-agent

**The script**

- [ ] `scripts/`, run under Node with the environment file, like the other scripts here
- [ ] Mints one token, prints it once, and stores only what is needed to verify it
- [ ] The token is single-use and short-lived — minutes, not hours — and is spent whether or not the
      ceremony that follows succeeds
- [ ] It authorises enrolment and nothing else: it does not mint a grant, does not unlock a browser,
      and cannot be exchanged for one
- [ ] Running it while passkeys already exist is allowed and says what it is for, because that is the
      recovery case
- [ ] It refuses to run against a database it cannot migrate-check, rather than writing into an old
      schema

**The runbook**

- [ ] `docs/operating.md` gains the first-run path: enrol the first passkey, and what happens to every
      other browser the moment it lands
- [ ] The recovery path is written beside it: mint a token, or remove every passkey to open the
      instance again
- [ ] It states plainly that this is the break-glass path ADR-0005 already names as this instance's
      answer, and that there is deliberately no way in through the front door

**Tests**

- [ ] A minted token authorises exactly one enrolment
- [ ] A spent token is refused, and a failed ceremony still spends it
- [ ] An expired token is refused
- [ ] A token cannot be used to read any screen
