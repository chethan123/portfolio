// Settings → Instruments (issue #291). Domain rules are instrument-aliases.test.ts's; this covers the
// screen: every name drawn as the file wrote it, the preview standing between a click and the
// write, and a refusal landing beside the row that posted it.
import { afterAll, describe, expect, it } from "vitest";

import Instruments, { action, loader } from "../../app/routes/settings/instruments.tsx";

import { closeTestDatabase, withDatabase } from "../support/database.ts";
import { renderRoute } from "../support/render.tsx";
import { args, post } from "../support/routes.ts";

import type { TestContext } from "../support/database.ts";

afterAll(closeTestDatabase);

async function aWrongMatch(ctx: TestContext) {
  const owner = await ctx.seedPerson({ name: "Alice" });
  const brokerage = await ctx.seedAccount({
    name: "Brokerage",
    owner,
    kind: "brokerage",
    externalAccountNumber: "X47-283910",
  });
  const vti = await ctx.seedInstrument({ symbol: "VTI", name: "Vanguard Total Stock Market" });
  const vxus = await ctx.seedInstrument({ symbol: "VXUS", name: "Vanguard Total International" });
  await ctx.seedInstrumentAlias({ instrument: vti, rawString: "QAALIAS " });
  await ctx.seedPositionSet({
    account: brokerage,
    asOf: "2026-06-30",
    holdings: [{ instrument: vti, quantity: "1" }],
  });
  return { brokerage, vti, vxus };
}

describe("the list", () => {
  it(
    "draws each name byte-exact with its instrument, a picker of every instrument, and both controls",
    withDatabase(async (ctx) => {
      const { vti, vxus } = await aWrongMatch(ctx);

      const data = await loader();
      const markup = renderRoute(Instruments, "/settings/instruments", data);

      // The trailing space is part of the name; it must reach the page.
      expect(markup).toContain('<th scope="row" class="resolve-raw">QAALIAS </th>');
      expect(markup).toContain('<input type="hidden" name="rawString" value="QAALIAS "/>');
      expect(markup).toContain(`<input type="hidden" name="fromInstrumentId" value="${vti.id}"/>`);
      expect(markup).toContain("<td>VTI (Vanguard Total Stock Market)</td>");
      expect(markup).toContain('<span class="u-data">1</span> account');
      expect(markup).toContain(`<option value="${vxus.id}">VXUS (Vanguard Total International)</option>`);
      expect(markup).toContain('name="intent">Repoint</button>');
      expect(markup).toContain('name="intent">Forget</button>');
    }),
  );

  it(
    "says so when nothing has been recorded yet",
    withDatabase(async () => {
      const markup = renderRoute(Instruments, "/settings/instruments", await loader());
      expect(markup).toContain("No names are recorded yet.");
    }),
  );
});

describe("the preview", () => {
  it(
    "stands between a click and the write, naming what stays recorded, with the confirm carrying the drawn target",
    withDatabase(async (ctx) => {
      const { brokerage, vti, vxus } = await aWrongMatch(ctx);

      const outcome = await action(
        args(
          post("/settings/instruments", {
            intent: "repoint",
            rawString: "QAALIAS ",
            fromInstrumentId: vti.id,
            instrumentId: vxus.id,
          }),
        ),
      );

      expect(outcome).toMatchObject({ applied: null, errors: null, formError: null });
      expect(outcome.preview).toMatchObject({ rawString: "QAALIAS ", to: { id: vxus.id } });
      // Still VTI — the preview is a read.
      expect((await loader()).aliases.map((alias) => alias.instrument.id)).toEqual([vti.id]);

      const markup = renderRoute(Instruments, "/settings/instruments", await loader(), {
        actionData: outcome,
      });
      expect(markup).toContain(
        "Repoint &quot;QAALIAS &quot; to VXUS (Vanguard Total International)?",
      );
      expect(markup).toContain("What is already recorded stays as it is.");
      expect(markup).toContain(`<a href="/accounts/${brokerage.id}" data-discover="true">Brokerage`);
      expect(markup).toContain("····3910");
      expect(markup).toContain('<input type="hidden" name="confirm" value="true"/>');
      expect(markup).toContain(`<input type="hidden" name="fromInstrumentId" value="${vti.id}"/>`);
      expect(markup).toContain(">Repoint it</button>");
      expect(markup).toContain(">Keep it as it is</a>");
    }),
  );

  it(
    "applies on confirm and says what the name means now",
    withDatabase(async (ctx) => {
      const { vti, vxus } = await aWrongMatch(ctx);

      const outcome = await action(
        args(
          post("/settings/instruments", {
            intent: "repoint",
            rawString: "QAALIAS ",
            fromInstrumentId: vti.id,
            instrumentId: vxus.id,
            confirm: "true",
          }),
        ),
      );

      expect(outcome).toMatchObject({
        applied: { intent: "repoint", rawString: "QAALIAS ", to: { id: vxus.id } },
        preview: null,
      });
      const data = await loader();
      expect(data.aliases.map((alias) => alias.instrument.id)).toEqual([vxus.id]);

      const markup = renderRoute(Instruments, "/settings/instruments", data, { actionData: outcome });
      expect(markup).toContain("&quot;QAALIAS &quot; now means VXUS (Vanguard Total International).");
    }),
  );

  it(
    "lands a refused target beside the row that posted it, and a stale row above the list",
    withDatabase(async (ctx) => {
      const { vti } = await aWrongMatch(ctx);

      const same = await action(
        args(
          post("/settings/instruments", {
            intent: "repoint",
            rawString: "QAALIAS ",
            fromInstrumentId: vti.id,
            instrumentId: vti.id,
          }),
        ),
      );
      expect(same.errors).toMatchObject({ instrumentId: expect.stringContaining("already means VTI") });

      const markup = renderRoute(Instruments, "/settings/instruments", await loader(), {
        actionData: same,
      });
      expect(markup).toContain('<p class="field-error" role="alert">');
      expect(markup).toContain("already means VTI");

      const gone = await action(
        args(post("/settings/instruments", { intent: "forget", rawString: "NEVER SEEN" })),
      );
      expect(gone.formError).toMatch(/not an alias any more/);
    }),
  );

  it(
    "lands a multi-line name's refusal beside its row, though the browser posted it back with CRLF",
    withDatabase(async (ctx) => {
      const vti = await ctx.seedInstrument({ symbol: "VTI", name: "Vanguard Total Stock Market" });
      await ctx.seedInstrumentAlias({ instrument: vti, rawString: "BRK\nCLASS B" });

      const same = await action(
        args(
          post("/settings/instruments", {
            intent: "repoint",
            rawString: "BRK\r\nCLASS B",
            fromInstrumentId: vti.id,
            instrumentId: vti.id,
          }),
        ),
      );
      expect(same.errors).toMatchObject({ instrumentId: expect.stringContaining("already means") });

      const markup = renderRoute(Instruments, "/settings/instruments", await loader(), {
        actionData: same,
      });
      expect(markup).toContain('<p class="field-error" role="alert">');
    }),
  );

  it(
    "lands the refusal beside the one row it came from when two spellings differ only in line endings",
    withDatabase(async (ctx) => {
      const vti = await ctx.seedInstrument({ symbol: "VTI", name: "Vanguard Total Stock Market" });
      const vxus = await ctx.seedInstrument({ symbol: "VXUS", name: "Vanguard Total International" });
      await ctx.seedInstrumentAlias({ instrument: vti, rawString: "BRK\nCLASS B" });
      await ctx.seedInstrumentAlias({ instrument: vxus, rawString: "BRK\r\nCLASS B" });

      const same = await action(
        args(
          post("/settings/instruments", {
            intent: "repoint",
            rawString: "BRK\r\nCLASS B",
            fromInstrumentId: vxus.id,
            instrumentId: vxus.id,
          }),
        ),
      );
      expect(same.errors).toMatchObject({ instrumentId: expect.stringContaining("already means VXUS") });

      const markup = renderRoute(Instruments, "/settings/instruments", await loader(), {
        actionData: same,
      });
      const rows = markup.split('<th scope="row"').slice(1);
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.includes("field-error"))).toEqual([false, true]);
    }),
  );
});
