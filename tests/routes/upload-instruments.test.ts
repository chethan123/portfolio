/**
 * Step three's action — where an answer is paired with the string it
 * answers (ingest brief §5, §7.5). The rules underneath are
 * `instrument-resolution.test.ts`'s; what lives only here is the *pairing*:
 * posted answers line up with the draft's unresolved strings by index, and
 * the hidden `raw-N` field proves the index still means what it meant when
 * the page was drawn. Worth its own file because a mispairing is global and
 * permanent — point "VANGUARD TOTAL INTL" at the wrong instrument once and
 * every future export resolves to it silently, with no screen that ever
 * asks again. The window is real (two tabs, a concurrent draft) and the
 * guard is one `some` over an index.
 */
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

      // The page was drawn when VTI and VXUS were both unresolved. While it sat
      // open, another draft resolved VTI — so the screen's index 0 is now VXUS,
      // and the answer typed for VTI would land on it.
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
        // Manual, so the probe must never actually be reached — a stub
        // answering an empty map is enough to satisfy the required param.
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

      // A form-level refusal, not a field one: no single select is wrong, the
      // page is.
      expect(outcome).toMatchObject({
        formError: expect.stringContaining("changed while this page was open"),
      });

      // The point of refusing wholesale — VXUS is untouched rather than
      // resolved to the answer typed for VTI.
      expect(await unresolvedStrings(["VXUS"], ctx.db)).toEqual(["VXUS"]);
    }),
  );

  it(
    "accepts answers whose hidden copy came back with the browser's line endings",
    withDatabase(async (ctx) => {
      // A brokerage that writes a multi-line description cell. The browser
      // rewrites the newline to CRLF on the way through the hidden field, so a
      // byte comparison here would refuse every submission for that file —
      // which is why the guard compares through `sameRawStrings`.
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
      // Stored as the file wrote it, never as the form round trip returned it.
      expect(await unresolvedStrings([raw], ctx.db)).toEqual([]);
    }),
  );
});

describe("a step with nothing left to ask", () => {
  it(
    "sends a resolved draft on to review rather than drawing an empty screen",
    withDatabase(async (ctx) => {
      // Charging a click for a screen with no decision on it is the thing the
      // brief refuses (§7.5). Reached by the back button, or by a second tab
      // that resolved everything a moment ago.
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
        // Manual, so the probe must never actually be reached — a stub
        // answering an empty map is enough to satisfy the required param.
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
      // A swept draft — they expire after 24 hours — reached from a stale tab.
      const response = await outcomeOf(() =>
        loader(args(get("/upload/999999/instruments"), { draftId: "999999" })),
      );

      expect(response).toBeInstanceOf(Response);
      expect((response as Response).status).toBe(404);
    }),
  );
});
