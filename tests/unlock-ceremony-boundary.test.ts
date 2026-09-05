/**
 * The import boundary that keeps `@simplewebauthn/browser` out of every
 * bundle except its own lazily-loaded chunk (docs/adr/0012, spec 0019,
 * ticket 04; `app/lib/unlock-ceremony.ts`'s own header). A test about file
 * layout, on purpose — the same shape `tests/masking-boundary.test.ts`
 * already uses for the analogous risk there: `npm run build` is what proves
 * the built output is actually clean, and this is what stops that from
 * silently stopping being true — a future static `import … from
 * "@simplewebauthn/browser"` would ship the package into the server bundle
 * with nothing red until the next `npm run build`, and this suite runs on
 * every change while that does not.
 *
 * `import type` is exempt, deliberately: `verbatimModuleSyntax` erases it
 * entirely, so it adds nothing to any bundle regardless of which file it
 * sits in (`unlock-ceremony.ts`'s own header) — the rule this file pins is
 * about a *value* import reaching module scope, not about the package's name
 * appearing in a type position.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/** Where the application's own source lives, relative to the repo root. */
const APP = new URL("../app/", import.meta.url).pathname;

/**
 * A static, value-level import of the package — the one shape this boundary
 * refuses. Matched on the import statement itself, multiline and anchored to
 * the start of a line, rather than on any mention of the package name: a
 * comment naming it (and this file's own header does, constantly) is not a
 * violation. `import type` is excluded by the negative lookahead — see this
 * file's own header on why that is the correct exemption rather than a hole
 * in it.
 */
const STATIC_VALUE_IMPORT = /^\s*import\s+(?!type\b)[^;]*\bfrom\s*["']@simplewebauthn\/browser["']/m;

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
    // Without this, a broken path would make the assertion above compare an
    // empty list against an empty list and pass — the failure mode of every
    // test that scans a directory (masking-boundary.test.ts's own rule).
    const paths = await sourceFiles();

    expect(paths).toContain("lib/unlock-ceremony.ts");
    expect(paths).toContain("routes/unlock.tsx");
    // Names a file under `routes/settings/` specifically — this walk is
    // recursive, and a broken descent into that one subdirectory would
    // otherwise still pass the two flat-level checks above.
    expect(paths).toContain("routes/settings/passkeys.tsx");
    expect(paths.length).toBeGreaterThan(30);
  });
});
