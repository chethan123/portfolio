/**
 * The upload draft's lifecycle (DESIGN.md §5.1, docs/specs/0004-ingest.md).
 *
 * Against a real Postgres, because what is at risk is in the database: the
 * bytes surviving the round trip, the sweep deleting exactly the rows it
 * should, and the join that turns a closed account's draft into a 404.
 *
 * The tests group around the three ways a draft could quietly go wrong:
 *
 *   * a stale draft outliving its day, or a fresh one swept with it;
 *   * a draft staged against an account no statement may land in;
 *   * a dead draft URL surfacing as anything other than the expired page —
 *     a driver error on "abc" is a 500 wearing a bookmark.
 */
import { afterAll, describe, expect, it } from "vitest";

import { sql } from "kysely";

import { NotFoundError, ValidationError } from "~/lib/input.server";
import { closeAccount } from "~/lib/accounts.server";
import { createDraft, requireDraft } from "~/lib/uploads.server";

import { closeTestDatabase, withDatabase } from "./support/database.ts";

afterAll(closeTestDatabase);

const CSV = new TextEncoder().encode("Symbol,Quantity\nVTI,100\n");

/** The refusal a call produced, or a failure if it did not refuse. */
async function refusalOf(run: () => Promise<unknown>): Promise<ValidationError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof ValidationError) return error;
    throw error;
  }
  throw new Error("Expected the write to be refused, and it was not.");
}

describe("createDraft", () => {
  it(
    "stages the file and hands back the address the flow redirects to",
    withDatabase(async ({ db, seedAccount }) => {
      const account = await seedAccount({ kind: "brokerage" });

      const draft = await createDraft(
        { accountId: account.id, filename: "Positions_2026-06-30.csv", bytes: CSV },
        db,
      );

      expect(draft.accountId).toBe(account.id);

      // The row holds everything a later step needs — the bytes byte-exact,
      // and the progress markers still null because no step has been passed.
      const stored = await requireDraft(draft.id, db);
      expect(stored.filename).toBe("Positions_2026-06-30.csv");
      expect(stored.accountName).toBe(account.name);
      expect(Buffer.from(stored.bytes).equals(Buffer.from(CSV))).toBe(true);
      expect(stored.mapping).toBeNull();
      expect(stored.hadFirstSightings).toBeNull();
    }),
  );

  it(
    "keeps a draft exactly 24 hours old and sweeps one a second older",
    withDatabase(async ({ db, seedAccount, seedUploadDraft }) => {
      // "Older than 24 hours" is a strict comparison, pinned at the second.
      // Deterministic because `now()` is fixed for the whole transaction the
      // test runs in: the backdate below and the sweep's own cutoff read the
      // same instant, so "exactly 24 hours" is exact, not racy.
      //
      // The `createDraft` below is also what proves the sweep has no scheduler
      // behind it: staging the next upload is the thing that clears the
      // abandoned one, and the draft on the line survives it.
      const account = await seedAccount({ kind: "brokerage" });
      const onTheLine = await seedUploadDraft({ account });
      const justPast = await seedUploadDraft({ account });

      await db
        .updateTable("upload_draft")
        .set({ created_at: sql`now() - interval '24 hours'` })
        .where("id", "=", onTheLine.id)
        .execute();
      await db
        .updateTable("upload_draft")
        .set({ created_at: sql`now() - interval '24 hours 1 second'` })
        .where("id", "=", justPast.id)
        .execute();

      await createDraft({ accountId: account.id, filename: "next.csv", bytes: CSV }, db);

      await expect(requireDraft(onTheLine.id, db)).resolves.toMatchObject({
        id: onTheLine.id,
      });
      await expect(requireDraft(justPast.id, db)).rejects.toThrow(NotFoundError);
    }),
  );

  it(
    "refuses a closed account in the words setBalance uses, staging nothing",
    withDatabase(async ({ db, seedAccount }) => {
      const account = await seedAccount({ kind: "brokerage", closedAt: "2026-01-01" });

      const refusal = await refusalOf(() =>
        createDraft({ accountId: account.id, filename: "late.csv", bytes: CSV }, db),
      );
      expect(refusal.fieldErrors.form).toMatch(/closed account's history does not change/);

      const drafts = await db.selectFrom("upload_draft").select("id").execute();
      expect(drafts).toHaveLength(0);
    }),
  );

  it(
    "is a 404, not a validation failure, for an id that names no account",
    withDatabase(async ({ db }) => {
      await expect(
        createDraft({ accountId: "999999", filename: "x.csv", bytes: CSV }, db),
      ).rejects.toThrow(NotFoundError);
    }),
  );
});

describe("requireDraft", () => {
  it(
    "answers the expired-or-recorded sentence for an id with no row behind it",
    withDatabase(async ({ db }) => {
      await expect(requireDraft("999999", db)).rejects.toThrow(
        /expired or was already recorded/,
      );
    }),
  );

  it(
    "treats a draft on an account closed since as expired",
    withDatabase(async ({ db, seedAccount, seedUploadDraft }) => {
      const account = await seedAccount({ kind: "brokerage" });
      const draft = await seedUploadDraft({ account });

      await expect(requireDraft(draft.id, db)).resolves.toMatchObject({ id: draft.id });

      // Closed through the domain function, exactly as Settings closes one.
      await closeAccount(account.id, { confirmClose: "true" }, db);

      await expect(requireDraft(draft.id, db)).rejects.toThrow(NotFoundError);
    }),
  );

  it(
    "answers the same 404 for an id that is not an id, never a driver error",
    withDatabase(async ({ db }) => {
      // "abc" reaching Postgres would fail as a malformed bigint — a 500
      // wearing a bookmark, on a URL anyone can mistype.
      await expect(requireDraft("abc", db)).rejects.toThrow(NotFoundError);
      await expect(requireDraft("", db)).rejects.toThrow(NotFoundError);
    }),
  );
});
