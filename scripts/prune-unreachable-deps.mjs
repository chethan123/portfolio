/**
 * Remove the production deps that exist only because `yahoo-finance2` ships an
 * MCP server and a fetch-mocker in its runtime `dependencies`. DESIGN.md §6.1
 * buys one thing from it — `quote()` — and three of its seven runtime deps
 * serve the `yahoo-finance2/mcp` subpath and two CLI bins never touched here:
 *
 *   @modelcontextprotocol/sdk   imported only by esm/src/mcp/** and esm/bin/yahoo-finance-mcp.js
 *   @deno/shim-deno             reached only from esm/deps/jsr.io/**, imported only by the bins
 *   fetch-mock-cache            never imported from JS at all — appears only in
 *                               esm/deno.js, a Deno import-map manifest
 *
 * Together they drag a second Express plus Hono, jose, cors, ajv and fifty
 * more packages into the runtime image where nothing can load them: dormant
 * code in a container holding financial data, a standing CVE-triage tax.
 *
 * Deliberately narrow: the tree is marked twice — edges intact, edges cut —
 * and only the difference is deleted. So it cannot remove a package anything
 * still reachable declares, however hoisted, and removes nothing at all if a
 * future `yahoo-finance2` imports these from a used path. Not a general GC.
 *
 * Run after `npm prune --omit=dev`, from the repo root. The container smoke
 * test proves the result still serves.
 */
import { existsSync, lstatSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";

/** The edges to cut; the header has why each is unreachable. */
const CUT = new Set(["@modelcontextprotocol/sdk", "@deno/shim-deno", "fetch-mock-cache"]);

/** Cutting is scoped to this dependent, not global. */
const CUT_FROM = "yahoo-finance2";

/**
 * The package's own CLI bins — what the cut edges exist for. Their entry files
 * survive but their imports do not, so npm's `.bin` links would point at
 * commands that now throw; the links go with the cut.
 */
const CUT_BINS = ["yahoo-finance", "yahoo-finance2", "yahoo-finance-mcp"];

const root = process.cwd();
const nodeModules = path.join(root, "node_modules");

function readManifest(dir) {
  try {
    return JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
  } catch {
    return null;
  }
}

/** Node's own resolution: walk `node_modules` up from `fromDir` to the root. */
function resolvePackage(name, fromDir) {
  let dir = fromDir;
  for (;;) {
    const candidate = path.join(dir, "node_modules", name);
    if (existsSync(path.join(candidate, "package.json"))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir || !dir.startsWith(root)) return null;
    dir = parent;
  }
}

/**
 * Every directory reachable from the root manifest by declared dependency
 * edges; `cut` applies to `CUT_FROM`'s edges only.
 */
function reachable(cut) {
  const marked = new Set();

  const visit = (dir) => {
    if (marked.has(dir)) return;
    marked.add(dir);
    const manifest = readManifest(dir);
    if (!manifest) return;
    const cutting = cut && manifest.name === CUT_FROM;
    const deps = { ...manifest.dependencies, ...manifest.optionalDependencies };
    for (const name of Object.keys(deps)) {
      if (cutting && CUT.has(name)) continue;
      const resolved = resolvePackage(name, dir);
      if (resolved) visit(resolved);
    }
  };

  visit(root);
  return marked;
}

const before = reachable(false);
const after = reachable(true);
const orphaned = [...before].filter((dir) => !after.has(dir) && dir !== root);

// Deepest first, so a nested `node_modules` goes before the package holding it.
orphaned.sort((a, b) => b.length - a.length);

const sizeOf = (dir) => {
  let bytes = 0;
  const stack = [dir];
  while (stack.length > 0) {
    for (const entry of readdirSync(stack.pop(), { withFileTypes: true })) {
      const child = path.join(entry.parentPath, entry.name);
      if (entry.isDirectory()) stack.push(child);
      else if (entry.isFile()) bytes += statSync(child).size;
    }
  }
  return bytes;
};

if (!existsSync(path.join(nodeModules, CUT_FROM))) {
  console.error(`prune-unreachable-deps: no node_modules/${CUT_FROM} — nothing to do.`);
  process.exit(0);
}

let reclaimed = 0;
for (const dir of orphaned) {
  if (!existsSync(dir)) continue;
  reclaimed += sizeOf(dir);
  rmSync(dir, { recursive: true, force: true });
}

// npm's `.bin` links are not owned by the packages they point into, so a
// removed package leaves a dangling symlink. Sweep those, plus the bins the
// cut itself broke.
const bin = path.join(nodeModules, ".bin");
let links = 0;
if (existsSync(bin)) {
  for (const entry of readdirSync(bin)) {
    const link = path.join(bin, entry);
    const dangling = !existsSync(link) && lstatSync(link, { throwIfNoEntry: false }) !== undefined;
    if (dangling || CUT_BINS.includes(entry)) {
      rmSync(link, { force: true });
      links += 1;
    }
  }
}

console.log(
  `prune-unreachable-deps: removed ${orphaned.length} packages ` +
    `(${(reclaimed / 1024 / 1024).toFixed(1)} MB) and ${links} bin links, ` +
    `unreachable once ${[...CUT].join(", ")} are cut from ${CUT_FROM}.`,
);
