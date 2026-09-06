// Step three's action pairs a posted answer with the string it answers by index (ingest brief §5, §7.5) — the hidden raw-N
// field proves the index still means what it meant when drawn. Worth its own file: a mispairing is global and permanent
// (point a string at the wrong instrument once, every future export resolves to it silently). Domain rules are
// instrument-resolution.test.ts's.
import { afterAll, describe, expect, it } from "vitest";

import { action, loader } from "../../app/routes/upload/instruments.tsx";
import { rememberMapping } from "~/lib/uploads.server";
import { resolveAll, unresolvedStrings } from "~/lib/instrument-resolution.server";

import { closeTestDatabase, withDatabase } from "../support/database.ts";
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

      // Page drawn with VTI/VXUS both unresolved; another draft resolves VTI while it sits open — index 0 is now VXUS.
      await resolveAll(
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
        // Manual: probe must never be reached; empty-map stub satisfies the required param.
        { probe: async () => new Map() },
      );

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
      expect(await unresolvedStrings(["VXUS"], ctx.db)).toEqual(["VXUS"]);
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
      expect(await unresolvedStrings([raw], ctx.db)).toEqual([]);
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
