/**
 * Import boundary keeping @simplewebauthn/browser out of every bundle except its own lazily-loaded
 * chunk (docs/adr/0012, spec 0019, ticket 04). npm run build proves the built output is clean but
 * only on that run — this suite runs on every change. `import type` is exempt: verbatimModuleSyntax
 * erases it entirely.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const APP = new URL("../app/", import.meta.url).pathname;

// static, value-level import of the package — matched on the import statement itself (line-anchored),
// not any mention of the package name, so a comment naming it is not a violation.
const STATIC_VALUE_IMPORT = /^\s*import\s+(?!type\b)[^;]*\bfrom\s*["']@simplewebauthn\/browser["']/m;

// every .ts/.tsx file under app/, as paths relative to it
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

describe("@simplewebauthn/browser never crosses a static value import", () => {
  it("is absent from every file under app/ — reached only through a dynamic import() inside a function body", async () => {
    const paths = await sourceFiles();

    const offending: string[] = [];
    for (const path of paths) {
      const source = await readFile(join(APP, path), "utf8");
      if (STATIC_VALUE_IMPORT.test(source)) offending.push(path);
    }

    expect(offending).toEqual([]);
  });

  it("finds the source files it is supposed to be checking", async () => {
    // guards against silently scanning zero files and passing vacuously (masking-boundary.test.ts's own rule)
    const paths = await sourceFiles();

    expect(paths).toContain("lib/unlock-ceremony.ts");
    expect(paths).toContain("routes/unlock.tsx");
    // names a routes/settings/ file specifically — this walk is recursive, and a broken
    // descent into that one subdirectory would otherwise still pass the flat-level checks above
    expect(paths).toContain("routes/settings/passkeys.tsx");
    expect(paths.length).toBeGreaterThan(30);
  });
});
