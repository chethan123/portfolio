// Settings → Instruments, the alias half (DESIGN.md §8.4, issue #291): vocabulary made
// inspectable and repairable. A holding doesn't record which alias resolved it, so a repair never
// rewrites history — it binds the next upload only, and the preview names what stays as recorded
// so the reader can decide which statements to upload again.
import { z } from "zod";

import { sql } from "kysely";

import { readCsv } from "./csv.ts";
import { getDb, type Database } from "./db.server.ts";
import { describeInstrument } from "./format.ts";
import { ValidationError, parseInput } from "./input.server.ts";
import { listInstrumentOptions } from "./instrument-resolution.server.ts";
import { ALL_OWNERS } from "./owner-filter.ts";
import { lineEndings } from "./raw-string.ts";
import { currentHoldings } from "./valuation.server.ts";

import type { InstrumentOption } from "./instrument-resolution.server.ts";
import type { IsoDate } from "./valuation.server.ts";
import type { Kysely } from "kysely";

export type { InstrumentOption };

export type AliasRow = {
  rawString: string;
  instrument: InstrumentOption;
  // Open accounts holding the instrument now — the usage a wrong match may already have reached.
  heldIn: number;
};

export type AliasList = {
  aliases: AliasRow[];
  instruments: InstrumentOption[];
};

type Alias = { rawString: string; instrument: InstrumentOption };

function aliasQuery(db: Kysely<Database>) {
  return db
    .selectFrom("instrument_alias")
    .innerJoin("instrument", "instrument.id", "instrument_alias.instrument_id")
    .select([
      "instrument_alias.raw_string",
      "instrument.id",
      "instrument.symbol",
      "instrument.name",
    ]);
}

type AliasRecord = Awaited<ReturnType<ReturnType<typeof aliasQuery>["execute"]>>[number];

function toAlias(row: AliasRecord): Alias {
  return {
    rawString: row.raw_string,
    instrument: { id: row.id, symbol: row.symbol, name: row.name },
  };
}

// Holdings through the valuation reader (ARCHITECTURE.md §4.2), never a join of this module's own.
async function accountsHolding(db: Kysely<Database>): Promise<Map<string, Set<string>>> {
  const held = new Map<string, Set<string>>();
  for (const holding of await currentHoldings(ALL_OWNERS, db)) {
    const accounts = held.get(holding.instrumentId) ?? new Set<string>();
    accounts.add(holding.accountId);
    held.set(holding.instrumentId, accounts);
  }
  return held;
}

export async function listAliases(db: Kysely<Database> = getDb()): Promise<AliasList> {
  const rows = await aliasQuery(db).orderBy("instrument_alias.raw_string").execute();
  const held = await accountsHolding(db);

  return {
    aliases: rows.map((row) => ({
      ...toAlias(row),
      heldIn: held.get(row.id)?.size ?? 0,
    })),
    instruments: await listInstrumentOptions(db),
  };
}

export type AliasIntent = "repoint" | "forget";

export type AliasChangePreview = {
  intent: AliasIntent;
  rawString: string;
  from: InstrumentOption;
  to: InstrumentOption | null;
  // What the current target is held as now, per open account — not rewritten by the change.
  heldNow: Array<{
    accountId: string;
    accountName: string;
    accountNumberTail: string | null;
    ownerName: string;
    quantity: string;
  }>;
  // Recorded statements whose file carries the string as a cell — the ones to upload again.
  statements: Array<{
    setId: string;
    accountId: string;
    accountName: string;
    asOf: IsoDate;
    filename: string | null;
  }>;
};

export type AliasChangeOutcome =
  | { applied: false; preview: AliasChangePreview }
  | {
      applied: true;
      intent: AliasIntent;
      rawString: string;
      from: InstrumentOption;
      to: InstrumentOption | null;
    };

const CHOOSE_INSTRUMENT = "Choose the instrument this string means.";

const aliasChangeInput = z
  .object({
    intent: z.enum(["repoint", "forget"], {
      message: "Choose whether to repoint this alias or forget it.",
    }),
    rawString: z
      .string({ message: "The alias to change is missing from this form." })
      .min(1, { message: "The alias to change is missing from this form." }),
    // The target the row was drawn with — a confirm posted after another tab changed it is refused.
    fromInstrumentId: z.string().optional(),
    instrumentId: z.string().optional(),
    // "true" once the preview has been read.
    confirm: z.string().optional(),
  })
  .superRefine((input, ctx) => {
    if (input.intent === "repoint" && !/^\d+$/.test((input.instrumentId ?? "").trim())) {
      ctx.addIssue({ code: "custom", path: ["instrumentId"], message: CHOOSE_INSTRUMENT });
    }
  });

// Exact first; then line endings alone (raw-string.ts) — a multi-line cell never posts back
// byte-exact. Where two spellings differ only there, the row the click meant is the one drawn
// with the posted target, and the exact spelling among those.
async function findAlias(
  rawString: string,
  fromInstrumentId: string | undefined,
  db: Kysely<Database>,
): Promise<Alias | undefined> {
  const candidates = await aliasQuery(db)
    .where((eb) =>
      eb.or([
        eb("instrument_alias.raw_string", "=", rawString),
        eb(
          sql`regexp_replace(instrument_alias.raw_string, E'\\r\\n?', E'\\n', 'g')`,
          "=",
          lineEndings(rawString),
        ),
      ]),
    )
    .orderBy("instrument_alias.raw_string")
    .execute();

  const drawn = candidates.filter((candidate) => candidate.id === fromInstrumentId);
  const row =
    drawn.find((candidate) => candidate.raw_string === rawString) ??
    drawn[0] ??
    candidates.find((candidate) => candidate.raw_string === rawString) ??
    candidates[0];

  return row === undefined ? undefined : toAlias(row);
}

// Which recorded statements name the string. A byte search narrows the files in SQL, on the
// string as written and as a quoted cell doubles its quotes; the reader then confirms a whole
// cell, so "VTI" inside "VTIAX" is not a mention. Every raw_file arrived through
// parseUploadForm's UTF-8 check, and readCsv tolerates anything else.
async function statementsNaming(
  rawString: string,
  db: Kysely<Database>,
): Promise<AliasChangePreview["statements"]> {
  const spellings = [...new Set([rawString, rawString.replace(/"/g, '""')])].map((spelling) =>
    Buffer.from(spelling, "utf8"),
  );

  const candidates = await db
    .selectFrom("position_set")
    .innerJoin("account", "account.id", "position_set.account_id")
    .select([
      "position_set.id",
      "position_set.account_id",
      "account.name as account_name",
      "position_set.as_of_date",
      "position_set.source_filename",
      "position_set.raw_file",
    ])
    .where("position_set.raw_file", "is not", null)
    .where((eb) =>
      eb.or(
        spellings.map((bytes) => sql<boolean>`position(${bytes} in position_set.raw_file) > 0`),
      ),
    )
    .orderBy("account.name")
    .orderBy("position_set.as_of_date", "desc")
    .orderBy("position_set.created_at", "desc")
    .orderBy("position_set.id", "desc")
    .execute();

  return candidates
    .filter(
      (row) =>
        row.raw_file !== null &&
        readCsv(row.raw_file).rows.some((cells) => cells.includes(rawString)),
    )
    .map((row) => ({
      setId: row.id,
      accountId: row.account_id,
      accountName: row.account_name,
      asOf: row.as_of_date,
      filename: row.source_filename,
    }));
}

async function preview(
  intent: AliasIntent,
  alias: Alias,
  to: InstrumentOption | null,
  db: Kysely<Database>,
): Promise<AliasChangePreview> {
  const heldNow = (await currentHoldings(ALL_OWNERS, db))
    .filter((holding) => holding.instrumentId === alias.instrument.id)
    .map((holding) => ({
      accountId: holding.accountId,
      accountName: holding.accountName,
      accountNumberTail: holding.accountNumberTail,
      ownerName: holding.ownerName,
      quantity: holding.quantity,
    }));

  return {
    intent,
    rawString: alias.rawString,
    from: alias.instrument,
    to,
    heldNow,
    statements: await statementsNaming(alias.rawString, db),
  };
}

const gone = (rawString: string): ValidationError =>
  ValidationError.form(
    `"${rawString}" is not an alias any more — forgotten or repointed from another tab. ` +
      "The list below is current.",
  );

const changed = (alias: Alias): ValidationError =>
  ValidationError.form(
    `"${alias.rawString}" changed while this page was open — it now means ` +
      `${describeInstrument(alias.instrument)}. Check the list below and try again.`,
  );

// Preview until confirmed, then one write. The confirm carries the target the preview was drawn
// against, and the write compares-and-sets on it, so a replayed or stale POST changes nothing
// silently. Forgetting is vocabulary, not history: the next upload naming the string asks again.
export async function changeAlias(
  raw: unknown,
  db: Kysely<Database> = getDb(),
): Promise<AliasChangeOutcome> {
  const input = parseInput(aliasChangeInput, raw);

  const alias = await findAlias(input.rawString, input.fromInstrumentId, db);
  if (alias === undefined) throw gone(input.rawString);
  if (input.fromInstrumentId !== undefined && input.fromInstrumentId !== alias.instrument.id) {
    throw changed(alias);
  }

  let to: InstrumentOption | null = null;

  if (input.intent === "repoint") {
    // Options came from the database, so a miss is a stale or forged post — a sentence, not an FK fault.
    const target = await db
      .selectFrom("instrument")
      .select(["id", "symbol", "name"])
      .where("id", "=", (input.instrumentId ?? "").trim())
      .executeTakeFirst();
    if (target === undefined) throw new ValidationError({ instrumentId: CHOOSE_INSTRUMENT });
    if (target.id === alias.instrument.id) {
      throw new ValidationError({
        instrumentId:
          `"${alias.rawString}" already means ${describeInstrument(target)} — choose a ` +
          "different instrument, or forget the alias so the next upload asks again.",
      });
    }
    to = target;
  }

  if (input.confirm !== "true") {
    return { applied: false, preview: await preview(input.intent, alias, to, db) };
  }

  const written =
    to === null
      ? await db
          .deleteFrom("instrument_alias")
          .where("raw_string", "=", alias.rawString)
          .where("instrument_id", "=", alias.instrument.id)
          .executeTakeFirst()
          .then((result) => result.numDeletedRows)
      : await db
          .updateTable("instrument_alias")
          .set({ instrument_id: to.id })
          .where("raw_string", "=", alias.rawString)
          .where("instrument_id", "=", alias.instrument.id)
          .executeTakeFirst()
          .then((result) => result.numUpdatedRows);

  // Zero rows: the row moved between the read above and the write. Name where it went.
  if (written === 0n) {
    const now = await findAlias(alias.rawString, undefined, db);
    throw now === undefined ? gone(alias.rawString) : changed(now);
  }

  return {
    applied: true,
    intent: input.intent,
    rawString: alias.rawString,
    from: alias.instrument,
    to,
  };
}
