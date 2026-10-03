// Where a draft resumes is decided by parseDraft's single-account step machine; the route matrix
// (routes/upload-wizard.test.ts) pins only where each route places the redirect.
// Multi-account arms: tests/multi-account-upload.test.ts:552-628 and spec 0030's router table.
import { afterAll, expect, it } from "vitest";

import { parseDraft, requireDraft } from "~/lib/uploads.server";

import { closeTestDatabase, withDatabase } from "./support/database.ts";

import type { StatementMapping } from "~/lib/statement";

afterAll(closeTestDatabase);

const MAPPING: StatementMapping = {
  headerRow: 0,
  delimiter: ",",
  columns: { instrument: "Symbol", quantity: "Quantity" },
  costBasisIs: "per_share",
  owedAsPositive: false,
  combineDuplicateRows: true,
};

const encode = (text: string) => new TextEncoder().encode(text);

const CSV = encode(["Symbol,Quantity,Basis", "VTI,100,40"].join("\n"));
const BLANK_INSTRUMENT_CSV = encode(["Symbol,Quantity,Basis", ",100,40"].join("\n"));

type Row = {
  name: string;
  bytes: Uint8Array;
  mapping?: StatementMapping;
  aliased?: boolean;
  expected: object;
};

const rows: Row[] = [
  {
    name: "sends a draft with no saved mapping to columns with no problems",
    bytes: CSV,
    expected: { step: "columns", problems: [] },
  },
  {
    name: "sends a single-account draft whose saved mapping is a multi-account one to columns with no problems",
    bytes: CSV,
    mapping: { ...MAPPING, multiAccount: true },
    expected: { step: "columns", problems: [] },
  },
  {
    name: "sends a draft whose saved mapping the file now fails on a blank instrument to columns with that problem",
    bytes: BLANK_INSTRUMENT_CSV,
    mapping: MAPPING,
    expected: { step: "columns", problems: [expect.objectContaining({ code: "blank-instrument" })] },
  },
  {
    name: "sends a draft with a string no alias answers to instruments, naming it",
    bytes: CSV,
    mapping: MAPPING,
    expected: { step: "instruments", unresolved: ["VTI"] },
  },
  {
    name: "leaves a draft whose every string is aliased with no step owed",
    bytes: CSV,
    mapping: MAPPING,
    aliased: true,
    expected: { step: null },
  },
];

it.each(rows)("$name", ({ bytes, mapping, aliased, expected }) =>
  withDatabase(async ({ db, seedAccount, seedInstrument, seedInstrumentAlias, seedUploadDraft }) => {
    const account = await seedAccount({ kind: "brokerage" });
    if (aliased === true) {
      const instrument = await seedInstrument({ symbol: "VTI", name: "Vanguard Total Stock" });
      await seedInstrumentAlias({ instrument, rawString: "VTI" });
    }
    const seeded = await seedUploadDraft({ account, bytes, mapping });

    const draft = await requireDraft(seeded.id, db);

    expect(await parseDraft(draft, db)).toMatchObject(expected);
  })(),
);
