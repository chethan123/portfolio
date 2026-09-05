-- Locked (CONTEXT.md, ADR-0012): a browser past the gate is shown nothing
-- until a passkey is checked. Two tables carry the whole of it.
--
--   passkey        the household's enrolled credentials — the public half of
--                  each one, kept until a person removes it.
--   unlock_grant   one browser's current unlock — a row minted by a verified
--                  assertion, addressed by an opaque id a cookie carries.
--
-- This is the schema half of docs/specs/lock/01-the-passkey-and-the-grant.md.
-- Ticket 02 builds the module that reads and writes both tables — the
-- ceremony options, the verification, the grant lifecycle — and this
-- migration decides only the shape that module has to work inside.
--
-- **Neither table is history.** The append-only rule (ARCHITECTURE.md) is
-- about history — position sets, prices, the things a chart plots — never
-- about the database as a whole; `upload_draft`, `person` and `instrument`
-- are already deleted from. A passkey is removed the moment a family member
-- loses the device it lived on, and a grant is deleted the moment it ends.
-- Both tables may be deleted from freely.
--
-- **Why there is no `challenge` table.** A WebAuthn challenge outlives one
-- ceremony by seconds: minted, handed to the browser, and spent or expired
-- before there is any second reason to look it up. A lost one costs nothing
-- but a retry. A table for it would be schema nobody reads twice — one
-- insert and one delete per ceremony, forever, for a value with no history
-- worth keeping. It lives instead in a module-level map in the one Node
-- process this app runs, which is ticket 02's to build, in the module ticket
-- 02 creates; this migration builds nothing for it.


-- The household's enrolled credentials — the public half of each, plus what
-- a browser needs to offer at unlock and what Settings needs to print.
create table passkey (
  -- The credential id exactly as the library returns it, base64url, and
  -- never re-encoded on the way in or out: a round trip through another
  -- encoding is how a credential stops matching itself.
  credential_id   text primary key,

  public_key      bytea not null,

  -- The signature counter, compared under the condition the specification
  -- actually states (ticket 02) since a platform authenticator reports a
  -- constant zero. WebAuthn gives it four bytes, so it is a 32-bit unsigned
  -- integer and the check below is its whole range rather than a guess: that
  -- is what lets ticket 02's module turn this column's string into a number
  -- and say, truthfully, that the conversion cannot lose anything. The rule
  -- it looks like it is breaking covers money, quantities, ids and dates,
  -- and a signature counter is none of those.
  counter         bigint not null default 0
                    check (counter >= 0 and counter <= 4294967295),

  -- What registration reported, comma-joined into this one text column. The
  -- transport vocabulary carries no commas, so joining is lossless and a
  -- reader splits on read; the values are never validated against that
  -- vocabulary, since a transport this instance does not recognise today is
  -- still worth keeping for the day a browser does. **Null, never the empty
  -- string, when a response reported none** — the library says "none" with
  -- an empty array, and `''.split(',')` is a single empty transport rather
  -- than no transports at all, which is a bug the writer has to refuse
  -- rather than the reader having to spot. It is the hint a browser uses to
  -- decide whether to offer the cross-device flow the new-device story
  -- depends on — the one optional column here with a reader.
  transports      text,

  -- Eligibility for backup, not the current backup state: one flag, not
  -- two. Whether a passkey *can* sync is what "synced" means to a reader
  -- (Settings), and it is fixed the instant the passkey is created; the
  -- separate current-state flag would be a write on every unlock to keep one
  -- adjective fresh for a fact nothing here reads freshly.
  backup_eligible boolean not null,

  -- Human-readable, so Settings has something to print that is not a hash.
  label           text not null,

  -- Set by the one enrolment that carried no assertion, because at that
  -- moment the household held no passkey and there was nothing to authorise
  -- against. Nothing ever updates it. The index below is what it is for.
  bootstrap       boolean not null default false,

  enrolled_at     timestamptz not null default now(),

  -- Null until the first verified assertion, and stamped by every one after:
  -- unlocking, and the confirmations that authorise enrolling and removing.
  -- Not "last unlocked" — a passkey that has only ever authorised a removal
  -- carries a time here without having unlocked anything.
  last_used_at    timestamptz
);

-- Two columns this table deliberately does not have.
--
-- No `user_handle`. Registration generates a fresh one per enrolment and it
-- matters — it is what keeps two passkeys from the same provider as two
-- entries rather than one replacing the other — but the library does not
-- return it from verification, so storing it would mean carrying it across
-- two requests for a check that cannot actually fail: the credential is
-- found by its own id and the signature verified against that credential's
-- own key.
--
-- No AAGUID. Level 3 does stop zeroing it under `attestation: "none"`, but
-- nothing in this slice reads it, and a column with no reader is a column
-- that will drift wrong without anyone noticing.

-- **Two halves close two of the three ways the household's first enrolment
-- can interleave, and neither is enough alone.** This index is one of them,
-- and it is worth being exact about which — and about the third, which they
-- do not close — because the next author will otherwise take the pair for
-- the whole rule.
--
-- The rule ticket 02 enforces is that a passkey may be enrolled with no
-- assertion only while the household holds none — there is nothing to
-- authorise against at that moment, and anyone the gate admitted already
-- sees every figure. Written naively that is a check followed by a write,
-- and the gap between them is where a second browser enrols without the
-- assertion the household already had the means to demand.
--
-- *The insert closes the committed half.* `insert into passkey (...) select
-- ... where not exists (select 1 from passkey)` writes nothing once any
-- passkey is committed, however long ago the enrolling request decided the
-- table was empty. That half cannot live here: emptiness is not a uniqueness
-- predicate and no index can stand in for it.
--
-- *This index closes the concurrent half.* Under READ COMMITTED that
-- statement takes a fresh snapshot per statement, and its `not exists` scan
-- takes no predicate lock on rows that do not exist — so two of them running
-- at once each see an empty table and both land. Both set `bootstrap`, and a
-- unique index over the flagged rows has no such gap: the second insert
-- blocks on the first's uncommitted tuple and fails the moment it commits.
--
-- So this is not the AAGUID column rejected above. That would be data nobody
-- consults; this is a key Postgres itself consults on every insert. What it
-- guarantees, exactly, is that **at most one live row carries the flag** —
-- never that the table was empty when that row was written. The slot frees
-- when the flagged row is removed, which is why the conditional insert is
-- the half that answers "does the household hold a passkey", and why
-- removing every passkey genuinely returns the instance to the unlocked,
-- anyone-may-enrol case the operator's recovery depends on.
--
-- *What the pair does not close.* Together they guarantee two things and
-- not a third: at most one flagged live row, and no bootstrap into a
-- household that already holds a committed passkey. They do not serialise a
-- bootstrap insert against an *ordinary* one. Browser A begins an
-- assertion-authorised enrolment while the household holds X (so A's
-- registration is not flagged); every passkey is then removed; browser B,
-- seeing an open household, begins a bootstrap; and the two inserts run at
-- the same instant. The index compares flagged rows only with each other,
-- so A's unflagged row is invisible to it, and B's `not exists` cannot see
-- A's uncommitted tuple — both land, and B holds an assertion-free passkey
-- in a household A has just locked. Under autocommit that window is one
-- statement wide, and reaching it takes a gate-admitted family member
-- holding a `register` challenge minted while the household was locked,
-- completed inside the two minutes it lives, across the instant every
-- passkey is removed and another browser bootstraps.
--
-- *Two ways to close it, neither taken; the decision is spec 0020's.* A
-- mirror predicate on the ordinary insert — `where exists (select 1 from
-- passkey)` — narrows the window to that statement's own duration without
-- closing it, since A's snapshot can predate X's removal while B's follows
-- it, and it would refuse the case `app/lib/lock.server.ts`'s
-- `completeRegistration` header names as fine: A completing after every
-- passkey was removed, which leaves a credential stranded in A's vault. A
-- `lock table passkey in share row exclusive mode` before the bootstrap
-- insert does close it, but only inside an explicit transaction, and this
-- module deliberately opens none — its writes run on the autocommitting
-- handle and savepoints stand in only where a caller already holds one
-- (`guardedAgainstConstraintViolation`'s own header). Both cost more than a
-- one-statement window is worth.
create unique index passkey_bootstrap_idx on passkey (bootstrap) where bootstrap;


-- One browser's current unlock. The row is the authority; the cookie that
-- names it carries no claim of its own, so a forged value names nothing and
-- a copied live one only names the row it was copied from — which is what
-- makes the row deletable and is the honest limit of a bearer token.
create table unlock_grant (
  -- A cryptographically random token, minted by ticket 02's module — no
  -- default here, because there is nothing default-worthy about it. This
  -- departs from 0001's `bigint generated always as identity` convention on
  -- purpose, not by oversight: this id travels in a cookie and is the whole
  -- of the cookie's security, so a sequential one would be a bearer token an
  -- attacker can count through. `text`, exactly as `passkey.credential_id`
  -- is — an opaque token, never an integer to increment.
  --
  -- The length check is that sentence made an invariant rather than left as
  -- a claim. Its real target is the short end: an absent or blank cookie
  -- normalises to `''` on more code paths than anyone can keep track of, and
  -- a row keyed `''` would then be the grant every browser sending no cookie
  -- at all matches.
  id          text primary key check (length(id) >= 32),

  -- CASCADE: this is what makes removing a passkey end its grants with it —
  -- how a family member who loses a phone revokes it from any other device
  -- they can still unlock. No `on update` clause, deliberately: a credential
  -- id is what the authenticator gave us and is never rewritten, so the
  -- default refusal is the right answer to a rewrite nothing should attempt.
  passkey_id  text not null references passkey (credential_id) on delete cascade,

  granted_at  timestamptz not null default now(),

  -- Deliberately unconstrained against `granted_at`: a grant already past
  -- its expiry is a state the readers must handle and the tests must be able
  -- to write, and a `check (expires_at > granted_at)` would forbid seeding
  -- the one case the boundary most needs proving against.
  expires_at  timestamptz not null
);

-- The index the sweep reads, matching `upload_draft_created_at_idx`'s
-- precedent: both are scaffolding tables cleared by a cutoff comparison
-- issued on the same path as the write that has to look at them anyway,
-- never by a scheduler. At household scale the planner will often prefer a
-- sequential scan over either; the index is here so the sweep's cost stays a
-- property of the schema rather than of how many browsers the family owns.
create index unlock_grant_expires_at_idx on unlock_grant (expires_at);


comment on table passkey is
  'The household''s enrolled credentials — the public half of each, kept until a person removes it. The instance is locked whenever at least one row exists (ADR-0012); removing the last one turns the lock off. Not history: may be deleted from freely.';

comment on table unlock_grant is
  'One browser''s current unlock, addressed by an opaque id a cookie carries — the row is the authority, the cookie only names it. Scaffolding, not history, on the same footing as upload_draft: swept once expired, deleted outright by an explicit lock, and cascaded away with the passkey that minted it.';
