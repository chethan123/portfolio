/**
 * The saved column mapping and its fingerprint (spec 0004, step 03).
 *
 * The fingerprint tests are pure: the whole point of hashing a canonical form
 * is that the answer is a property of the header's meaning, not of the
 * process that computed it, so the expected values are pinned as literal hex.
 * The database tests run against real Postgres because what is at risk lives
 * there — the unique constraint the upsert leans on, the `jsonb` round trip,
 * and the byte-exact `collate "C"` lookup a fake would fake.
 */
import { afterAll, describe, expect, it } from "vitest";

import {
  findMapping,
  headerFingerprint,
  upsertMapping,
} from "~/lib/column-mapping.server";
import { readCsv } from "~/lib/csv";
import { NotFoundError } from "~/lib/input.server";
import { unresolvedStrings } from "~/lib/instrument-resolution.server";
import { requireDraft, saveMapping } from "~/lib/uploads.server";

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

/**
 * Plant an alias row directly. The domain writer is step 04's resolution
 * screen and does not exist yet; until it does, this file is the one place
 * that knows the column names, the way `fixtures.ts` is for everything else.
 */
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
    // Pinned so a quiet change to the canonical form — a different joiner, a
    // missing trim — fails a test rather than orphaning every saved mapping.
    expect(first).toBe("f3b3990424ba254f0f85cf91e4f84ca6ca6d9dd5c9f1347e0154fd8f88ace3d9");
  });

  it("ignores case, padding and internal spacing, which never change what a column means", () => {
    const plain = headerFingerprint(["Symbol", "Quantity", "Average Cost Basis"]);

    expect(headerFingerprint(["  symbol ", "QUANTITY", "average cost basis"])).toBe(plain);
    expect(headerFingerprint(["SyMbOl", " quantity  ", "Average   Cost\tBasis"])).toBe(plain);
  });

  it("keeps a separator between cells, so cell boundaries are part of the identity", () => {
    // Joined with U+001F, not concatenated: without a separator these two
    // headers would canonicalise to the same "abc" and share every saved
    // mapping between two files whose columns are nothing alike.
    expect(headerFingerprint(["ab", "c"])).not.toBe(headerFingerprint(["a", "bc"]));
  });

  it("distinguishes the same columns in a different order, deliberately", () => {
    // A reordered export costs one re-map, which is cheaper than a mapping
    // that silently follows a column that moved.
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
      // The scope is the pair: another institution's identical header is not
      // this answer, and neither is this institution's different header.
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

      // A row that predates a shape change, or was written by hand: the
      // screen must open unfilled, never 500 on the way to letting the
      // reader map the file again.
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
      // The first upload: a preamble, then the header the mapping was built
      // against, then that quarter's data.
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

      // Next quarter's export: different data, and the brokerage retitled the
      // header cells' case and padding — which changes no column's meaning.
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

describe("saveMapping", () => {
  it(
    "writes the mapping onto the draft, where a later step reads it back",
    withDatabase(async ({ db, seedAccount, seedUploadDraft }) => {
      const account = await seedAccount({ kind: "brokerage" });
      const draft = await seedUploadDraft({ account });

      await saveMapping(draft.id, MAPPING, db);

      const stored = await requireDraft(draft.id, db);
      expect(stored.mapping).toEqual(MAPPING);
    }),
  );

  it(
    "records whether this mapping's parse raised any first sighting",
    withDatabase(async ({ db, seedAccount, seedUploadDraft, seedInstrument }) => {
      // The one moment the answer exists: after the instruments step writes
      // the aliases, nothing can tell "skipped" from "resolved" — an alias
      // does not say which draft wrote it. The review screen's step strip
      // dims its entry off this bit (ingest brief §2.1, §7.5).
      const account = await seedAccount({ kind: "brokerage" });
      const instrument = await seedInstrument({ symbol: "VTI" });
      await plantAlias(db, instrument, "VTI");

      const simple: StatementMapping = {
        ...MAPPING,
        headerRow: 0,
        columns: { instrument: "Symbol", quantity: "Quantity" },
      };

      const sightings = await seedUploadDraft({
        account,
        bytes: new TextEncoder().encode("Symbol,Quantity\nVTI,100\nNEVER SEEN,50\n"),
      });
      await saveMapping(sightings.id, simple, db);
      expect((await requireDraft(sightings.id, db)).hadFirstSightings).toBe(true);

      const quiet = await seedUploadDraft({
        account,
        bytes: new TextEncoder().encode("Symbol,Quantity\nVTI,100\n"),
      });
      await saveMapping(quiet.id, simple, db);
      expect((await requireDraft(quiet.id, db)).hadFirstSightings).toBe(false);
    }),
  );

  it(
    "leaves the bit undecided for a mapping that does not parse clean",
    withDatabase(async ({ db, seedAccount, seedUploadDraft }) => {
      const account = await seedAccount({ kind: "brokerage" });
      const draft = await seedUploadDraft({
        account,
        bytes: new TextEncoder().encode("Symbol,Quantity\nVTI,100\n"),
      });

      // MAPPING's header row 2 points past this file: problems, so no columns
      // step has genuinely passed and no skip claim may be made.
      await saveMapping(draft.id, MAPPING, db);
      expect((await requireDraft(draft.id, db)).hadFirstSightings).toBeNull();
    }),
  );

  it(
    "refuses a draft that is gone with the same 404 every dead draft URL gets",
    withDatabase(async ({ db }) => {
      await expect(saveMapping("999999", MAPPING, db)).rejects.toThrow(NotFoundError);
    }),
  );
});

describe("unresolvedStrings", () => {
  it(
    "matches byte-exactly, so a case or padding difference is a miss",
    withDatabase(async ({ db, seedInstrument }) => {
      const instrument = await seedInstrument({ symbol: "VTI" });
      await plantAlias(db, instrument, "VTI");

      await expect(
        unresolvedStrings(["VTI", "vti", "VTI ", " VTI"], db),
      ).resolves.toEqual(["vti", "VTI ", " VTI"]);
    }),
  );

  it(
    "answers nothing for a file whose every string is already vocabulary",
    withDatabase(async ({ db, seedInstrument }) => {
      const instrument = await seedInstrument({ symbol: "VTI" });
      await plantAlias(db, instrument, "VTI");
      await plantAlias(db, instrument, "Vanguard Total Stock Market ETF");

      await expect(
        unresolvedStrings(["VTI", "Vanguard Total Stock Market ETF", "VTI"], db),
      ).resolves.toEqual([]);
    }),
  );

  it(
    "keeps first-appearance order and collapses repeats, the order the screen asks in",
    withDatabase(async ({ db }) => {
      await expect(
        unresolvedStrings(["BND", "VTI", "BND", "AAPL", "VTI"], db),
      ).resolves.toEqual(["BND", "VTI", "AAPL"]);
    }),
  );

  it(
    "resolves an empty input to an empty list",
    withDatabase(async ({ db }) => {
      await expect(unresolvedStrings([], db)).resolves.toEqual([]);
    }),
  );
});
