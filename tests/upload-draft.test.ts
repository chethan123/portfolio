// upload draft lifecycle (DESIGN.md §5.1, docs/specs/0004-ingest.md) — against real Postgres, since the risk is in the database
import { afterAll, describe, expect, it } from "vitest";

import { sql } from "kysely";

import { NotFoundError, ValidationError } from "~/lib/input.server";
import { closeAccount } from "~/lib/accounts.server";
import { resolveAll, unresolvedStrings } from "~/lib/instrument-resolution.server";
import {
  commitUpload,
  createDraft,
  diffForDraft,
  recordUpload,
  rememberMapping,
  requireDraft,
} from "~/lib/uploads.server";

import { closeTestDatabase, withDatabase } from "./support/database.ts";

import type { StatementMapping } from "~/lib/statement";

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
    "sweeps an abandoned draft's first-sighting answers with it, leaving no vocabulary behind",
    withDatabase(async ({ db, seedAccount, seedInstrument, seedUploadDraft }) => {
      // Issue #291: the answer was never reviewed against a recorded statement, so it must not outlive its draft.
      const account = await seedAccount({ kind: "brokerage" });
      const vti = await seedInstrument({ symbol: "VTI" });
      const abandoned = await seedUploadDraft({ account });
      await resolveAll(
        abandoned.id,
        [{ raw: "QAALIAS", fields: { kind: "existing", instrumentId: vti.id } }],
        { probe: async () => new Map() },
        db,
      );
      await db
        .updateTable("upload_draft")
        .set({ created_at: sql`now() - interval '25 hours'` })
        .where("id", "=", abandoned.id)
        .execute();

      const next = await createDraft({ accountId: account.id, filename: "next.csv", bytes: CSV }, db);

      expect(await db.selectFrom("upload_draft_answer").select("draft_id").execute()).toEqual([]);
      expect(await db.selectFrom("instrument_alias").select("raw_string").execute()).toEqual([]);
      expect(await unresolvedStrings(["QAALIAS"], next.id, db)).toEqual(["QAALIAS"]);
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

// The multi-account draft (spec 0023, "Loading a draft with no account").
const NUMBERED = new TextEncoder().encode("Symbol,Quantity,Acct\nVTI,100,A-1\n");

const SEVERAL: StatementMapping = {
  headerRow: 0,
  delimiter: ",",
  columns: { instrument: "Symbol", quantity: "Quantity", accountNumber: "Acct" },
  costBasisIs: "per_share",
  owedAsPositive: false,
  combineDuplicateRows: true,
  multiAccount: true,
};

describe("a draft with no account", () => {
  it(
    "is created through the domain with a null account id, and requireDraft finds it unexpired with null account fields",
    withDatabase(async ({ db }) => {
      const draft = await createDraft({ accountId: null, filename: "multi.csv", bytes: CSV }, db);
      expect(draft.accountId).toBeNull();

      await expect(requireDraft(draft.id, db)).resolves.toMatchObject({
        id: draft.id,
        accountId: null,
        accountName: null,
        ownerName: null,
        accountNumberTail: null,
      });
    }),
  );

  it(
    "is found by seedUploadDraft's account: null too, with the same null fields",
    withDatabase(async ({ db, seedUploadDraft }) => {
      const draft = await seedUploadDraft({ account: null, bytes: CSV });
      expect(draft.accountId).toBeNull();

      await expect(requireDraft(draft.id, db)).resolves.toMatchObject({
        accountId: null,
        accountName: null,
        ownerName: null,
      });
    }),
  );

  it(
    "is diffed once its columns are mapped, one section per account its numbers name, describing no account itself",
    withDatabase(async ({ db, seedAccount, seedInstrument, seedInstrumentAlias, seedUploadDraft }) => {
      const account = await seedAccount({ externalAccountNumber: "A-1" });
      const vti = await seedInstrument({ symbol: "VTI" });
      await seedInstrumentAlias({ instrument: vti, rawString: "VTI" });
      const draft = await seedUploadDraft({ account: null, bytes: NUMBERED });

      await expect(rememberMapping(draft.id, SEVERAL, db)).resolves.toEqual({ nextStep: "review" });

      const diff = await diffForDraft(draft.id, db);
      expect(diff).toMatchObject({ accountId: null, accountName: null, added: [] });
      expect(diff.accounts?.map((section) => [section.accountId, section.added.length])).toEqual([
        [account.id, 1],
      ]);
    }),
  );

  it(
    "is recorded through recordUpload, never commitUpload's one account, while a gone draft stays a 404 for both",
    withDatabase(async ({ db, seedAccount, seedInstrument, seedInstrumentAlias, seedUploadDraft }) => {
      await seedAccount({ externalAccountNumber: "A-1" });
      const vti = await seedInstrument({ symbol: "VTI" });
      await seedInstrumentAlias({ instrument: vti, rawString: "VTI" });
      const draft = await seedUploadDraft({ account: null, bytes: NUMBERED });
      await rememberMapping(draft.id, SEVERAL, db);

      await expect(commitUpload(draft.id, {}, db)).rejects.toThrow(/recordUpload/);
      await expect(requireDraft(draft.id, db)).resolves.toMatchObject({ id: draft.id });
      await expect(commitUpload("999999", {}, db)).rejects.toThrow(NotFoundError);
      await expect(recordUpload("999999", {}, db)).rejects.toThrow(NotFoundError);
    }),
  );
});
