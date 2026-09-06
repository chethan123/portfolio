// upload draft lifecycle (DESIGN.md §5.1, docs/specs/0004-ingest.md) — against real Postgres, since the risk is in the database
import { afterAll, describe, expect, it } from "vitest";

import { sql } from "kysely";

import { NotFoundError, ValidationError } from "~/lib/input.server";
import { closeAccount } from "~/lib/accounts.server";
import { createDraft, requireDraft } from "~/lib/uploads.server";

import { closeTestDatabase, withDatabase } from "./support/database.ts";

afterAll(closeTestDatabase);

const CSV = new TextEncoder().encode("Symbol,Quantity\nVTI,100\n");

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

      await closeAccount(account.id, { confirmClose: "true" }, db);

      await expect(requireDraft(draft.id, db)).rejects.toThrow(NotFoundError);
    }),
  );

  it(
    "answers the same 404 for an id that is not an id, never a driver error",
    withDatabase(async ({ db }) => {
      // "abc" reaching Postgres would fail as a malformed bigint — a 500 wearing a bookmark
      await expect(requireDraft("abc", db)).rejects.toThrow(NotFoundError);
      await expect(requireDraft("", db)).rejects.toThrow(NotFoundError);
    }),
  );
});
