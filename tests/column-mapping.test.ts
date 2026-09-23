// Saved column mapping and its fingerprint (spec 0004, step 03). Fingerprint tests are pure —
// hashing a canonical form makes the answer a property of the header's meaning, so values are
// pinned as literal hex. Database tests use real Postgres: unique constraint, jsonb round trip,
// byte-exact collate "C" lookup.
import { afterAll, describe, expect, it } from "vitest";

import { sql } from "kysely";

import {
  findMapping,
  headerFingerprint,
  upsertMapping,
} from "~/lib/column-mapping.server";
import { readCsv } from "~/lib/csv";
import { NotFoundError, ValidationError } from "~/lib/input.server";
import { resolveAll } from "~/lib/instrument-resolution.server";
import { rememberMapping, requireDraft } from "~/lib/uploads.server";

import { closeTestDatabase, withDatabase } from "./support/database.ts";

import type { SeededInstrument } from "./support/fixtures.ts";
import type { Database } from "~/lib/db.server";
import type { StatementMapping } from "~/lib/statement";
import type { Kysely } from "kysely";

afterAll(closeTestDatabase);

/** A complete, valid mapping — the shape both `jsonb` columns store. */
const MAPPING: StatementMapping = {
  headerRow: 2,
  delimiter: ",",
  columns: {
    instrument: "Symbol",
    quantity: "Quantity",
    name: "Description",
    costBasis: "Average Cost Basis",
    asOf: null,
    accountNumber: null,
  },
  costBasisIs: "per_share",
  owedAsPositive: false,
  combineDuplicateRows: true,
};

/** Plants an alias row directly — duplicates fixtures.ts's seedInstrumentAlias, predates it, never moved over. */
async function plantAlias(
  db: Kysely<Database>,
  instrument: SeededInstrument,
  rawString: string,
): Promise<void> {
  await db
    .insertInto("instrument_alias")
    .values({ raw_string: rawString, instrument_id: instrument.id })
    .execute();
}

describe("headerFingerprint", () => {
  it("computes a stable, pinned digest for a header, however often it is asked", () => {
    const first = headerFingerprint(["Symbol", "Quantity"]);
    const second = headerFingerprint(["Symbol", "Quantity"]);

    expect(first).toBe(second);
    // Pinned so a quiet canonicalization change (joiner, missing trim) fails a test
    // instead of orphaning every saved mapping.
    expect(first).toBe("f3b3990424ba254f0f85cf91e4f84ca6ca6d9dd5c9f1347e0154fd8f88ace3d9");
  });

  it("ignores case, padding and internal spacing, which never change what a column means", () => {
    const plain = headerFingerprint(["Symbol", "Quantity", "Average Cost Basis"]);

    expect(headerFingerprint(["  symbol ", "QUANTITY", "average cost basis"])).toBe(plain);
    expect(headerFingerprint(["SyMbOl", " quantity  ", "Average   Cost\tBasis"])).toBe(plain);
  });

  it("keeps a separator between cells, so cell boundaries are part of the identity", () => {
    // Joined with U+001F, not concatenated — without it these canonicalise to the same "abc".
    expect(headerFingerprint(["ab", "c"])).not.toBe(headerFingerprint(["a", "bc"]));
  });

  it("distinguishes the same columns in a different order, deliberately", () => {
    expect(headerFingerprint(["Symbol", "Quantity"])).not.toBe(
      headerFingerprint(["Quantity", "Symbol"]),
    );
  });

  it("covers the header row only, so two files differing in data fingerprint the same", () => {
    const june = readCsv(
      new TextEncoder().encode("Symbol,Quantity\nVTI,145.234\nBND,210.000\n"),
    );
    const september = readCsv(
      new TextEncoder().encode("Symbol,Quantity\nVTI,156.234\nAAPL,50.000\nFXNAX,1112.400\n"),
    );

    expect(headerFingerprint(june.rows[0] ?? [])).toBe(
      headerFingerprint(september.rows[0] ?? []),
    );
  });
});

describe("findMapping and upsertMapping", () => {
  it(
    "remembers a mapping per institution and header fingerprint, and only there",
    withDatabase(async ({ db }) => {
      const fingerprint = headerFingerprint(["Symbol", "Quantity"]);

      await upsertMapping("Fidelity", fingerprint, MAPPING, db);

      await expect(findMapping("Fidelity", fingerprint, db)).resolves.toEqual(MAPPING);
      await expect(findMapping("Schwab", fingerprint, db)).resolves.toBeNull();
      await expect(
        findMapping("Fidelity", headerFingerprint(["Quantity", "Symbol"]), db),
      ).resolves.toBeNull();
    }),
  );

  it(
    "replaces a corrected mapping in place rather than accumulating a second row",
    withDatabase(async ({ db }) => {
      const fingerprint = headerFingerprint(["Symbol", "Qty", "Quantity"]);
      const corrected: StatementMapping = {
        ...MAPPING,
        columns: { ...MAPPING.columns, quantity: "Qty" },
      };

      await upsertMapping("Fidelity", fingerprint, MAPPING, db);
      await upsertMapping("Fidelity", fingerprint, corrected, db);

      await expect(findMapping("Fidelity", fingerprint, db)).resolves.toEqual(corrected);

      const rows = await db
        .selectFrom("column_mapping")
        .select("id")
        .where("institution", "=", "Fidelity")
        .where("header_fingerprint", "=", fingerprint)
        .execute();
      expect(rows).toHaveLength(1);
    }),
  );

  it(
    "reads a malformed stored mapping as null rather than throwing",
    withDatabase(async ({ db }) => {
      const fingerprint = headerFingerprint(["Symbol", "Quantity"]);

      await upsertMapping(
        "Fidelity",
        fingerprint,
        { headerRow: "three", columns: {} } as unknown as StatementMapping,
        db,
      );

      await expect(findMapping("Fidelity", fingerprint, db)).resolves.toBeNull();
    }),
  );

  it(
    "auto-applies across files: a later export with the same header finds the saved mapping",
    withDatabase(async ({ db }) => {
      const first = readCsv(
        new TextEncoder().encode(
          "Account positions as of 06/30/2026\n\n" +
            "Symbol,Description,Quantity,Average Cost Basis\n" +
            "VTI,Vanguard Total Stock Market ETF,145.234,$424.12\n",
        ),
      );
      await upsertMapping(
        "Fidelity",
        headerFingerprint(first.rows[2] ?? []),
        MAPPING,
        db,
      );

      const second = readCsv(
        new TextEncoder().encode(
          "Account positions as of 09/30/2026\n\n" +
            " SYMBOL ,description,QUANTITY,Average  Cost Basis\n" +
            "VTI,Vanguard Total Stock Market ETF,156.234,$424.12\n" +
            "BND,Vanguard Total Bond Market ETF,210.000,$71.05\n",
        ),
      );

      const fingerprint = headerFingerprint(second.rows[2] ?? []);
      expect(fingerprint).toBe(headerFingerprint(first.rows[2] ?? []));
      await expect(findMapping("Fidelity", fingerprint, db)).resolves.toEqual(MAPPING);
    }),
  );
});

// The multi-account scope (spec 0023 decision 4): a mapping saved by header fingerprint alone,
// separate from every institution's own scope for the same header (migration 0016's two partial
// indexes).
describe("the multi-account mapping scope", () => {
  it(
    "saves and re-applies a mapping by fingerprint alone, under a null institution",
    withDatabase(async ({ db }) => {
      const fingerprint = headerFingerprint(["Symbol", "Quantity"]);

      await upsertMapping(null, fingerprint, MAPPING, db);

      await expect(findMapping(null, fingerprint, db)).resolves.toEqual(MAPPING);
    }),
  );

  it(
    "is neither found by nor overwritten by an institution mapping with the same header, and vice versa",
    withDatabase(async ({ db }) => {
      const fingerprint = headerFingerprint(["Symbol", "Quantity"]);
      const multi: StatementMapping = {
        ...MAPPING,
        columns: { ...MAPPING.columns, accountNumber: "Symbol" },
      };

      await upsertMapping("Fidelity", fingerprint, MAPPING, db);
      await upsertMapping(null, fingerprint, multi, db);

      await expect(findMapping("Fidelity", fingerprint, db)).resolves.toEqual(MAPPING);
      await expect(findMapping(null, fingerprint, db)).resolves.toEqual(multi);

      const rows = await db
        .selectFrom("column_mapping")
        .select(["institution", "header_fingerprint"])
        .where("header_fingerprint", "=", fingerprint)
        .execute();
      expect(rows).toHaveLength(2);
    }),
  );

  it(
    "replaces a corrected multi-account mapping in place rather than accumulating a second row",
    withDatabase(async ({ db }) => {
      const fingerprint = headerFingerprint(["Symbol", "Qty", "Quantity"]);
      const corrected: StatementMapping = {
        ...MAPPING,
        columns: { ...MAPPING.columns, quantity: "Qty" },
      };

      await upsertMapping(null, fingerprint, MAPPING, db);
      await upsertMapping(null, fingerprint, corrected, db);

      await expect(findMapping(null, fingerprint, db)).resolves.toEqual(corrected);

      const rows = await db
        .selectFrom("column_mapping")
        .select("id")
        .where("institution", "is", null)
        .where("header_fingerprint", "=", fingerprint)
        .execute();
      expect(rows).toHaveLength(1);
    }),
  );
});

describe("rememberMapping", () => {
  /** A mapping over the two-column files these tests hand it. */
  const SIMPLE: StatementMapping = {
    ...MAPPING,
    headerRow: 0,
    columns: { instrument: "Symbol", quantity: "Quantity" },
  };

  it(
    "counts the draft's own answers as sightings on a walk back to columns, sending the reader to review",
    withDatabase(async ({ db, seedAccount, seedUploadDraft, seedInstrument }) => {
      // Re-saving the mapping after answering must not turn "passed" into "skipped" on the strip.
      const account = await seedAccount({ kind: "brokerage" });
      const vti = await seedInstrument({ symbol: "VTI" });
      const draft = await seedUploadDraft({
        account,
        bytes: new TextEncoder().encode("Symbol,Quantity\nNEVER SEEN,50\n"),
      });
      await rememberMapping(draft.id, SIMPLE, db);
      await resolveAll(
        draft.id,
        [{ raw: "NEVER SEEN", fields: { kind: "existing", instrumentId: vti.id } }],
        { probe: async () => new Map() },
        db,
      );

      await expect(rememberMapping(draft.id, SIMPLE, db)).resolves.toEqual({ nextStep: "review" });
      expect((await requireDraft(draft.id, db)).hadFirstSightings).toBe(true);
    }),
  );

  it(
    "sends the reader to the step it just wrote onto the draft, both ways round",
    withDatabase(async ({ db, seedAccount, seedUploadDraft, seedInstrument }) => {
      // Bug this replaces: bit and redirect from two separate reads could disagree if an
      // alias landed between them.
      const account = await seedAccount({ kind: "brokerage" });
      const instrument = await seedInstrument({ symbol: "VTI" });
      await plantAlias(db, instrument, "VTI");

      const sightings = await seedUploadDraft({
        account,
        bytes: new TextEncoder().encode("Symbol,Quantity\nVTI,100\nNEVER SEEN,50\n"),
      });
      await expect(rememberMapping(sightings.id, SIMPLE, db)).resolves.toEqual({
        nextStep: "instruments",
      });
      expect((await requireDraft(sightings.id, db)).hadFirstSightings).toBe(true);

      const quiet = await seedUploadDraft({
        account,
        bytes: new TextEncoder().encode("Symbol,Quantity\nVTI,100\n"),
      });
      await expect(rememberMapping(quiet.id, SIMPLE, db)).resolves.toEqual({
        nextStep: "review",
      });
      expect((await requireDraft(quiet.id, db)).hadFirstSightings).toBe(false);

      expect((await requireDraft(quiet.id, db)).mapping).toEqual(SIMPLE);
    }),
  );

  it(
    "hands back row problems when an empty instrument column has mapped quantity data",
    withDatabase(async ({ db, seedAccount, seedUploadDraft }) => {
      const account = await seedAccount({ kind: "brokerage" });
      const draft = await seedUploadDraft({
        account,
        bytes: new TextEncoder().encode("Symbol,Quantity\n,100\n,50\n"),
      });

      const outcome = await rememberMapping(draft.id, SIMPLE, db);

      if (!("problems" in outcome)) throw new Error("The invalid rows passed Columns.");
      expect(outcome.problems).toHaveLength(2);
      expect(outcome.problems.map((problem) => problem.row)).toEqual([1, 2]);
      expect(outcome.problems.every((problem) => problem.code === "blank-instrument")).toBe(true);
      expect((await requireDraft(draft.id, db)).mapping).toBeNull();
    }),
  );

  it(
    "refuses an instrument column empty on every genuinely empty data row",
    withDatabase(async ({ db, seedAccount, seedUploadDraft }) => {
      const account = await seedAccount({ kind: "brokerage" });
      const draft = await seedUploadDraft({
        account,
        bytes: new TextEncoder().encode("Symbol,Quantity\n,\n,\n"),
      });

      let refusal: ValidationError | null = null;
      try {
        await rememberMapping(draft.id, SIMPLE, db);
      } catch (error) {
        if (!(error instanceof ValidationError)) throw error;
        refusal = error;
      }

      expect(refusal?.fieldErrors.instrument).toMatch(/"Symbol"/);
      expect((await requireDraft(draft.id, db)).mapping).toBeNull();
    }),
  );

  it(
    "hands back the parse's problems as they are, and writes nothing",
    withDatabase(async ({ db, seedAccount, seedUploadDraft }) => {
      const account = await seedAccount({ kind: "brokerage" });
      const draft = await seedUploadDraft({
        account,
        bytes: new TextEncoder().encode("Symbol,Quantity\nVTI,not a number\n"),
      });

      const outcome = await rememberMapping(draft.id, SIMPLE, db);

      expect("problems" in outcome).toBe(true);
      const problems = "problems" in outcome ? outcome.problems : [];
      expect(problems).toHaveLength(1);
      expect(problems[0]?.column).toBe("Quantity");
      expect(problems[0]?.row).toBe(1);

      const stored = await requireDraft(draft.id, db);
      expect(stored.mapping).toBeNull();
      expect(stored.hadFirstSightings).toBeNull();
    }),
  );

  it(
    "remembers the mapping for the institution, under its own header's fingerprint",
    withDatabase(async ({ db, seedAccount, seedUploadDraft }) => {
      const account = await seedAccount({ kind: "brokerage", institution: "Fidelity" });
      const draft = await seedUploadDraft({
        account,
        bytes: new TextEncoder().encode("Symbol,Quantity\nVTI,100\n"),
      });

      await rememberMapping(draft.id, SIMPLE, db);

      const fingerprint = headerFingerprint(["Symbol", "Quantity"]);
      await expect(findMapping("Fidelity", fingerprint, db)).resolves.toEqual(SIMPLE);
    }),
  );

  it(
    "remembers a multi-account draft's mapping under the multi-account scope, not any institution's",
    withDatabase(async ({ db, seedAccount, seedUploadDraft }) => {
      await seedAccount({ externalAccountNumber: "A-1" });
      const draft = await seedUploadDraft({
        account: null,
        bytes: new TextEncoder().encode("Symbol,Quantity,Acct\nVTI,100,A-1\n"),
      });
      const multi: StatementMapping = {
        ...SIMPLE,
        columns: { ...SIMPLE.columns, accountNumber: "Acct" },
        multiAccount: true,
      };

      await expect(rememberMapping(draft.id, multi, db)).resolves.toEqual({
        nextStep: "instruments",
      });

      const fingerprint = headerFingerprint(["Symbol", "Quantity", "Acct"]);
      await expect(findMapping(null, fingerprint, db)).resolves.toEqual(multi);
      await expect(findMapping("Test Institution", fingerprint, db)).resolves.toBeNull();
    }),
  );

  it(
    "refuses a mapping made for the other kind of draft, writing nothing",
    withDatabase(async ({ db, seedAccount, seedUploadDraft }) => {
      const bytes = new TextEncoder().encode("Symbol,Quantity,Acct\nVTI,100,A-1\n");
      const multi: StatementMapping = {
        ...SIMPLE,
        columns: { ...SIMPLE.columns, accountNumber: "Acct" },
        multiAccount: true,
      };
      const several = await seedUploadDraft({ account: null, bytes });
      const one = await seedUploadDraft({ account: await seedAccount(), bytes });

      for (const [draft, mapping] of [
        [several, SIMPLE],
        [one, multi],
      ] as const) {
        await expect(rememberMapping(draft.id, mapping, db)).rejects.toMatchObject({
          fieldErrors: { form: expect.stringContaining("a different kind of upload") },
        });
        expect((await requireDraft(draft.id, db)).mapping).toBeNull();
      }
      const fingerprint = headerFingerprint(["Symbol", "Quantity", "Acct"]);
      await expect(findMapping(null, fingerprint, db)).resolves.toBeNull();
      await expect(findMapping("Test Institution", fingerprint, db)).resolves.toBeNull();
    }),
  );

  it(
    "does not remember a losing Columns save as the institution default",
    withDatabase(async ({ db, seedAccount, seedUploadDraft }) => {
      const account = await seedAccount({ kind: "brokerage", institution: "Race Broker" });
      const draft = await seedUploadDraft({
        account,
        bytes: new TextEncoder().encode("Symbol,Quantity\nVTI,100\n"),
      });

      await sql.raw(`
        create function refuse_mapping_update() returns trigger language plpgsql as $$
        begin
          return null;
        end
        $$
      `).execute(db);
      await sql.raw(`
        create trigger refuse_mapping_update
        before update on upload_draft
        for each row
        when (old.id = ${draft.id})
        execute function refuse_mapping_update()
      `).execute(db);

      await expect(rememberMapping(draft.id, SIMPLE, db)).rejects.toThrow(NotFoundError);

      const fingerprint = headerFingerprint(["Symbol", "Quantity"]);
      await expect(findMapping("Race Broker", fingerprint, db)).resolves.toBeNull();
      expect((await requireDraft(draft.id, db)).mapping).toBeNull();
    }),
  );

  it(
    "refuses a draft that is gone with the same 404 every dead draft URL gets",
    withDatabase(async ({ db }) => {
      await expect(rememberMapping("999999", MAPPING, db)).rejects.toThrow(NotFoundError);
    }),
  );
});
