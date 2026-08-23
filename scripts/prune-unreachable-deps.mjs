/**
 * Remove the production dependencies that only exist because `yahoo-finance2`
 * ships an MCP server and a fetch-mocking library in its runtime `dependencies`.
 *
 * DESIGN.md §6.1 buys one thing from `yahoo-finance2`: `quote()`. Version 4
 * declares seven runtime dependencies to deliver it, and three of them are for
 * features this application does not use — the `yahoo-finance2/mcp` subpath and
 * the two CLI bins:
 *
 *   @modelcontextprotocol/sdk   imported only by esm/src/mcp/** and esm/bin/yahoo-finance-mcp.js
 *   @deno/shim-deno             reached only from esm/deps/jsr.io/**, which only the two bins import
 *   fetch-mock-cache            never imported from JavaScript at all — it appears
 *                               solely inside esm/deno.js, a Deno import-map manifest
 *
 * Together they drag a second copy of Express, Hono, jose, cors, ajv,
 * express-rate-limit and fifty more packages into the runtime image, where
 * nothing can ever load them. That is dormant code in a container that holds
 * financial data, and a standing CVE-triage tax on packages this application
 * does not run.
 *
 * The removal is deliberately narrow. The script marks the tree twice — once
 * with those three edges intact, once with them cut — and deletes only the
 * difference. It therefore cannot remove a package that anything still
 * reachable declares, however the tree happens to be hoisted, and it removes
 * nothing at all if a future `yahoo-finance2` starts importing them from a path
 * the application does use. Anything else npm left behind is left behind: this
 * is not a general garbage collector.
 *
 * Run after `npm prune --omit=dev`, from the repository root. The container
 * smoke test is what proves the result still serves.
 */
import { existsSync, lstatSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";

/** The edges to cut, and the reason each one is unreachable. See the header. */
const CUT = new Set(["@modelcontextprotocol/sdk", "@deno/shim-deno", "fetch-mock-cache"]);

/** The dependent whose edges are cut. Cutting is scoped to it, not global. */
const CUT_FROM = "yahoo-finance2";

/**
 * `yahoo-finance2`'s own CLI bins, which are the things the cut edges exist
 * for. Their entry files survive — they live inside the package — but their
 * imports do not, so npm's `.bin` links would point at commands that now throw.
 * Shipping a broken `yahoo-finance-mcp` in the image is the thing this script
 * is removing, so the links go with it.
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
 * Every directory reachable from the root manifest by following declared
 * dependency edges. `cut` is applied to `CUT_FROM`'s edges only.
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

// npm's `.bin` links are not owned by the packages they point into, so removing
// a package leaves its command behind as a dangling symlink. Sweep those, and
// the bins the cut itself broke.
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
