# 01 — The two tables: a passkey the household keeps, a grant a browser holds

_Part of [0019-the-lock.md](../0019-the-lock.md)._

**What to build:** One migration adding `passkey` and `unlock_grant`, then the regenerated types and
the fixture builders every later ticket seeds through. `passkey` is the household's enrolled
credentials — the public half, the credential id, the signature counter, whether the passkey is
eligible for backup, a label a person can read, and when it was enrolled and last used.
`unlock_grant` is one browser's current unlock: an opaque id, the passkey that minted it, and when it
expires.

Doing the schema first is worth its own pull request because it is the one part of this slice with no
browser in it, and because the columns decide what every later ticket can say — whether Settings can
report a synced passkey, and whether removing a passkey ends its grants or leaves them live.

**Blocked by:** Nothing. It touches no route and no existing table.

**Status:** ready-for-agent

**The migration**

- [ ] `migrations/0012_lock.sql`, zero-padded, following the existing filename order
- [ ] `passkey` keys on the credential id as the authenticator gives it, stored as text in the
      base64url form the library returns — never re-encoded on the way in or out, because a
      round-trip through another encoding is how a credential stops matching itself
- [ ] The public key is stored as `bytea`; the signature counter as `bigint not null default 0`
- [ ] The counter is the one value in this slice that crosses the driver boundary as a string and is
      then turned into a number, because the library compares it as one. That is allowed and is named
      in the module header where it happens: the rule it appears to break is about money, quantities,
      ids and dates, and a signature counter is none of those — it is a 32-bit unsigned integer by
      specification, so it is exactly representable and the conversion cannot lose anything
- [ ] `transports`, as text, from what registration reports. It is the hint a browser uses to decide
      which flows to offer, including the cross-device one the new-device story depends on — the one
      optional field here with a reader
- [ ] `user_handle`, the random id given to the authenticator at registration, stored so the assertion's
      own handle can be checked against it
- [ ] One backup flag, `backup_eligible`, and not the current-state flag beside it: eligibility is
      what "synced" means to a reader and is fixed when the passkey is created, while the current
      state would be a write on every unlock to keep one adjective fresh
- [ ] No AAGUID column. Level 3 does stop zeroing it under `attestation: "none"`, but nothing in this
      slice reads it, and a column with no reader is a column that will be wrong without anyone
      noticing
- [ ] A human-readable label, `not null`, so Settings has something to print that is not a hash
- [ ] `enrolled_at` and `last_used_at` as `timestamptz`; `last_used_at` nullable until first use
- [ ] `unlock_grant` holds its id as a random token from a cryptographic source, text, not a sequence.
      The initial migration's convention is `bigint generated always as identity`, and departing from
      it is the point rather than an oversight: this id travels in a cookie and is the whole of the
      cookie's security, so a sequential one would be a bearer token an attacker can count to. The
      migration's comment says exactly that, because the convention it breaks is written down
- [ ] `passkey_id` references `passkey` with `on delete cascade`, plus `granted_at` and `expires_at`
- [ ] The cascade is what makes removing a passkey end its grants, which is how a family member who
      loses a phone revokes it from any other device they can still unlock
- [ ] An index on `unlock_grant (expires_at)` so the sweep does not scan, matching
      `upload_draft_created_at_idx`'s precedent
- [ ] Neither table is history, and the migration's comment says which rule applies: the append-only
      rule is about history rather than about the database (ARCHITECTURE.md), and `upload_draft`,
      `person` and `instrument` are already deleted from

**No table for challenges**

- [ ] A ceremony's challenge lives in a module-level map in the one Node process this app runs, spent
      on read and expiring on a timer — not a table, not a cookie
- [ ] The reasoning goes in the module header rather than here: a challenge outlives one ceremony by
      seconds, a lost one costs a retry, and a table for it would be schema nobody reads twice

**The generated types**

- [ ] `npm run db:types` run against the migrated database and the regenerated file committed —
      CI's `db:types -- --verify` rejects the pull request otherwise
- [ ] `app/lib/database.generated.ts` is not hand-edited
- [ ] `npm run typecheck` passes, which is where a migration that broke an existing query surfaces

**Tests**

- [ ] Seeding helpers for both tables added to `tests/support/fixtures.ts` beside the existing
      builders, so no later ticket writes a raw `INSERT`
- [ ] The passkey builder takes a public key, so ticket 02 can seed the one its fixture assertion
      actually verifies against rather than a placeholder
- [ ] A test asserts the cascade: deleting a passkey deletes its grants
- [ ] A test asserts a grant cannot reference a passkey that does not exist
