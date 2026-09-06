-- Locked (CONTEXT.md, ADR-0012): passkey (enrolled credentials) + unlock_grant (one browser's current unlock). Neither is history — both may be deleted from freely.
-- No challenge table: a WebAuthn challenge lives seconds, kept in a module-level map (ticket 02), not the DB.


create table passkey (
  -- base64url exactly as the library returns it; re-encoding breaks matching.
  credential_id   text primary key,

  public_key      bytea not null,

  -- 32-bit unsigned (WebAuthn's own range) — not money/qty/id/date, so ok as a JS number in ticket 02.
  counter         bigint not null default 0
                    check (counter >= 0 and counter <= 4294967295),

  -- Comma-joined transport list (vocabulary carries no commas, so lossless); null (not '') when none reported — ''.split(',') would read as one empty transport.
  transports      text,

  -- Eligibility, not current state: fixed at creation, no write-on-every-unlock for a value nothing re-reads freshly.
  backup_eligible boolean not null,

  label           text not null,

  -- True only for the one no-assertion enrolment (household held none at the time); never updated. See index below.
  bootstrap       boolean not null default false,

  enrolled_at     timestamptz not null default now(),

  -- Stamped by any verified assertion (unlock, or an enrol/remove confirmation) — not just "last unlocked".
  last_used_at    timestamptz
);

-- Guards concurrent bootstrap enrolment: a unique partial index over flagged rows closes the race a check-then-insert
-- leaves open (two browsers each see an empty table under READ COMMITTED). Guarantees at most one live bootstrap row —
-- not that an assertion-authorised insert can't race a bootstrap one too (spec 0020, still open).
create unique index passkey_bootstrap_idx on passkey (bootstrap) where bootstrap;


-- The row is the authority; the cookie only names it (a forged cookie names nothing, a copied one only the row it copied).
create table unlock_grant (
  -- Opaque random token (ticket 02 mints it), not the bigint-identity convention — sequential would be a guessable bearer token.
  -- length >= 32 guards against a blank/absent cookie normalising to '' and matching every browser.
  id          text primary key check (length(id) >= 32),

  -- CASCADE: removing a passkey revokes every grant it minted (lost-phone revocation).
  passkey_id  text not null references passkey (credential_id) on delete cascade,

  granted_at  timestamptz not null default now(),

  -- Unconstrained against granted_at on purpose: tests need to seed an already-expired grant.
  expires_at  timestamptz not null
);

-- Sweep reads this; same footing as upload_draft_created_at_idx (swept on the write path, not a scheduler).
create index unlock_grant_expires_at_idx on unlock_grant (expires_at);


comment on table passkey is
  'The household''s enrolled credentials — the public half of each, kept until a person removes it. The instance is locked whenever at least one row exists (ADR-0012); removing the last one turns the lock off. Not history: may be deleted from freely.';

comment on table unlock_grant is
  'One browser''s current unlock, addressed by an opaque id a cookie carries — the row is the authority, the cookie only names it. Scaffolding, not history, on the same footing as upload_draft: swept once expired, deleted outright by an explicit lock, and cascaded away with the passkey that minted it.';
