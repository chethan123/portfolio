# 01 — The draft table, and the screen that starts an upload

_Part of [0004-ingest.md](../0004-ingest.md)._

**What to build:** The first of §5.1's four screens, and the table that carries the other three.
`/upload` stops being a `StubPage` and becomes: pick an open account, drop a CSV, land on the
mapping step. What makes the rest of the slice possible is the `upload_draft` row this creates —
the bytes, the filename and, as later steps fill them in, the mapping and the as-of date. It is why
each step can be a real URL that survives a reload with no client state, in a screen family that has
none (§8.1).

This is the application's first multipart form. Everything that writes today reads
`formFields(await request.formData())`, which assumes string fields, so the size bound and the file
handling are new ground and belong in one place rather than at each caller.

**Blocked by:** Nothing.

**Status:** ready-for-agent

**The migration**

- [ ] `migrations/0004_upload_draft.sql` creates `upload_draft` as specified in the slice spec —
      `account_id` referencing `account` with `on delete cascade`, `filename`, `raw_file bytea not
      null`, nullable `as_of_date` and `mapping jsonb`, `created_at` defaulting to `now()`
- [ ] An index on `created_at`, which the sweep reads
- [ ] `npm run db:types` is re-run and `app/lib/database.generated.ts` committed with the new table
- [ ] `tests/migrations.test.ts` still passes, including whatever it asserts about applying the
      whole directory to an empty database

**Configuration**

- [ ] `MAX_UPLOAD_MB` is added to `server/config.ts` as an integer, minimum 1, defaulting to 10
- [ ] It is documented in `.env.example` and in `docs/operating.md` alongside the other knobs
- [ ] `tests/config.test.ts` covers the default, a valid override, and a rejected non-integer

**The drop screen**

- [ ] `/upload` lists open accounts in a `<select>`, ordered as the Settings account list orders them
- [ ] A closed account is not offered, because a closed account's history does not change — the same
      refusal `setBalance` already makes
- [ ] With no accounts at all, the screen renders the first-run prompt pointing at Settings → People
      then Accounts, rather than an empty dropdown
- [ ] A file input accepts `.csv` and `text/csv`, and the form is `multipart/form-data`
- [ ] The screen names the size limit in words, reading it from config rather than restating it
- [ ] It works with JavaScript disabled: a plain form post, no drag-and-drop dependency. Drag-and-
      drop, if added, is decoration over the same input

**Accepting the file**

- [ ] A `Content-Length` above `MAX_UPLOAD_MB` is refused before the body is read
- [ ] A file whose size exceeds the cap is refused before its bytes are touched, naming the limit
- [ ] An empty file is refused as such, not as a parse error
- [ ] A file that is not decodable as UTF-8 text is refused with a sentence about the file, not a
      driver error. A leading UTF-8 BOM is not a decode failure — step 02 strips it
- [ ] A missing file, or no account chosen, is a field-level `ValidationError` through
      `parseInput`, rendered the way every other form in the app renders one

**The draft**

- [ ] A successful post inserts one `upload_draft` and redirects to `/upload/:draftId/columns`
- [ ] Drafts older than 24 hours are deleted at the start of each upload, in the same statement or
      immediately before it — no scheduler, no background job
- [ ] A draft id that does not exist renders a `NotFoundError` page saying the upload has expired or
      was already recorded, with a link back to `/upload` — never a 500
- [ ] A draft belonging to a closed account is treated as expired

**Navigation**

- [ ] The rail's filled primary action and the nav entry both continue to reach `/upload`, unchanged
- [ ] The step screens are not nav entries; they are reached only by working through the flow
