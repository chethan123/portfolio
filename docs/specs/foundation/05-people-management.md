# 05 — People management

_Part of [0001-foundation-day-zero.md](../0001-foundation-day-zero.md)._

**What to build:** A family member opens Settings → People on a fresh install and records the people
in the household, so that accounts have someone to belong to. This is the first thing the first-run
prompt will ask for, because nothing else in the system can be created until at least one person
exists.

**Blocked by:** 02.

**Status:** ready-for-agent

- [ ] Settings → People is reachable from the navigation
- [ ] A person can be added by name
- [ ] A person can be renamed, so a typo is not permanent
- [ ] Existing people are listed
- [ ] Writes go through the same module that serves reads; the routes are thin wrappers that
      validate input and call it
- [ ] Validation errors are readable and do not discard what was typed
- [ ] Tested at the same seam as the query module, seeding through the domain fixture builder
