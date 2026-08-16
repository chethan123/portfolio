# 06 — Account management

_Part of [0001-foundation-day-zero.md](../0001-foundation-day-zero.md)._

**What to build:** A family member records the accounts the household holds — brokerage, workplace
plan, IRA, bank, loan — each with an owner and a tax treatment. This is what gives a future statement
somewhere to land, and it is the point at which the design's ownership and tax-treatment decisions
become usable. Closing an account retires it from today's net worth without erasing the dates it was
open.

This ticket also lands the refusal to remove a person who owns accounts, since that rule needs
accounts to exist before it means anything.

**Blocked by:** 05.

**Status:** ready-for-agent

- [ ] Settings → Accounts is reachable from the navigation
- [ ] An account can be created with a name, institution, kind, owner and tax treatment
- [ ] Kind, tax treatment and owner are required at creation; institution and external account
      number are free text
- [ ] The external account number can be recorded, so a later upload can pre-select the right
      account
- [ ] An existing account can be edited, including correcting a wrong tax treatment
- [ ] An account can be closed, which sets its closing date; there is no delete affordance anywhere
- [ ] A closed account stops counting toward current net worth and still counts for dates before it
      closed
- [ ] Removing a person is refused while they own any account, open or closed, with a message naming
      the accounts rather than a constraint violation
- [ ] A workplace plan holding both Traditional and Roth money is representable as two accounts at
      the same institution with different tax treatments
- [ ] Writes go through the same module that serves reads
- [ ] Tested at the same seam as the query module, seeding through the domain fixture builder
