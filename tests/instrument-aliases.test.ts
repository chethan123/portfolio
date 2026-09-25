// Settings → Instruments' alias half (issue #291): the list, the previewed repoint/forget, and
// the guards around the one write. Real Postgres — the cell search reads retained statement
// bytes, and the compare-and-set on the current target is what a stale confirm must hit.
import { afterAll, describe, expect, it } from "vitest";

import { sql } from "kysely";

import { changeAlias, listAliases } from "~/lib/instrument-aliases.server";
import { unresolvedStrings } from "~/lib/instrument-resolution.server";

import { closeTestDatabase, withDatabase } from "./support/database.ts";
import { refusalOf } from "./support/refusal.ts";

import type { TestContext } from "./support/database.ts";

afterAll(closeTestDatabase);

const encode = (text: string) => new TextEncoder().encode(text);

/** The instrument a vocabulary row names, or null when the string is not vocabulary. */
async function meaningOf(rawString: string, db: TestContext["db"]): Promise<string | null> {
  const row = await db
    .selectFrom("instrument_alias")
    .select("instrument_id")
    .where("raw_string", "=", rawString)
    .executeTakeFirst();
  return row?.instrument_id ?? null;
}

/** The audit's shape: QAALIAS matched to VTI, held in one account, named by one recorded file. */
async function aWrongMatch(ctx: TestContext) {
  const owner = await ctx.seedPerson({ name: "Alice" });
  const brokerage = await ctx.seedAccount({ name: "Brokerage", owner, kind: "brokerage" });
  const vti = await ctx.seedInstrument({ symbol: "VTI", name: "Vanguard Total Stock Market" });
  const vxus = await ctx.seedInstrument({ symbol: "VXUS", name: "Vanguard Total International" });
  await ctx.seedInstrumentAlias({ instrument: vti, rawString: "QAALIAS" });
  await ctx.seedPositionSet({
    account: brokerage,
    asOf: "2026-06-30",
    sourceFilename: "June.csv",
    rawFile: encode("Symbol,Quantity\nQAALIAS,1\n"),
    holdings: [{ instrument: vti, quantity: "1" }],
  });
  return { brokerage, vti, vxus };
}

describe("listAliases", () => {
  it(
    "lists every name with the instrument it means and how many open accounts hold that instrument",
    withDatabase(async (ctx) => {
      const { vti, vxus } = await aWrongMatch(ctx);
      const roth = await ctx.seedAccount({ name: "Roth", kind: "ira" });
      const closed = await ctx.seedAccount({ name: "Old", kind: "brokerage", closedAt: "2026-01-01" });
      await ctx.seedInstrumentAlias({ instrument: vti, rawString: "VTI" });
      await ctx.seedInstrumentAlias({ instrument: vxus, rawString: "VXUS" });
      await ctx.seedPositionSet({
        account: roth,
        asOf: "2026-06-30",
        holdings: [{ instrument: vti, quantity: "5" }],
      });
      // A closed account holds nothing now (holding_valued), so it is not usage a repair would reach.
      await ctx.seedPositionSet({
        account: closed,
        asOf: "2025-06-30",
        holdings: [{ instrument: vxus, quantity: "5" }],
      });

      const { aliases, instruments } = await listAliases(ctx.db);

      expect(aliases).toEqual([
        {
          rawString: "QAALIAS",
          instrument: { id: vti.id, symbol: "VTI", name: "Vanguard Total Stock Market" },
          heldIn: 2,
        },
        {
          rawString: "VTI",
          instrument: { id: vti.id, symbol: "VTI", name: "Vanguard Total Stock Market" },
          heldIn: 2,
        },
        {
          rawString: "VXUS",
          instrument: { id: vxus.id, symbol: "VXUS", name: "Vanguard Total International" },
          heldIn: 0,
        },
      ]);
      expect(instruments.map((instrument) => instrument.id)).toEqual(
        expect.arrayContaining([vti.id, vxus.id]),
      );
    }),
  );
});

describe("changeAlias — the preview", () => {
  it(
    "names what stays recorded under the old instrument and which statements name the string, writing nothing",
    withDatabase(async (ctx) => {
      const { brokerage, vti, vxus } = await aWrongMatch(ctx);
      // A file naming VTIAX contains the bytes of "VTI" and names no such cell.
      const other = await ctx.seedAccount({ name: "Roth", kind: "ira" });
      await ctx.seedInstrumentAlias({ instrument: vti, rawString: "VTI" });
      await ctx.seedPositionSet({
        account: other,
        asOf: "2026-06-30",
        sourceFilename: "Roth.csv",
        rawFile: encode("Symbol,Quantity\nVTIAX,3\n"),
        holdings: [{ instrument: vti, quantity: "3" }],
      });

      const outcome = await changeAlias(
        { intent: "repoint", rawString: "VTI", instrumentId: vxus.id },
        ctx.db,
      );

      expect(outcome).toEqual({
        applied: false,
        preview: {
          intent: "repoint",
          rawString: "VTI",
          from: { id: vti.id, symbol: "VTI", name: "Vanguard Total Stock Market" },
          to: { id: vxus.id, symbol: "VXUS", name: "Vanguard Total International" },
          heldNow: [
            {
              accountId: brokerage.id,
              accountName: "Brokerage",
              accountNumberTail: null,
              ownerName: "Alice",
              quantity: "1.00000000",
            },
            {
              accountId: other.id,
              accountName: "Roth",
              accountNumberTail: null,
              ownerName: expect.any(String),
              quantity: "3.00000000",
            },
          ],
          statements: [],
        },
      });

      const forgetting = await changeAlias({ intent: "forget", rawString: "QAALIAS" }, ctx.db);
      expect(forgetting.applied).toBe(false);
      if (forgetting.applied) throw new Error("unreachable");
      expect(forgetting.preview.to).toBeNull();
      expect(forgetting.preview.statements).toEqual([
        {
          setId: expect.any(String),
          accountId: brokerage.id,
          accountName: "Brokerage",
          asOf: "2026-06-30",
          filename: "June.csv",
        },
      ]);

      // Nothing changed — both previews are reads.
      expect(await meaningOf("QAALIAS", ctx.db)).toBe(vti.id);
      expect(await meaningOf("VTI", ctx.db)).toBe(vti.id);
    }),
  );

  it(
    "finds a name the file had to quote, since a cell's quotes are doubled on disk",
    withDatabase(async (ctx) => {
      const account = await ctx.seedAccount({ name: "Brokerage", kind: "brokerage" });
      const vti = await ctx.seedInstrument({ symbol: "VTI" });
      await ctx.seedInstrumentAlias({ instrument: vti, rawString: 'BRK "B"' });
      await ctx.seedPositionSet({
        account,
        asOf: "2026-06-30",
        sourceFilename: "quoted.csv",
        rawFile: encode('Symbol,Quantity\n"BRK ""B""",1\n'),
      });

      const outcome = await changeAlias({ intent: "forget", rawString: 'BRK "B"' }, ctx.db);
      if (outcome.applied) throw new Error("A preview was expected, and the change applied.");

      expect(outcome.preview.statements.map((statement) => statement.filename)).toEqual([
        "quoted.csv",
      ]);
    }),
  );
});

describe("changeAlias — the write", () => {
  it(
    "repoints once confirmed: the next upload reads the new instrument, recorded holdings stay as they were",
    withDatabase(async (ctx) => {
      const { brokerage, vti, vxus } = await aWrongMatch(ctx);

      const outcome = await changeAlias(
        {
          intent: "repoint",
          rawString: "QAALIAS",
          instrumentId: vxus.id,
          fromInstrumentId: vti.id,
          confirm: "true",
        },
        ctx.db,
      );

      expect(outcome).toEqual({
        applied: true,
        intent: "repoint",
        rawString: "QAALIAS",
        from: { id: vti.id, symbol: "VTI", name: "Vanguard Total Stock Market" },
        to: { id: vxus.id, symbol: "VXUS", name: "Vanguard Total International" },
      });
      expect(await meaningOf("QAALIAS", ctx.db)).toBe(vxus.id);

      // History untouched: the holding recorded as VTI is still VTI.
      const holdings = await ctx.db
        .selectFrom("holding")
        .innerJoin("position_set", "position_set.id", "holding.position_set_id")
        .select("holding.instrument_id")
        .where("position_set.account_id", "=", brokerage.id)
        .execute();
      expect(holdings).toEqual([{ instrument_id: vti.id }]);
    }),
  );

  it(
    "forgets once confirmed, so the next upload asks about the string again",
    withDatabase(async (ctx) => {
      const { vti } = await aWrongMatch(ctx);
      const draft = await ctx.seedUploadDraft({ account: await ctx.seedAccount() });

      const outcome = await changeAlias(
        { intent: "forget", rawString: "QAALIAS", fromInstrumentId: vti.id, confirm: "true" },
        ctx.db,
      );

      expect(outcome).toMatchObject({ applied: true, intent: "forget", to: null });
      expect(await meaningOf("QAALIAS", ctx.db)).toBeNull();
      expect(await unresolvedStrings(["QAALIAS"], draft.id, ctx.db)).toEqual(["QAALIAS"]);

      // A replayed confirm finds nothing to forget and says so, rather than 404ing the screen.
      const replay = await refusalOf(() =>
        changeAlias(
          { intent: "forget", rawString: "QAALIAS", fromInstrumentId: vti.id, confirm: "true" },
          ctx.db,
        ),
      );
      expect(replay.fieldErrors.form).toMatch(/not an alias any more/);
    }),
  );

  it(
    "refuses a confirm drawn against a target the alias no longer has, changing nothing",
    withDatabase(async (ctx) => {
      const { vti, vxus } = await aWrongMatch(ctx);
      const bnd = await ctx.seedInstrument({ symbol: "BND", name: "Bond" });
      // Another tab repointed it to BND after this one's preview was drawn against VTI.
      await changeAlias(
        {
          intent: "repoint",
          rawString: "QAALIAS",
          instrumentId: bnd.id,
          fromInstrumentId: vti.id,
          confirm: "true",
        },
        ctx.db,
      );

      const refusal = await refusalOf(() =>
        changeAlias(
          {
            intent: "repoint",
            rawString: "QAALIAS",
            instrumentId: vxus.id,
            fromInstrumentId: vti.id,
            confirm: "true",
          },
          ctx.db,
        ),
      );

      expect(refusal.fieldErrors.form).toMatch(/changed while this page was open — it now means BND/);
      expect(await meaningOf("QAALIAS", ctx.db)).toBe(bnd.id);
    }),
  );

  it(
    "acts on the row the click was drawn from when two names differ only in their line endings",
    withDatabase(async (ctx) => {
      // Two exports, one quoting CRLF inside the cell: both rows post back as the CRLF spelling.
      const vti = await ctx.seedInstrument({ symbol: "VTI" });
      const vxus = await ctx.seedInstrument({ symbol: "VXUS" });
      const bnd = await ctx.seedInstrument({ symbol: "BND" });
      await ctx.seedInstrumentAlias({ instrument: vti, rawString: "BRK\nCLASS B" });
      await ctx.seedInstrumentAlias({ instrument: vxus, rawString: "BRK\r\nCLASS B" });

      const outcome = await changeAlias(
        {
          intent: "repoint",
          rawString: "BRK\r\nCLASS B",
          instrumentId: bnd.id,
          fromInstrumentId: vti.id,
          confirm: "true",
        },
        ctx.db,
      );

      expect(outcome).toMatchObject({ applied: true, rawString: "BRK\nCLASS B" });
      expect(await meaningOf("BRK\nCLASS B", ctx.db)).toBe(bnd.id);
      expect(await meaningOf("BRK\r\nCLASS B", ctx.db)).toBe(vxus.id);
    }),
  );

  it(
    "acts on the exact spelling when two line-ending spellings name the same instrument",
    withDatabase(async (ctx) => {
      const vti = await ctx.seedInstrument({ symbol: "VTI" });
      const bnd = await ctx.seedInstrument({ symbol: "BND" });
      await ctx.seedInstrumentAlias({ instrument: vti, rawString: "BRK\nCLASS B" });
      await ctx.seedInstrumentAlias({ instrument: vti, rawString: "BRK\r\nCLASS B" });

      const outcome = await changeAlias(
        {
          intent: "repoint",
          rawString: "BRK\r\nCLASS B",
          instrumentId: bnd.id,
          fromInstrumentId: vti.id,
          confirm: "true",
        },
        ctx.db,
      );

      expect(outcome).toMatchObject({ applied: true, rawString: "BRK\r\nCLASS B" });
      expect(await meaningOf("BRK\r\nCLASS B", ctx.db)).toBe(bnd.id);
      expect(await meaningOf("BRK\nCLASS B", ctx.db)).toBe(vti.id);
    }),
  );

  it(
    "names where the row went when it moved between the read and the write",
    withDatabase(async (ctx) => {
      const { vti, vxus } = await aWrongMatch(ctx);
      const bnd = await ctx.seedInstrument({ symbol: "BND", name: "Bond" });

      // The gap between the pre-write read and the compare-and-set, played by a trigger that
      // repoints the row to BND and skips the write. Ids are our own inserts' — safe to inline.
      await sql
        .raw(
          `create or replace function alias_moves() returns trigger language plpgsql as $t$
           begin
             if new.instrument_id = ${bnd.id} then return new; end if;
             update instrument_alias set instrument_id = ${bnd.id}
             where raw_string = old.raw_string;
             return null;
           end $t$`,
        )
        .execute(ctx.db);
      await sql
        .raw(
          "create trigger alias_moves before update on instrument_alias " +
            "for each row execute function alias_moves()",
        )
        .execute(ctx.db);

      const refusal = await refusalOf(() =>
        changeAlias(
          {
            intent: "repoint",
            rawString: "QAALIAS",
            instrumentId: vxus.id,
            fromInstrumentId: vti.id,
            confirm: "true",
          },
          ctx.db,
        ),
      );

      expect(refusal.fieldErrors.form).toMatch(/changed while this page was open — it now means BND/);
      expect(await meaningOf("QAALIAS", ctx.db)).toBe(bnd.id);
    }),
  );

  it(
    "refuses a repoint to the instrument the string already means, and to one that does not exist",
    withDatabase(async (ctx) => {
      const { vti } = await aWrongMatch(ctx);

      const same = await refusalOf(() =>
        changeAlias({ intent: "repoint", rawString: "QAALIAS", instrumentId: vti.id }, ctx.db),
      );
      expect(same.fieldErrors.instrumentId).toMatch(/already means VTI/);

      const missing = await refusalOf(() =>
        changeAlias({ intent: "repoint", rawString: "QAALIAS", instrumentId: "999999" }, ctx.db),
      );
      expect(missing.fieldErrors.instrumentId).toMatch(/Choose the instrument/);

      const blank = await refusalOf(() =>
        changeAlias({ intent: "repoint", rawString: "QAALIAS" }, ctx.db),
      );
      expect(blank.fieldErrors.instrumentId).toMatch(/Choose the instrument/);
    }),
  );

  it(
    "finds a multi-line name posted back with the browser's line endings, and stores nothing new",
    withDatabase(async (ctx) => {
      const vti = await ctx.seedInstrument({ symbol: "VTI" });
      const vxus = await ctx.seedInstrument({ symbol: "VXUS" });
      await ctx.seedInstrumentAlias({ instrument: vti, rawString: "BRK\nCLASS B" });

      const outcome = await changeAlias(
        { intent: "repoint", rawString: "BRK\r\nCLASS B", instrumentId: vxus.id, confirm: "true" },
        ctx.db,
      );

      expect(outcome).toMatchObject({ applied: true, rawString: "BRK\nCLASS B" });
      expect(
        (await ctx.db.selectFrom("instrument_alias").select("raw_string").execute()).map(
          (row) => row.raw_string,
        ),
      ).toEqual(["BRK\nCLASS B"]);
    }),
  );

  it(
    "refuses a post naming no alias at all, or no intent",
    withDatabase(async (ctx) => {
      await aWrongMatch(ctx);

      const nothing = await refusalOf(() => changeAlias({ intent: "forget", rawString: "" }, ctx.db));
      expect(nothing.fieldErrors.rawString).toMatch(/missing from this form/);

      const unknown = await refusalOf(() =>
        changeAlias({ intent: "forget", rawString: "NEVER SEEN" }, ctx.db),
      );
      expect(unknown.fieldErrors.form).toMatch(/not an alias any more/);

      const noIntent = await refusalOf(() => changeAlias({ rawString: "QAALIAS" }, ctx.db));
      expect(noIntent.fieldErrors.intent).toMatch(/repoint this alias or forget it/);
    }),
  );
});
