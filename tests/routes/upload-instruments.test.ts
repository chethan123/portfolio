// Step three's action pairs a posted answer with the string it answers by index (ingest brief §5, §7.5) — the hidden raw-N
// field proves the index still means what it meant when drawn. Worth its own file: a mispairing reaches vocabulary with
// the commit (point a string at the wrong instrument once, every future export resolves to it silently until repaired).
// Domain rules are instrument-resolution.test.ts's; the audit's abandoned-draft case (QA-04) is here, at route level.
import { afterAll, describe, expect, it } from "vitest";

import Instruments, { action, loader } from "../../app/routes/upload/instruments.tsx";
import { rememberMapping } from "~/lib/uploads.server";
import { resolveAll, unresolvedStrings } from "~/lib/instrument-resolution.server";

import { closeTestDatabase, withDatabase } from "../support/database.ts";
import { renderRoute } from "../support/render.tsx";
import { args, get, outcomeOf, post, redirectTo } from "../support/routes.ts";

import type { TestContext } from "../support/database.ts";
import type { StatementMapping } from "~/lib/statement";

afterAll(closeTestDatabase);

const encode = (text: string) => new TextEncoder().encode(text);

/** Two first sightings, in the order the file raises them. */
const CSV = ["Symbol,Quantity", "VTI,100", "VXUS,50"].join("\n");

const MAPPING: StatementMapping = {
  headerRow: 0,
  delimiter: ",",
  columns: { instrument: "Symbol", quantity: "Quantity" },
  costBasisIs: "per_share",
  owedAsPositive: false,
  combineDuplicateRows: true,
};

/** A draft parked on the resolution step, with both strings still unresolved. */
async function stageDraft(
  ctx: Pick<TestContext, "db" | "seedAccount" | "seedUploadDraft">,
  csv: string = CSV,
): Promise<string> {
  const account = await ctx.seedAccount({ kind: "brokerage" });
  const draft = await ctx.seedUploadDraft({
    account,
    filename: "Positions.csv",
    bytes: encode(csv),
  });

  const outcome = await rememberMapping(draft.id, MAPPING, ctx.db);
  if ("problems" in outcome) {
    throw new Error("This fixture's mapping does not parse its own file.");
  }

  return draft.id;
}

/** One input tag, so a value repeated in the raw heading or Name field cannot satisfy the assertion. */
function inputTag(markup: string, id: string): string {
  const tag = markup.match(new RegExp(`<input id="${id}"[^>]*>`))?.[0];
  if (tag === undefined) throw new Error(`The rendered page has no input called ${id}.`);
  return tag;
}

/** Render one unresolved raw string through the real loader and route component. */
async function unresolvedScreen(ctx: TestContext, raw: string) {
  const csv = ["Symbol,Quantity", `"${raw.replaceAll('"', '""')}",1`].join("\n");
  const draftId = await stageDraft(ctx, csv);
  const path = `/upload/${draftId}/instruments`;
  const data = await loader(args(get(path), { draftId }));
  if (data instanceof Response) throw new Error("The unresolved fixture skipped its screen.");
  return { data, draftId, path, markup: renderRoute(Instruments, path, data) };
}

/** The answers that create a new instrument for the string at `index`. */
function createAnswer(index: number, raw: string, symbol: string) {
  return {
    [`raw-${index}`]: raw,
    [`kind-${index}`]: "create",
    [`symbol-${index}`]: symbol,
    [`name-${index}`]: `${symbol} fund`,
    [`priceSource-${index}`]: "manual",
    [`classificationId-${index}`]: "__new__",
    [`newClassificationName-${index}`]: `Class ${symbol}`,
    [`newClassificationAssetClass-${index}`]: "equity",
  };
}

describe("the stale-form guard", () => {
  it(
    "refuses the whole submission when a posted string no longer sits at its index",
    withDatabase(async (ctx) => {
      const draftId = await stageDraft(ctx);

      // Page drawn with VTI/VXUS both unresolved; another upload records VTI while it sits open — index 0 is now VXUS.
      await ctx.seedInstrumentAlias({
        instrument: await ctx.seedInstrument({ symbol: "VTI", name: "Vanguard Total Stock Market" }),
        rawString: "VTI",
      });

      const outcome = await outcomeOf(() =>
        action(
          args(
            post(`/upload/${draftId}/instruments`, {
              ...createAnswer(0, "VTI", "VTI"),
              ...createAnswer(1, "VXUS", "VXUS"),
            }),
            { draftId },
          ),
        ),
      );

      // Form-level refusal, not a field one — the page is wrong, not one select.
      expect(outcome).toMatchObject({
        formError: expect.stringContaining("changed while this page was open"),
      });

      // The point of refusing wholesale — VXUS untouched, not resolved to VTI's answer.
      expect(await unresolvedStrings(["VXUS"], draftId, ctx.db)).toEqual(["VXUS"]);
    }),
  );

  it(
    "accepts answers whose hidden copy came back with the browser's line endings",
    withDatabase(async (ctx) => {
      // The browser rewrites \n to \r\n through the hidden field, so a byte comparison would refuse every such submission — guard compares via sameRawStrings.
      const draftId = await stageDraft(
        ctx,
        ['Symbol,Quantity', '"BRK\nCLASS B",10'].join("\n"),
      );

      const raw = "BRK\nCLASS B";
      const posted = raw.replace("\n", "\r\n");

      const destination = await redirectTo(() =>
        action(
          args(post(`/upload/${draftId}/instruments`, createAnswer(0, posted, "BRKB")), {
            draftId,
          }),
        ),
      );

      expect(destination).toBe(`/upload/${draftId}/review`);
      // Stored as the file wrote it, never the form round trip's spelling.
      expect(await unresolvedStrings([raw], draftId, ctx.db)).toEqual([]);
    }),
  );
});

describe("a step with nothing left to ask", () => {
  it(
    "sends a resolved draft on to review rather than drawing an empty screen",
    withDatabase(async (ctx) => {
      // A screen with no decision on it is what §7.5 refuses — reached via back button or a second tab that just resolved everything.
      const draftId = await stageDraft(ctx, ["Symbol,Quantity", "VTI,100"].join("\n"));

      await resolveAll(
        draftId,
        [
          {
            raw: "VTI",
            fields: {
              kind: "create",
              symbol: "VTI",
              name: "Vanguard Total Stock Market",
              priceSource: "manual",
              classificationId: "__new__",
              newClassificationName: "US equity",
              newClassificationAssetClass: "equity",
            },
          },
        ],
        { probe: async () => new Map() },
      );

      expect(
        await redirectTo(() => loader(args(get(`/upload/${draftId}/instruments`), { draftId }))),
      ).toBe(`/upload/${draftId}/review`);
    }),
  );

  it(
    "answers 404 for a draft id that matches no row",
    withDatabase(async () => {
      // A swept draft (24h expiry), reached from a stale tab.
      const response = await outcomeOf(() =>
        loader(args(get("/upload/999999/instruments"), { draftId: "999999" })),
      );

      expect(response).toBeInstanceOf(Response);
      expect((response as Response).status).toBe(404);
    }),
  );
});

describe("new-instrument defaults", () => {
  it(
    "prefills an exact ticker-like raw value while keeping Symbol editable and the Name fallback",
    withDatabase(async (ctx) => {
      const { markup } = await unresolvedScreen(ctx, "FXAIX");

      const symbol = inputTag(markup, "symbol-0");
      expect(symbol).toContain('value="FXAIX"');
      expect(symbol).not.toContain("readOnly");
      expect(symbol).not.toContain("disabled");
      expect(inputTag(markup, "name-0")).toContain('value="FXAIX"');
    }),
  );

  it(
    "leaves Symbol blank for descriptive and whitespace-padded raw values",
    withDatabase(async (ctx) => {
      for (const raw of ["Fidelity 500 Index Fund", " FXAIX "]) {
        const { markup } = await unresolvedScreen(ctx, raw);

        expect(inputTag(markup, "symbol-0")).toContain('value=""');
        expect(inputTag(markup, "name-0")).toContain(`value="${raw}"`);
      }
    }),
  );

  it(
    "keeps a rejected submission's edited and cleared Symbol values",
    withDatabase(async (ctx) => {
      for (const postedSymbol of ["EDITED", ""]) {
        const { data, draftId, path } = await unresolvedScreen(ctx, "FXAIX");
        const result = await action(
          args(
            post(path, {
              "raw-0": "FXAIX",
              "kind-0": "create",
              "symbol-0": postedSymbol,
              "name-0": "",
              "priceSource-0": "manual",
            }),
            { draftId },
          ),
        );
        if (result instanceof Response) throw new Error("The invalid answer left the screen.");

        const markup = renderRoute(Instruments, path, data, { actionData: result });
        expect(inputTag(markup, "symbol-0")).toContain(`value="${postedSymbol}"`);
      }
    }),
  );
});

describe("an upload abandoned after this step", () => {
  it(
    "teaches the next upload nothing: the same string is asked about again, not read as the old answer",
    withDatabase(async (ctx) => {
      // The audit's QAALIAS (docs/research/2026-09-13-product-qa-audit.md, QA-04): matched to VTI, then the upload is walked away from.
      const vti = await ctx.seedInstrument({ symbol: "VTI", name: "Vanguard Total Stock Market" });
      const csv = ["Symbol,Quantity", "QAALIAS,1"].join("\n");
      const abandoned = await stageDraft(ctx, csv);

      const toReview = await redirectTo(() =>
        action(
          args(
            post(`/upload/${abandoned}/instruments`, {
              "raw-0": "QAALIAS",
              "kind-0": "existing",
              "instrumentId-0": vti.id,
            }),
            { draftId: abandoned },
          ),
        ),
      );
      expect(toReview).toBe(`/upload/${abandoned}/review`);

      // Nothing recorded. The next upload of the same file meets QAALIAS as a first sighting again.
      const next = await stageDraft(ctx, csv);
      const screen = await loader(args(get(`/upload/${next}/instruments`), { draftId: next }));
      expect(screen).not.toBeInstanceOf(Response);
      expect((screen as Exclude<typeof screen, Response>).screen.unresolved.map((item) => item.raw)).toEqual([
        "QAALIAS",
      ]);

      // Nothing became vocabulary: the answer stayed the abandoned draft's own.
      expect(await ctx.db.selectFrom("instrument_alias").select("raw_string").execute()).toEqual([]);
    }),
  );
});
