# 01 — The two tables: a passkey the household keeps, a grant a browser holds

_Part of [0019-the-lock.md](../0019-the-lock.md)._

**What to build:** One migration adding `passkey` and `unlock_grant`, then the regenerated types.
`passkey` is the household's enrolled credentials — the public half, the credential id, the signature
counter, whether it is backup-eligible and currently backed up, the authenticator's AAGUID, a label
a person can read, and when it was enrolled and last used. `unlock_grant` is one browser's current
unlock: an opaque id, the passkey that minted it, when it was minted and when it expires.

Doing the schema first is worth its own pull request because it is the one part of this slice that
has no browser in it. The columns decide what every later ticket can say — whether Settings can
report a synced passkey, whether the deferred revocation is a `delete` or a redesign, and whether
the middleware can extend a grant without a second query. Getting them wrong is expensive and
getting them right here is cheap.

**Blocked by:** Nothing. It touches no route and no existing table.

**Status:** ready-for-agent

**The migration**

- [ ] `migrations/0012_lock.sql`, zero-padded, following the existing filename order
- [ ] `passkey` keys on the credential id as the authenticator gives it, stored as text in the
      base64url form the library returns — never re-encoded on the way in or out, because a
      round-trip through another encoding is how a credential stops matching itself
- [ ] The public key is stored as `bytea`; the signature counter as `bigint not null default 0`
- [ ] `backup_eligible` and `backed_up` are separate booleans, not one enum — the specification
      treats them as independent flags and a passkey may be eligible without currently being backed up
- [ ] `aaguid` is nullable text: Level 3 stops zeroing it under `attestation: "none"`, but nothing
      guarantees an authenticator supplies one worth keeping
- [ ] A human-readable label, `not null`, so Settings has something to print that is not a hash
- [ ] `enrolled_at` and `last_used_at` as `timestamptz`; `last_used_at` nullable until first use
- [ ] `unlock_grant` holds an opaque id as its primary key, `passkey_id` referencing `passkey` with
      `on delete cascade`, `granted_at` and `expires_at`
- [ ] The cascade is the point: it is what makes revoking a passkey end its grants, which is the
      deferred work this slice leaves room for rather than builds
- [ ] An index on `unlock_grant (expires_at)` so the sweep does not scan
- [ ] No table in this migration is history: both may be deleted from, and the comment in the
      migration says so, because every other table in this schema may not

**The generated types**

- [ ] `npm run db:types` run against the migrated database and the regenerated file committed —
      CI's `db:types -- --verify` rejects the pull request otherwise
- [ ] `app/lib/database.generated.ts` is not hand-edited
- [ ] `npm run typecheck` passes, which is where a migration that broke an existing query surfaces

**The sweep**

- [ ] Expired grants are deleted, on the same principle `upload_draft` rows are swept — a grant past
      its expiry is refused by the middleware whether or not the row is still there, so the sweep is
      hygiene and never the enforcement
- [ ] The sweep is a function in the domain module's file, exercised by a test, and wired to nothing
      yet; ticket 03 calls it
- [ ] A test proves an expired grant is removed and an unexpired one is not

**Tests**

- [ ] Seeding helpers for both tables added to `tests/support/fixtures.ts` beside the existing
      builders, so no later ticket writes a raw `INSERT`
- [ ] A test asserts the cascade: deleting a passkey deletes its grants
- [ ] A test asserts a grant cannot reference a passkey that does not exist
