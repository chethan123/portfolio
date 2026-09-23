// Where a multi-account upload lands (spec 0023 decision 16). The address is the only record of
// what was just recorded, so it is read back from the database: a hand-edited id must drop out
// quietly rather than 404 the page or report a set the upload never wrote as one.
import { afterAll, describe, expect, it } from "vitest";

import Done, { loader } from "../../app/routes/upload/done.tsx";

import { closeTestDatabase, withDatabase } from "../support/database.ts";
import { renderRoute } from "../support/render.tsx";
import { args, get } from "../support/routes.ts";

afterAll(closeTestDatabase);

describe("the done page", () => {
  it(
    "lists each upload set named with its account, date and counts, linking to that account's own receipt",
    withDatabase(async ({ seedAccount, seedInstrument, seedPositionSet }) => {
      const vti = await seedInstrument({ symbol: "VTI" });
      const bnd = await seedInstrument({ symbol: "BND" });
      const brokerage = await seedAccount({ name: "Brokerage", externalAccountNumber: "Z12-345678" });
      const ira = await seedAccount({ name: "IRA" });
      await seedPositionSet({
        account: ira,
        asOf: "2026-05-31",
        holdings: [{ instrument: vti, quantity: "1" }],
      });
      const first = await seedPositionSet({
        account: brokerage,
        asOf: "2026-07-31",
        sourceFilename: "all-accounts.csv",
        holdings: [{ instrument: vti, quantity: "10" }],
      });
      const second = await seedPositionSet({
        account: ira,
        asOf: "2026-06-30",
        sourceFilename: "all-accounts.csv",
        holdings: [{ instrument: bnd, quantity: "5" }],
      });
      const path = `/upload/done?sets=${first.id},${second.id}`;

      const { statements } = await loader(args(get(path)));

      expect(
        statements.map(({ accountName, accountNumberTail, receipt }) => [
          accountName,
          accountNumberTail,
          receipt.asOf,
          receipt.counts,
        ]),
      ).toEqual([
        ["Brokerage", "····5678", "2026-07-31", { added: 1, updated: 0, unchanged: 0, removed: 0 }],
        ["IRA", null, "2026-06-30", { added: 1, updated: 0, unchanged: 0, removed: 1 }],
      ]);

      const markup = renderRoute(Done, path, { statements });
      expect(markup).toContain("all-accounts.csv");
      expect(markup).toContain("2 ACCOUNTS");
      expect(markup).toContain(`href="/accounts/${brokerage.id}?uploaded=${first.id}"`);
      expect(markup).toContain(`href="/accounts/${ira.id}?uploaded=${second.id}"`);
      expect(markup).toContain("1</span> removed");
    }),
  );

  it(
    "leaves out an id naming no set, a manually typed set's id and anything that is not an id",
    withDatabase(async ({ seedAccount, seedPositionSet }) => {
      const account = await seedAccount({ name: "Brokerage" });
      const uploaded = await seedPositionSet({ account, asOf: "2026-06-30" });
      const typed = await seedPositionSet({ account, asOf: "2026-07-01", source: "manual" });
      const path = `/upload/done?sets=999999999,${typed.id},abc,,-1,${uploaded.id}`;

      const { statements } = await loader(args(get(path)));

      expect(statements.map((statement) => statement.receipt.setId)).toEqual([uploaded.id]);
    }),
  );

  it(
    "reads a bounded number of the ids an address names, so one anyone can type does not fan out",
    withDatabase(async ({ seedAccount, seedPositionSet }) => {
      const account = await seedAccount({ name: "Brokerage" });
      const uploaded = await seedPositionSet({ account, asOf: "2026-06-30" });
      const unknown = Array.from({ length: 1000 }, (_, index) => String(900_000_000 + index));
      const at = async (ids: string[]) =>
        (await loader(args(get(`/upload/done?sets=${ids.join(",")}`)))).statements.map(
          (statement) => statement.receipt.setId,
        );

      expect(await at([uploaded.id, ...unknown])).toEqual([uploaded.id]);
      expect(await at([...unknown, uploaded.id])).toEqual([]);
    }),
  );

  it(
    "still lists an upload set once a later set lands on its account, saying it is filed behind",
    withDatabase(async ({ seedAccount, seedInstrument, seedPositionSet }) => {
      const vti = await seedInstrument({ symbol: "VTI" });
      const account = await seedAccount({ name: "Brokerage" });
      const uploaded = await seedPositionSet({
        account,
        asOf: "2026-06-30",
        sourceFilename: "all-accounts.csv",
        holdings: [{ instrument: vti, quantity: "10" }],
      });
      await seedPositionSet({
        account,
        asOf: "2026-07-31",
        source: "manual",
        holdings: [{ instrument: vti, quantity: "11" }],
      });
      const path = `/upload/done?sets=${uploaded.id}`;

      const { statements } = await loader(args(get(path)));

      expect(statements.map((statement) => statement.receipt.setId)).toEqual([uploaded.id]);
      expect(renderRoute(Done, path, { statements })).toContain(
        "Filed behind what Brokerage already reports — it still shows its " +
          '<b class="u-data">2026-07-31</b> figures.',
      );
    }),
  );

  it(
    "renders an address naming nothing recorded as a page saying so, never a 404",
    withDatabase(async () => {
      for (const path of ["/upload/done", "/upload/done?sets=", "/upload/done?sets=%2C%2Cx"]) {
        const data = await loader(args(get(path)));
        expect(data.statements).toEqual([]);
        expect(renderRoute(Done, path, data)).toContain(
          "No recorded statement matches this address.",
        );
      }
    }),
  );
});
