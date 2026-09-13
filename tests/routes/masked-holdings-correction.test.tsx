import { afterAll, describe, expect, it } from "vitest";

import Holdings, { action, loader } from "../../app/routes/holdings.tsx";
import { loader as rootLoader } from "../../app/root.tsx";
import { createDatabase, withDb } from "~/lib/db.server";
import { MASKED, MASKING_COOKIE, UNMASKED } from "~/lib/masking";
import { currentPosition } from "~/lib/positions.server";

import {
  TEST_DATABASE_URL,
  closeTestDatabase,
  withDatabase,
} from "../support/database.ts";
import { renderRoute } from "../support/render.tsx";
import { args, get, post, redirectTo } from "../support/routes.ts";

import type { TestContext } from "../support/database.ts";

process.env.DATABASE_URL = TEST_DATABASE_URL;

afterAll(closeTestDatabase);

const QUANTITY = "1.00000001";
const BASIS = "100.0001";

async function seedPosition(ctx: TestContext) {
  const account = await ctx.seedAccount({ name: "Fidelity Taxable", kind: "brokerage" });
  const instrument = await ctx.seedInstrument({ symbol: "VTI", name: "Vanguard Total Stock" });

  await ctx.seedQuote({ instrument, price: "257.3100" });
  await ctx.seedPositionSet({
    account,
    asOf: "2026-06-30",
    holdings: [{ instrument, quantity: QUANTITY, costBasisPerShare: BASIS }],
  });

  return { account, instrument, key: `${account.id}.${instrument.id}` };
}

const cookie = (value: string) => `${MASKING_COOKIE}=${value}`;

describe("a correction on masked Holdings", () => {
  it(
    "keeps exact amounts out of loader data and the first render until Show amounts completes",
    withDatabase(async (ctx) => {
      const { key } = await seedPosition(ctx);
      const path = `/holdings?edit=${key}`;
      const data = await loader(args(get(path, cookie(MASKED))));
      const serialized = JSON.stringify(data);

      expect(serialized).not.toContain(QUANTITY);
      expect(serialized).not.toContain(BASIS);

      const grouped = await loader(
        args(get(`/holdings?group=account&edit=${key}`, cookie(MASKED))),
      );
      expect(JSON.stringify(grouped)).not.toContain(QUANTITY);
      expect(JSON.stringify(grouped)).not.toContain(BASIS);

      const firstPaint = renderRoute(Holdings, path, data, { masked: true });
      expect(firstPaint).not.toContain(QUANTITY);
      expect(firstPaint).not.toContain(BASIS);
      expect(firstPaint).not.toContain('name="quantity"');
      expect(firstPaint).not.toContain('name="costBasisPerShare"');
      expect(firstPaint).toMatch(/Show amounts.*reveal and edit/s);

      // The optimistic toggle may say unmasked before revalidation returns. Redacted loader data
      // must stay masked rather than becoming an invented zero/default in that interval.
      const awaitingFreshData = renderRoute(Holdings, path, data, { masked: false });
      expect(awaitingFreshData).not.toContain(QUANTITY);
      expect(awaitingFreshData).not.toContain(BASIS);
      expect(awaitingFreshData).not.toContain('name="quantity"');
      expect(awaitingFreshData).not.toContain('name="costBasisPerShare"');
    }),
  );

  it(
    "uses one fail-closed masking decision across root and Holdings loaders in the same request",
    withDatabase(async (ctx) => {
      const { key } = await seedPosition(ctx);
      await ctx.db.updateTable("app_setting").set({ masking_policy: "masked" }).execute();
      const shared = args(get(`/holdings?edit=${key}`));

      expect((await rootLoader(shared)).masked).toBe(true);
      await ctx.db.updateTable("app_setting").set({ masking_policy: "unmasked" }).execute();

      expect(JSON.stringify(await loader(shared))).not.toContain(QUANTITY);
    }),
  );

  it(
    "shares a failed masking read rather than letting a child retry into an exact response",
    withDatabase(async (ctx) => {
      const { key } = await seedPosition(ctx);
      await ctx.db.updateTable("app_setting").set({ masking_policy: "unmasked" }).execute();
      const shared = args(get(`/holdings?edit=${key}`));
      const unreachable = createDatabase(
        "postgres://portfolio:portfolio@127.0.0.1:1/portfolio_codex_294_tests",
      );

      try {
        expect((await withDb(unreachable, () => rootLoader(shared))).masked).toBe(true);
      } finally {
        await unreachable.destroy();
      }

      expect(JSON.stringify(await loader(shared))).not.toContain(QUANTITY);
    }),
  );

  it(
    "keeps safe direction, ratio, ordering, and unknown markers in the redacted projection",
    withDatabase(async (ctx) => {
      const account = await ctx.seedAccount({ name: "Mixed positions", kind: "brokerage" });
      const gain = await ctx.seedInstrument({ symbol: "GAIN", name: "Gain" });
      const loss = await ctx.seedInstrument({ symbol: "LOSS", name: "Loss" });
      const flat = await ctx.seedInstrument({ symbol: "FLAT", name: "Flat" });
      const unknown = await ctx.seedInstrument({ symbol: "NONE", name: "Unknown" });

      await ctx.seedQuote({
        instrument: gain,
        price: "200.0000",
        annualDividendPerShare: "10.0000",
      });
      await ctx.seedQuote({ instrument: loss, price: "100.0000" });
      await ctx.seedQuote({ instrument: flat, price: "50.0000" });
      await ctx.seedPositionSet({
        account,
        asOf: "2026-06-30",
        holdings: [
          { instrument: gain, quantity: "7.12345678", costBasisPerShare: "150.0000" },
          { instrument: loss, quantity: "3.23456789", costBasisPerShare: "125.0000" },
          { instrument: flat, quantity: "2.34567891", costBasisPerShare: "50.0000" },
          { instrument: unknown, quantity: "9.87654321" },
        ],
      });

      const data = await loader(
        args(get("/holdings?group=account&sort=unrealized", cookie(MASKED))),
      );
      const rows = data.groups?.[0]?.holdings ?? [];

      expect(rows.map((row) => row.instrumentName)).toEqual(["Gain", "Flat", "Loss", "Unknown"]);
      expect(rows.map((row) => row.unrealizedDirection)).toEqual(["gain", "flat", "loss", null]);
      expect(rows.find((row) => row.instrumentName === "Gain")?.yieldOnValue).toBe("0.050000");

      const missing = rows.find((row) => row.instrumentName === "Unknown");
      expect(missing).toMatchObject({
        price: null,
        value: null,
        costBasisPerShare: null,
        costBasis: null,
        unrealized: null,
      });
      expect(data.total).toMatchObject({
        valueCoverage: { known: 3, total: 4 },
        basisCoverage: { known: 3, total: 4 },
        unrealizedCoverage: { known: 3, total: 4 },
      });

      const serialized = JSON.stringify(data);
      for (const exact of [
        "7.12345678",
        "3.23456789",
        "2.34567891",
        "9.87654321",
        "150.0000",
        "125.0000",
        "50.0000",
      ]) {
        expect(serialized).not.toContain(exact);
      }
    }),
  );

  it(
    "reveals real defaults only for an unmasked request and removes the inputs immediately on re-mask",
    withDatabase(async (ctx) => {
      const { key } = await seedPosition(ctx);
      const path = `/holdings?edit=${key}`;
      const data = await loader(args(get(path, cookie(UNMASKED))));

      expect(JSON.stringify(data)).toContain(QUANTITY);
      expect(JSON.stringify(data)).toContain(BASIS);

      const revealed = renderRoute(Holdings, path, data, { masked: false });
      expect(revealed).toContain(`name="quantity" value="${QUANTITY}"`);
      expect(revealed).toContain(`name="costBasisPerShare" value="${BASIS}"`);

      // `useMasked()` changes before the route loader revalidates. Old exact loader data may still
      // exist briefly, but it must leave the DOM with the editor inputs in the same render.
      const hiding = renderRoute(Holdings, path, data, { masked: true });
      expect(hiding).not.toContain('name="quantity"');
      expect(hiding).not.toContain('name="costBasisPerShare"');
      expect(hiding).not.toContain(QUANTITY);
      expect(hiding).not.toContain(BASIS);
    }),
  );

  it(
    "does not mutate or echo a direct masked POST, while unmasked validation retains typed values",
    withDatabase(async (ctx) => {
      const { account, instrument, key } = await seedPosition(ctx);
      const path = `/holdings?edit=${key}`;

      const refused = await action(
        args(post(path, { quantity: "999.12345678", costBasisPerShare: "88.4321" }, cookie(MASKED))),
      );
      expect(JSON.stringify(refused)).not.toContain("999.12345678");
      expect(JSON.stringify(refused)).not.toContain("88.4321");
      expect(refused.errors.form).toMatch(/show amounts/i);
      expect((await currentPosition(account.id, instrument.id, ctx.db))?.quantity).toBe(QUANTITY);

      const invalid = await action(
        args(post(path, { quantity: "not a quantity", costBasisPerShare: BASIS }, cookie(UNMASKED))),
      );
      const data = await loader(args(get(path, cookie(UNMASKED))));
      const markup = renderRoute(Holdings, path, data, { masked: false, actionData: invalid });

      expect(markup).toContain('name="quantity" value="not a quantity"');
      expect(markup).toContain(`name="costBasisPerShare" value="${BASIS}"`);
      expect(markup).toMatch(/quantity must be a number/i);
    }),
  );

  it(
    "accepts eight quantity places and four basis places after reveal, then redacts the receipt",
    withDatabase(async (ctx) => {
      const { account, instrument, key } = await seedPosition(ctx);
      const path = `/holdings?edit=${key}`;

      expect(
        await redirectTo(() =>
          action(
            args(
              post(
                path,
                { quantity: "2.12345678", costBasisPerShare: "111.4321" },
                cookie(UNMASKED),
              ),
            ),
          ),
        ),
      ).toBe(`/holdings?saved=${key}`);

      expect(await currentPosition(account.id, instrument.id, ctx.db)).toMatchObject({
        quantity: "2.12345678",
        costBasisPerShare: "111.4321",
      });

      const receiptPath = `/holdings?saved=${key}`;
      const hiddenReceipt = await loader(args(get(receiptPath, cookie(MASKED))));
      const serialized = JSON.stringify(hiddenReceipt);
      expect(serialized).not.toContain("2.12345678");
      expect(serialized).not.toContain("111.4321");
      expect(renderRoute(Holdings, receiptPath, hiddenReceipt, { masked: true })).not.toContain(
        "2.12345678",
      );
    }),
  );
});
