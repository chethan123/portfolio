/**
 * AUDIT HARNESS — not part of the application.
 *
 * Yahoo is unreachable from this sandbox, so this drives the application's own
 * price writer (`refreshQuotes`) with a deterministic fake `PriceProvider`.
 * Every price is derived from the symbol, so a re-run writes the same figure
 * unless `--bump` is passed. Nothing here writes a money column directly: the
 * quote, the daily close and the observation log are all written by
 * `app/lib/prices.server.ts`, exactly as a live refresh would.
 *
 *   node --env-file=.env ./audit/fake-refresh.mjs [--bump N]
 *
 * Plain JavaScript on purpose: `tsconfig.json` includes every `.ts` in the tree,
 * and a harness file must not be able to fail `npm run typecheck`.
 */
import { refreshQuotes } from "../app/lib/prices.server.ts";
import { loadConfig } from "../server/config.ts";
import { createDatabase } from "../app/lib/db.server.ts";

const bumpArg = process.argv.indexOf("--bump");
const bump = bumpArg === -1 ? 0 : Number(process.argv[bumpArg + 1] ?? 0);

/** A stable pseudo-price in [5, 905), scale 4, from the symbol's characters. */
function priceFor(symbol) {
  let h = 2166136261;
  for (const ch of symbol) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619) >>> 0;
  }
  const dollars = 5 + (h % 90000) / 100; // 5.00 .. 904.99
  return (dollars + bump).toFixed(4);
}

function dividendFor(symbol) {
  let h = 0;
  for (const ch of symbol) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  if (h % 3 === 0) return null; // a third pay nothing
  return ((h % 400) / 100).toFixed(4);
}

const asOf = new Date();

const provider = {
  async getQuotes(symbols) {
    return symbols.map((symbol) => ({
      symbol,
      price: priceFor(symbol),
      quoteType: symbol.length === 3 ? "ETF" : "EQUITY",
      yieldPct: null,
      annualDividendPerShare: dividendFor(symbol),
      asOf,
      fetchedAt: new Date(),
    }));
  },
};

const config = loadConfig(process.env);
const db = createDatabase(config.DATABASE_URL);
try {
  const report = await refreshQuotes(provider, config.MARKET_TIMEZONE, db);
  console.log(JSON.stringify(report));
} finally {
  await db.destroy();
}
