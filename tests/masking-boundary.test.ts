/**
 * The import boundary that keeps masking from decaying (spec 0007,
 * ADR-0002). A test about file layout, on purpose: the guarantee — no
 * amount is on this screen — breaks not as a failing assertion but as a
 * route added next year calling `formatMoney` inline, shipping green, and
 * showing a household's balances to the room. No linter here, so the suite
 * is where the rule lives. The stated cost: this file needs updating when
 * those files move — accepted, because the leak is silent and the person
 * who notices is the person it was supposed to protect (story 35). Ratios
 * are deliberately absent: `formatPercent`/`formatShare` are never masked —
 * a ratio describes composition, not size — and a boundary round them would
 * be a boundary round the wrong thing.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/** Where the application's own source lives, relative to the repo root. */
const APP = new URL("../app/", import.meta.url).pathname;

/**
 * Every formatter that renders an amount, and the files allowed to call it.
 *
 * Read as: this figure may only be turned into text in these places. Everything
 * else on every screen has to go through `Amount`, which is what asks whether
 * the screen is masked.
 */
const BOUNDARIES: ReadonlyArray<{
  formatter: string;
  allowed: readonly string[];
  why: string;
}> = [
  {
    formatter: "formatMoney",
    allowed: [
      "components/amount.tsx",
      // The chart's accessible label is a string, so the figure it ends at
      // cannot be a component. The chart takes the masking state as a prop
      // instead and composes the label itself — which is precisely so that the
      // two routes drawing a chart do not have to format an amount to build it.
      "components/net-worth-chart.tsx",
    ],
    why: "every money figure on a screen is an amount",
  },
  {
    formatter: "formatSignedMoney",
    allowed: ["components/amount.tsx"],
    why: "a gain is an amount, and keeps its sign while masked rather than its size",
  },
  {
    formatter: "formatCompact",
    allowed: ["components/net-worth-chart.tsx"],
    why: "the chart's axis ticks are not components, so it takes the state as a prop",
  },
  {
    formatter: "formatQuantity",
    allowed: [
      "components/amount.tsx",
      // The revise-position form fills its boxes from the stored quantity.
      // That is an input a reader deliberately opened, and spec 0007 is
      // explicit that such a field shows its own value — a masked input cannot
      // be typed into. Named here rather than left to a general exemption so
      // that a *second* inline call in this file still fails.
      "routes/holdings.tsx",
    ],
    why: "a share quantity is an amount; the one exception is a form field someone opened",
  },
];

/** Every `.ts`/`.tsx` file under `app/`, as paths relative to it. */
async function sourceFiles(directory = ""): Promise<string[]> {
  const entries = await readdir(join(APP, directory), { withFileTypes: true });

  const found = await Promise.all(
    entries.map(async (entry) => {
      const path = directory === "" ? entry.name : `${directory}/${entry.name}`;

      if (entry.isDirectory()) return sourceFiles(path);
      return /\.tsx?$/.test(entry.name) ? [path] : [];
    }),
  );

  return found.flat();
}

/**
 * The files that import `formatter` by name.
 *
 * Matched on the import statement rather than on any mention of the word, so
 * that a comment naming a formatter — and this codebase's comments name them
 * constantly — is not a violation. The module it comes from is not checked:
 * re-exporting `formatMoney` from somewhere else to get round this would be a
 * deliberate act, and a test cannot stop someone determined to defeat it.
 */
function importers(files: ReadonlyArray<{ path: string; source: string }>, formatter: string) {
  const imported = new RegExp(`import[^;]*\\b${formatter}\\b[^;]*from`, "s");

  return files.filter(({ source }) => imported.test(source)).map(({ path }) => path);
}

describe("the money formatters are only called where masking is decided", () => {
  it.for(BOUNDARIES)("$formatter — $why", async ({ formatter, allowed }) => {
    const paths = await sourceFiles();
    const files = await Promise.all(
      paths.map(async (path) => ({
        path,
        source: await readFile(join(APP, path), "utf8"),
      })),
    );

    // Sorted so a failure reads as a list rather than as filesystem order, and
    // so the diff when this file is legitimately updated is a small one.
    expect(importers(files, formatter).sort()).toEqual([...allowed].sort());
  });

  it("finds the source files it is supposed to be checking", async () => {
    // Without this, a broken path or a changed extension would make every
    // assertion above compare an empty list against an empty list and pass —
    // which is the failure mode of every test that scans a directory.
    const paths = await sourceFiles();

    expect(paths).toContain("components/amount.tsx");
    expect(paths).toContain("routes/overview.tsx");
    expect(paths.length).toBeGreaterThan(30);
  });
});
