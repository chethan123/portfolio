/**
 * Import boundary keeping masking from decaying (spec 0007, ADR-0002). No linter enforces
 * this — the suite is the boundary. Ratios (formatPercent/formatShare) stay unmasked on purpose:
 * they describe composition, not size.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const APP = new URL("../app/", import.meta.url).pathname;

// formatter -> files allowed to call it directly; everything else goes through Amount
const BOUNDARIES: ReadonlyArray<{
  formatter: string;
  allowed: readonly string[];
  why: string;
}> = [
  {
    formatter: "formatMoney",
    allowed: [
      "components/amount.tsx",
      // chart's accessible label is a string, not a component — takes masking state as a prop instead
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
      // revise-position form shows the field's own value per spec 0007 — an opened input isn't masked
      "routes/holdings.tsx",
    ],
    why: "a share quantity is an amount; the one exception is a form field someone opened",
  },
];

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

// Matches import statements only, not mentions in prose. Doesn't check the module path —
// a re-export around this would be deliberate evasion, out of scope.
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

    // sorted: readable failures, small diffs on legitimate updates
    expect(importers(files, formatter).sort()).toEqual([...allowed].sort());
  });

  it("finds the source files it is supposed to be checking", async () => {
    // guards against silently scanning zero files and passing vacuously
    const paths = await sourceFiles();

    expect(paths).toContain("components/amount.tsx");
    expect(paths).toContain("routes/overview.tsx");
    expect(paths.length).toBeGreaterThan(30);
  });
});
