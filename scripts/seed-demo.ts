/**
 * A seeded demo database: one plausible household portfolio, generated.
 *
 * This exists so the UI can be looked at — screenshotted, reviewed, styled —
 * against data that has the shape real data has: several accounts at several
 * institutions, two people, statements stretching back three years, a price
 * history with a drawdown in it, one instrument nobody can quote, and a loan
 * that sums negative. Every branch a dashboard has to render is represented,
 * because a screenshot of a portfolio where everything is priced and everything
 * has a cost basis is a screenshot of the easy case.
 *
 * Run it from the repository root, against a throwaway database:
 *
 *   printf 'DATABASE_URL=postgres://portfolio:portfolio@127.0.0.1:55432/portfolio_demo\n' > .env.demo
 *   node --env-file=.env.demo ./server/migrate.ts
 *   node --env-file=.env.demo ./scripts/seed-demo.ts
 *
 * Two properties matter more than the data itself.
 *
 * **It is idempotent.** Everything happens in one transaction: the guard, the
 * wipe of the previous generation, the insert of this one. Run it twice and the
 * second run replaces the first rather than doubling it, and a failure half way
 * through leaves the database exactly as it was.
 *
 * **It refuses to touch data it did not create.** The first successful run
 * stamps a `demo_seed` marker table. A database carrying that marker is ours to
 * overwrite. A database without it must be *pristine* — migrated, and holding
 * nothing but the four seed rows `0001_initial_schema.sql` inserts — or the
 * script exits non-zero having written nothing. There is no `--force`. The one
 * thing this script must never be is a way to lose a real portfolio.
 *
 * Money and quantity are generated as JavaScript numbers and leave as decimal
 * strings, fixed at the scale of the column they land in. That is not a
 * violation of the rule the rest of the codebase keeps (DESIGN.md §4.1): these
 * are invented figures rather than measured ones, and the arithmetic that
 * *reports* on them — every total this script prints — is done in SQL, in
 * `numeric`, by the same view the application reads.
 */
import { ConfigError, loadConfig } from "../server/config.ts";
import { createPool } from "../server/db.ts";
import { pendingMigrations } from "../server/migrations.ts";

import type { Pool, PoolClient, QueryResultRow } from "pg";

/** `YYYY-MM-DD`, as dates cross the driver boundary in both directions. */
type IsoDate = string;

type AssetClass = "equity" | "bond" | "cash" | "other";
type AccountKind = "brokerage" | "401k" | "ira" | "bank" | "liability";
type TaxTreatment = "taxable" | "tax_deferred" | "tax_free";
type PriceSource = "feed" | "fixed" | "manual";

/**
 * How an instrument gets its price history.
 *
 *   * `walk`  — a daily close per weekday: `beta` of the shared market
 *               factor, plus `alpha` of its own annual drift over it.
 *   * `fixed` — a single close, carried forward for ever. The trick the `USD`
 *               seed row uses, and the honest model for a $1.00 NAV money
 *               market fund.
 *   * `none`  — no close and no quote, ever. The collective investment trust
 *               in the workplace plan: no public symbol, no retail quote
 *               (DESIGN.md §4.3). It is what makes the coverage line render.
 */
type Pricing =
  | { kind: "walk"; start: number; alpha: number; beta: number; noise: number }
  | { kind: "fixed"; price: number }
  | { kind: "none" };

type InstrumentSeed = {
  /** How the account tables below refer to it; the symbol, where there is one. */
  key: string;
  symbol: string | null;
  name: string;
  quoteType: string | null;
  priceSource: PriceSource;
  classification: string;
  pricing: Pricing;
  /** Percent, as a decimal string. Written to `quote.yield_pct`. */
  yieldPct?: string;
  /** One instrument is left stale on purpose: the UI has a branch for it. */
  stale?: boolean;
  /** Extra strings a CSV might carry for it, beyond the symbol and the name. */
  aliases?: string[];
};

/**
 * How a holding's quantity moves across the statements.
 *
 *   * `accumulate` — shares, sized so the newest statement is worth
 *                    `endValue`, with `growth` of the final share count bought
 *                    over the window. Contributions, not trades.
 *   * `units`      — the same shape for an instrument with no price to size it
 *                    against.
 *   * `balance`    — a cash balance, drifting up with noise on it. A savings
 *                    account is not monotonic.
 *   * `amortise`   — a loan principal walking toward zero. Negative throughout:
 *                    the sign lives in quantity (DESIGN.md §2).
 */
type Sizing =
  | {
      model: "accumulate";
      endValue: number;
      growth: number;
      /**
       * What the opening lot cost, as a multiple of the day-zero close. Below 1
       * for a position accumulated over the years before day zero, above 1 for
       * one bought into a peak — which is where the holdings reporting a loss
       * come from, and they have to exist for the screen to have anything red.
       */
      openingFactor: number;
    }
  | { model: "units"; endUnits: number; growth: number }
  | { model: "balance"; startValue: number; endValue: number; swing: number }
  | { model: "amortise"; startValue: number; endValue: number };

type HoldingSeed = {
  instrument: string;
  sizing: Sizing;
  /**
   * Whether the statement carries a cost basis. False for both 401(k)s and for
   * every cash position, which is the real distribution — and the reason the
   * unrealized figure has to be labelled as covering only part of the
   * portfolio.
   */
  reportsCostBasis: boolean;
};

type AccountSeed = {
  name: string;
  institution: string;
  kind: AccountKind;
  owner: string;
  taxTreatment: TaxTreatment;
  externalAccountNumber: string | null;
  /** Brokerage statements arrive quarterly; a balance is set every month. */
  cadence: "quarterly" | "monthly";
  source: "upload" | "manual";
  /** Names the CSV a set came from. Null for the manual "set balance" path. */
  filePrefix: string | null;
  holdings: HoldingSeed[];
};

const PEOPLE = ["Alex Rivera", "Jordan Rivera"];

/**
 * The user's labels, and the fixed rollup underneath them (DESIGN.md §4.4).
 * `Cash` is deliberately absent: the initial migration seeds it, it is unique
 * by name, and `USD` already points at it.
 */
const CLASSIFICATIONS: { name: string; assetClass: AssetClass }[] = [
  { name: "Total US market", assetClass: "equity" },
  { name: "S&P 500", assetClass: "equity" },
  { name: "International developed", assetClass: "equity" },
  { name: "Emerging markets", assetClass: "equity" },
  { name: "Large-cap growth", assetClass: "equity" },
  { name: "Individual stock", assetClass: "equity" },
  { name: "US total bond", assetClass: "bond" },
  { name: "Short-term Treasuries", assetClass: "bond" },
  { name: "Core bond", assetClass: "bond" },
  { name: "Money market", assetClass: "cash" },
  { name: "Real estate", assetClass: "other" },
  { name: "Target date fund", assetClass: "other" },
];

const INSTRUMENTS: InstrumentSeed[] = [
  {
    key: "VTI", symbol: "VTI", name: "Vanguard Total Stock Market ETF",
    quoteType: "ETF", priceSource: "feed", classification: "Total US market",
    pricing: { kind: "walk", start: 221.5, alpha: 0, beta: 1, noise: 0.0035 },
    yieldPct: "1.280000",
    aliases: ["VANGUARD TOTAL STOCK MARKET ETF"],
  },
  {
    key: "VXUS", symbol: "VXUS", name: "Vanguard Total International Stock ETF",
    quoteType: "ETF", priceSource: "feed", classification: "International developed",
    pricing: { kind: "walk", start: 56.2, alpha: -0.012, beta: 0.85, noise: 0.0045 },
    yieldPct: "3.050000",
  },
  {
    key: "VNQ", symbol: "VNQ", name: "Vanguard Real Estate ETF",
    quoteType: "ETF", priceSource: "feed", classification: "Real estate",
    pricing: { kind: "walk", start: 82.4, alpha: -0.05, beta: 0.9, noise: 0.006 },
    yieldPct: "3.850000",
    // The one stale price in the set: a quote that failed to refresh keeps its
    // last known value and says so, rather than falling to zero (§6.2).
    stale: true,
  },
  {
    key: "VGSH", symbol: "VGSH", name: "Vanguard Short-Term Treasury ETF",
    quoteType: "ETF", priceSource: "feed", classification: "Short-term Treasuries",
    pricing: { kind: "walk", start: 58.1, alpha: 0.005, beta: 0.05, noise: 0.001 },
    yieldPct: "4.100000",
  },
  {
    key: "AAPL", symbol: "AAPL", name: "Apple Inc.",
    quoteType: "EQUITY", priceSource: "feed", classification: "Individual stock",
    pricing: { kind: "walk", start: 189.2, alpha: 0.03, beta: 1.15, noise: 0.011 },
    yieldPct: "0.480000",
  },
  {
    key: "MSFT", symbol: "MSFT", name: "Microsoft Corporation",
    quoteType: "EQUITY", priceSource: "feed", classification: "Individual stock",
    pricing: { kind: "walk", start: 334.6, alpha: 0.06, beta: 1.1, noise: 0.0105 },
    yieldPct: "0.720000",
  },
  {
    key: "SPAXX", symbol: "SPAXX", name: "Fidelity Government Money Market Fund",
    quoteType: "MUTUALFUND", priceSource: "fixed", classification: "Money market",
    pricing: { kind: "fixed", price: 1.0 },
    yieldPct: "4.950000",
    aliases: ["SPAXX**", "Cash & Cash Investments"],
  },
  {
    key: "VIIIX", symbol: "VIIIX", name: "Vanguard Institutional Index Fund Instl Plus",
    quoteType: "MUTUALFUND", priceSource: "feed", classification: "S&P 500",
    pricing: { kind: "walk", start: 361.8, alpha: 0.01, beta: 1, noise: 0.003 },
    yieldPct: "1.320000",
  },
  {
    key: "VTSNX", symbol: "VTSNX", name: "Vanguard Total Intl Stock Index Fund Instl",
    quoteType: "MUTUALFUND", priceSource: "feed", classification: "International developed",
    pricing: { kind: "walk", start: 118.4, alpha: -0.012, beta: 0.85, noise: 0.004 },
    yieldPct: "3.100000",
  },
  {
    key: "VBTLX", symbol: "VBTLX", name: "Vanguard Total Bond Market Index Admiral",
    quoteType: "MUTUALFUND", priceSource: "feed", classification: "US total bond",
    pricing: { kind: "walk", start: 9.62, alpha: 0.005, beta: 0.12, noise: 0.0018 },
    yieldPct: "3.600000",
  },
  {
    key: "VOO", symbol: "VOO", name: "Vanguard S&P 500 ETF",
    quoteType: "ETF", priceSource: "feed", classification: "S&P 500",
    pricing: { kind: "walk", start: 405.3, alpha: 0.01, beta: 1, noise: 0.0032 },
    yieldPct: "1.300000",
  },
  {
    key: "VWO", symbol: "VWO", name: "Vanguard FTSE Emerging Markets ETF",
    quoteType: "ETF", priceSource: "feed", classification: "Emerging markets",
    pricing: { kind: "walk", start: 40.1, alpha: -0.025, beta: 0.95, noise: 0.007 },
    yieldPct: "3.200000",
  },
  {
    key: "BND", symbol: "BND", name: "Vanguard Total Bond Market ETF",
    quoteType: "ETF", priceSource: "feed", classification: "US total bond",
    pricing: { kind: "walk", start: 71.6, alpha: 0.005, beta: 0.12, noise: 0.0018 },
    yieldPct: "3.550000",
  },
  {
    key: "PRGFX", symbol: "PRGFX", name: "T. Rowe Price Growth Stock Fund",
    quoteType: "MUTUALFUND", priceSource: "feed", classification: "Large-cap growth",
    pricing: { kind: "walk", start: 77.9, alpha: 0.02, beta: 1.12, noise: 0.006 },
    yieldPct: "0.150000",
  },
  {
    key: "PTTRX", symbol: "PTTRX", name: "PIMCO Total Return Fund Institutional",
    quoteType: "MUTUALFUND", priceSource: "feed", classification: "Core bond",
    pricing: { kind: "walk", start: 8.68, alpha: 0.006, beta: 0.15, noise: 0.0022 },
    yieldPct: "4.200000",
  },
  {
    // No symbol, no quote type, no price, ever. A collective investment trust
    // inside a workplace plan (DESIGN.md §4.3) — and the reason every total in
    // this database is labelled "17 of 18 holdings" rather than reported whole.
    key: "PLT2045", symbol: null,
    name: "Principal LifeTime 2045 Collective Investment Trust",
    quoteType: null, priceSource: "manual", classification: "Target date fund",
    pricing: { kind: "none" },
  },
];

const ACCOUNTS: AccountSeed[] = [
  {
    name: "Fidelity Individual",
    institution: "Fidelity",
    kind: "brokerage",
    owner: "Alex Rivera",
    taxTreatment: "taxable",
    externalAccountNumber: "X47-283910",
    cadence: "quarterly",
    source: "upload",
    filePrefix: "fidelity-positions",
    holdings: [
      { instrument: "VTI", reportsCostBasis: true, sizing: { model: "accumulate", endValue: 86_000, growth: 0.16, openingFactor: 0.72 } },
      { instrument: "VXUS", reportsCostBasis: true, sizing: { model: "accumulate", endValue: 28_000, growth: 0.18, openingFactor: 0.86 } },
      { instrument: "AAPL", reportsCostBasis: true, sizing: { model: "accumulate", endValue: 24_000, growth: 0.05, openingFactor: 0.6 } },
      { instrument: "MSFT", reportsCostBasis: true, sizing: { model: "accumulate", endValue: 26_000, growth: 0.05, openingFactor: 0.55 } },
      { instrument: "VNQ", reportsCostBasis: true, sizing: { model: "accumulate", endValue: 14_000, growth: 0.1, openingFactor: 1.05 } },
      { instrument: "VGSH", reportsCostBasis: true, sizing: { model: "accumulate", endValue: 18_000, growth: 0.35, openingFactor: 0.99 } },
      // The sweep. A cash balance, so no cost basis and no straight line.
      { instrument: "SPAXX", reportsCostBasis: false, sizing: { model: "balance", startValue: 9_000, endValue: 16_000, swing: 2_600 } },
    ],
  },
  {
    name: "Empower 401(k)",
    institution: "Empower",
    kind: "401k",
    owner: "Alex Rivera",
    taxTreatment: "tax_deferred",
    externalAccountNumber: null,
    cadence: "quarterly",
    source: "upload",
    filePrefix: "empower-balances",
    // Not one cost basis in the account: 401(k) statements routinely omit it,
    // and inventing a zero would report a fake gain equal to the position.
    holdings: [
      { instrument: "VIIIX", reportsCostBasis: false, sizing: { model: "accumulate", endValue: 168_000, growth: 0.28, openingFactor: 0.7 } },
      { instrument: "VTSNX", reportsCostBasis: false, sizing: { model: "accumulate", endValue: 52_000, growth: 0.3, openingFactor: 0.85 } },
      { instrument: "VBTLX", reportsCostBasis: false, sizing: { model: "accumulate", endValue: 48_000, growth: 0.32, openingFactor: 0.99 } },
    ],
  },
  {
    name: "Vanguard Roth IRA",
    institution: "Vanguard",
    kind: "ira",
    owner: "Alex Rivera",
    taxTreatment: "tax_free",
    externalAccountNumber: "78122064",
    cadence: "quarterly",
    source: "upload",
    filePrefix: "vanguard-holdings",
    holdings: [
      { instrument: "VOO", reportsCostBasis: true, sizing: { model: "accumulate", endValue: 58_000, growth: 0.24, openingFactor: 0.7 } },
      { instrument: "VWO", reportsCostBasis: true, sizing: { model: "accumulate", endValue: 16_000, growth: 0.2, openingFactor: 1.25 } },
      { instrument: "BND", reportsCostBasis: true, sizing: { model: "accumulate", endValue: 22_000, growth: 0.26, openingFactor: 1 } },
    ],
  },
  {
    name: "Principal 401(k)",
    institution: "Principal",
    kind: "401k",
    owner: "Jordan Rivera",
    taxTreatment: "tax_deferred",
    externalAccountNumber: null,
    cadence: "quarterly",
    source: "upload",
    filePrefix: "principal-statement",
    holdings: [
      { instrument: "PRGFX", reportsCostBasis: true, sizing: { model: "accumulate", endValue: 56_000, growth: 0.3, openingFactor: 0.66 } },
      { instrument: "PTTRX", reportsCostBasis: true, sizing: { model: "accumulate", endValue: 32_000, growth: 0.34, openingFactor: 0.99 } },
      // Sized in units, because there is no price to size it against.
      { instrument: "PLT2045", reportsCostBasis: false, sizing: { model: "units", endUnits: 1_450, growth: 0.3 } },
    ],
  },
  {
    name: "Ally Online Savings",
    institution: "Ally Bank",
    kind: "bank",
    owner: "Jordan Rivera",
    taxTreatment: "taxable",
    externalAccountNumber: "4402996311",
    // A balance typed into the "set balance" form every month: source `manual`,
    // no file behind it (DESIGN.md §5.2).
    cadence: "monthly",
    source: "manual",
    filePrefix: null,
    holdings: [
      { instrument: "USD", reportsCostBasis: false, sizing: { model: "balance", startValue: 26_000, endValue: 42_000, swing: 3_400 } },
    ],
  },
  {
    name: "Chase Auto Loan",
    institution: "Chase",
    kind: "liability",
    owner: "Alex Rivera",
    // The regime the debt sits in. There is no fourth value for "not an asset":
    // a liability is an account whose positions sum negative, and nothing else.
    taxTreatment: "taxable",
    externalAccountNumber: null,
    cadence: "monthly",
    source: "manual",
    filePrefix: null,
    holdings: [
      { instrument: "USD", reportsCostBasis: false, sizing: { model: "amortise", startValue: -32_000, endValue: -14_500 } },
    ],
  },
];

/**
 * The hand-typed series that prefixes the chart (DESIGN.md §7), as fractions of
 * computed net worth on day zero.
 *
 * Fractions rather than figures, and multiplied out **in SQL** against what the
 * as-of function actually reports for day zero — so the dashed prefix meets the
 * solid line instead of ending at an unrelated number, whenever this is re-run
 * and whatever the generated prices did.
 */
const MANUAL_PREFIX_FACTORS = [0.44, 0.5, 0.58, 0.67, 0.78, 0.71, 0.79, 0.92];

const DAY_MS = 86_400_000;
const TRADING_DAYS = 252;
const HISTORY_YEARS = 3;
/** The newest statement is a few days old, as a real one always is. */
const STATEMENT_LAG_DAYS = 4;
/** Closes start before day zero, so an as-of query on it has a price to find. */
const PRICE_LEAD_DAYS = 45;

const isoOf = (ms: number): IsoDate => new Date(ms).toISOString().slice(0, 10);
const msOf = (date: IsoDate): number => Date.parse(`${date}T00:00:00Z`);
const endOfMonth = (year: number, month: number): IsoDate => isoOf(Date.UTC(year, month + 1, 0));

/** `noUncheckedIndexedAccess` is on; this is the loud version of `array[i]`. */
function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`No element at index ${index} of ${items.length}.`);
  return item;
}

type Calendar = {
  today: IsoDate;
  /** Weekdays only. A weekend gets no row and resolves to Friday (§6.2). */
  priceDates: IsoDate[];
  quarterly: IsoDate[];
  monthly: IsoDate[];
  dayZero: IsoDate;
  latest: IsoDate;
  manualDates: IsoDate[];
};

/**
 * Every date the seed needs, measured from today rather than hardcoded, so a
 * database re-seeded next year is not three years stale.
 */
function buildCalendar(now: Date): Calendar {
  const today = isoOf(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const latest = isoOf(msOf(today) - STATEMENT_LAG_DAYS * DAY_MS);
  const start = Date.UTC(now.getUTCFullYear() - HISTORY_YEARS, now.getUTCMonth(), 1);

  const monthEnds: IsoDate[] = [];
  for (let ms = start; ms < msOf(today); ) {
    const cursor = new Date(ms);
    const end = endOfMonth(cursor.getUTCFullYear(), cursor.getUTCMonth());
    if (end < latest) monthEnds.push(end);
    ms = Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1);
  }

  const isQuarterEnd = (date: IsoDate): boolean =>
    [2, 5, 8, 11].includes(new Date(msOf(date)).getUTCMonth());

  const quarterEnds = monthEnds.filter(isQuarterEnd);
  // Day zero is the first quarter end, and the monthly accounts are trimmed to
  // start there too. Letting the bank account reach back a month further would
  // put a single $12k point in front of the whole portfolio, and the chart's
  // first year would be a cliff rather than a line.
  const dayZero = at(quarterEnds, 0);

  const priceDates: IsoDate[] = [];
  for (let ms = msOf(dayZero) - PRICE_LEAD_DAYS * DAY_MS; ms <= msOf(today); ms += DAY_MS) {
    const weekday = new Date(ms).getUTCDay();
    if (weekday >= 1 && weekday <= 5) priceDates.push(isoOf(ms));
  }

  // Semi-annual hand-typed points, the last one a quarter before day zero.
  const anchor = new Date(msOf(dayZero));
  const manualDates: IsoDate[] = [];
  for (let index = MANUAL_PREFIX_FACTORS.length; index >= 1; index--) {
    const monthsBack = 3 + 6 * (index - 1);
    manualDates.push(endOfMonth(anchor.getUTCFullYear(), anchor.getUTCMonth() - monthsBack));
  }

  return {
    today,
    priceDates,
    quarterly: [...quarterEnds, latest],
    monthly: [...monthEnds.filter((date) => date >= dayZero), latest],
    dayZero,
    latest,
    manualDates,
  };
}

/** mulberry32. Seeded, so two runs of this script produce the same portfolio. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function makeGaussian(random: () => number): () => number {
  return () => Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
}

const SEED = 20260318;
const MARKET_DRIFT = 0.2;
const MARKET_VOL = 0.0068;

const round = (value: number, places: number): number => {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
};

type Series = { date: IsoDate; close: number }[];

/** The last close on or before `date` — the carry-forward, in JavaScript. */
function closeAt(series: Series, date: IsoDate): number | null {
  let found: number | null = null;
  for (const point of series) {
    if (point.date > date) break;
    found = point.close;
  }
  return found;
}

/**
 * A close per weekday per priced instrument, correlated through one market
 * factor.
 *
 * Independent walks were the first attempt and look wrong: fourteen unrelated
 * squiggles average into a net worth line with no shape at all. One shared
 * factor with a beta per instrument gives the household line the drawdown and
 * the recovery that make a three-year chart worth looking at, and leaves the
 * bond funds nearly flat through both, as bond funds are.
 */
function buildPrices(calendar: Calendar, gauss: () => number): Map<string, Series> {
  const dates = calendar.priceDates;
  const market: number[] = [];

  for (let day = 0; day < dates.length; day++) {
    const phase = day / dates.length;
    // Two rough patches, so "1Y" and "All" do not tell the same story.
    const bear = phase > 0.42 && phase < 0.49;
    const wobble = phase > 0.78 && phase < 0.82;
    const drift = bear ? -1 : wobble ? -0.4 : MARKET_DRIFT;
    const vol = MARKET_VOL * (bear ? 1.9 : wobble ? 1.4 : 1);
    market.push(drift / TRADING_DAYS - (vol * vol) / 2 + vol * gauss());
  }

  const prices = new Map<string, Series>();

  for (const instrument of INSTRUMENTS) {
    const pricing = instrument.pricing;

    if (pricing.kind === "none") continue;

    if (pricing.kind === "fixed") {
      // One row, carried forward for ever — exactly what the migration's
      // 1970-01-01 `USD` close does, for exactly the same reason.
      prices.set(instrument.key, [{ date: at(dates, 0), close: pricing.price }]);
      continue;
    }

    // `alpha` is drift *over* the market, not instead of it. Subtracting the
    // market's expected drift back out of each instrument — the obvious way to
    // make `alpha` read as a total return — cancels the two falling stretches
    // out of every instrument and leaves three years in which nothing happened.
    // The noise term keeps `alpha` the log drift it claims to be rather than
    // that plus half a variance.
    const drift = pricing.alpha / TRADING_DAYS - (pricing.noise * pricing.noise) / 2;
    const series: Series = [];
    let price = pricing.start;

    for (let day = 0; day < dates.length; day++) {
      price *= Math.exp(pricing.beta * at(market, day) + drift + pricing.noise * gauss());
      series.push({ date: at(dates, day), close: round(price, 4) });
    }

    prices.set(instrument.key, series);
  }

  return prices;
}

/**
 * The quantity on each statement, and the cost basis reported beside it.
 *
 * Quantities only move on statement dates, which is not a simplification but
 * the model: positions are constant between uploads by construction
 * (DESIGN.md §3), so everything the chart does between two statements is price.
 *
 * The basis is accumulated the way a real one is — the opening lot at a factor
 * of the day-zero price, standing in for the years of buying that happened
 * before the app existed (above 1 for a position bought into a peak, which is
 * where the holdings showing a loss come from), and each later contribution at
 * that quarter's close — so
 * unrealized gain comes out looking like unrealized gain rather than a
 * percentage someone typed.
 */
function buildQuantities(
  holding: HoldingSeed,
  dates: IsoDate[],
  series: Series | undefined,
  random: () => number,
): { quantity: number[]; costBasis: (number | null)[] } {
  const last = dates.length - 1;
  const sizing = holding.sizing;
  const quantity: number[] = [];

  if (sizing.model === "balance" || sizing.model === "amortise") {
    for (let index = 0; index <= last; index++) {
      const progress = index / last;
      const straight = sizing.startValue + (sizing.endValue - sizing.startValue) * progress;
      // A savings balance is not a ramp; a loan principal is. The endpoints are
      // exact either way, so the newest statement lands on the figure asked for.
      const noise =
        sizing.model === "balance" && index > 0 && index < last
          ? sizing.swing * (random() * 2 - 1)
          : 0;
      quantity.push(round(straight + noise, 6));
    }
    // No basis: a bank balance has no cost, and neither does a loan.
    return { quantity, costBasis: dates.map(() => null) };
  }

  const endQuantity =
    sizing.model === "units"
      ? sizing.endUnits
      : sizing.endValue / requirePrice(series, at(dates, last), holding.instrument);

  for (let index = 0; index <= last; index++) {
    const bought = (sizing.growth * (last - index)) / last;
    quantity.push(round(endQuantity * (1 - bought), 6));
  }

  if (!holding.reportsCostBasis || series === undefined || sizing.model === "units") {
    return { quantity, costBasis: dates.map(() => null) };
  }

  const opening = sizing.model === "accumulate" ? sizing.openingFactor : 1;
  const costBasis: (number | null)[] = [];
  let shares = 0;
  let cost = 0;

  for (let index = 0; index <= last; index++) {
    const price = requirePrice(series, at(dates, index), holding.instrument);
    const held = at(quantity, index);
    if (index === 0) {
      shares = held;
      cost = held * price * opening;
    } else {
      cost += Math.max(held - shares, 0) * price;
      shares = held;
    }
    costBasis.push(shares === 0 ? null : round(cost / shares, 4));
  }

  return { quantity, costBasis };
}

function requirePrice(series: Series | undefined, date: IsoDate, key: string): number {
  const price = series === undefined ? null : closeAt(series, date);
  if (price === null || price === 0) {
    throw new Error(`No generated close for ${key} on or before ${date}.`);
  }
  return price;
}

const MARKER_TABLE = "demo_seed";

/**
 * What the initial migration leaves behind, and therefore what "pristine" means.
 * Anything else in these tables belongs to somebody, and this script does not
 * get to decide it is disposable.
 */
const PRISTINE_PROBE = `
  select
    (select count(*) from person)                                              as people,
    (select count(*) from account)                                             as accounts,
    (select count(*) from position_set)                                        as "position sets",
    (select count(*) from holding)                                             as holdings,
    (select count(*) from manual_networth)                                     as "manual points",
    (select count(*) from instrument_alias)                                    as aliases,
    (select count(*) from column_mapping)                                      as "column mappings",
    (select count(*) from classification where name <> 'Cash')                 as classifications,
    (select count(*) from instrument where symbol is distinct from 'USD')      as instruments,
    (select count(*) from price_daily pd join instrument i on i.id = pd.instrument_id
       where i.symbol is distinct from 'USD')                                  as "daily closes",
    (select count(*) from quote q join instrument i on i.id = q.instrument_id
       where i.symbol is distinct from 'USD')                                  as quotes
`;

class RefusedError extends Error {
  override readonly name = "RefusedError";
}

async function assertSafeToSeed(client: PoolClient): Promise<boolean> {
  const marker = await one<{ present: boolean }>(
    client,
    `select to_regclass($1) is not null as present`,
    [`public.${MARKER_TABLE}`],
  );

  if (marker.present) return true;

  const counts = await one<Record<string, string>>(client, PRISTINE_PROBE);
  const populated = Object.entries(counts).filter(([, count]) => count !== "0");

  if (populated.length > 0) {
    throw new RefusedError(
      [
        "Refusing to seed: this database already holds data that this script did not create.",
        "",
        ...populated.map(([table, count]) => `  ${count} ${table}`),
        "",
        `There is no \`${MARKER_TABLE}\` marker table, so nothing here is safe to overwrite.`,
        "Point DATABASE_URL at a throwaway database and run the migrations against it first.",
      ].join("\n"),
    );
  }

  return false;
}

/**
 * Everything this script has ever written, removed in dependency order.
 *
 * `position_set` first, because deleting it cascades its holdings and releases
 * the RESTRICT references onto `account` and `instrument`; `classification`
 * last, because instruments hold it back. The `USD` instrument, its `Cash`
 * classification, its quote and its load-bearing 1970 close belong to the
 * initial migration and survive.
 */
const WIPE = [
  `delete from position_set`,
  `delete from account`,
  `delete from person`,
  `delete from instrument_alias`,
  `delete from quote where instrument_id <> (select id from instrument where symbol = 'USD')`,
  `delete from price_daily where instrument_id <> (select id from instrument where symbol = 'USD')`,
  `delete from instrument where symbol is distinct from 'USD'`,
  `delete from classification where name <> 'Cash'`,
  `delete from manual_networth`,
  `delete from column_mapping`,
];

async function all<T extends QueryResultRow>(
  client: PoolClient,
  text: string,
  values: unknown[] = [],
): Promise<T[]> {
  const result = await client.query<T>(text, values);
  return result.rows;
}

async function one<T extends QueryResultRow>(
  client: PoolClient,
  text: string,
  values: unknown[] = [],
): Promise<T> {
  const [first] = await all<T>(client, text, values);
  if (first === undefined) throw new Error(`Expected one row from: ${text.trim().slice(0, 60)}…`);
  return first;
}

function chunk<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
}

/** Grouped digits without `Number()`: money never becomes a float, even to print. */
function money(amount: string): string {
  const [whole = "0", fraction = "00"] = amount.split(".");
  const negative = whole.startsWith("-");
  const digits = (negative ? whole.slice(1) : whole).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}$${digits}.${fraction.slice(0, 2).padEnd(2, "0")}`;
}

const pad = (value: string | number, width: number): string => String(value).padStart(width);

function redact(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password !== "") parsed.password = "***";
    return parsed.toString();
  } catch {
    return "(unparseable DATABASE_URL)";
  }
}

type Written = { table: string; rows: number };

async function seed(client: PoolClient, calendar: Calendar): Promise<Written[]> {
  const random = makeRandom(SEED);
  const prices = buildPrices(calendar, makeGaussian(random));
  const written: Written[] = [];

  const people = new Map<string, string>();
  for (const person of await all<{ id: string; name: string }>(
    client,
    `insert into person (name) select * from unnest($1::text[]) returning id, name`,
    [PEOPLE],
  )) {
    people.set(person.name, person.id);
  }
  written.push({ table: "person", rows: people.size });

  /* classifications — plus the `Cash` row the migration already seeded */
  await client.query(
    `insert into classification (name, asset_class) select * from unnest($1::text[], $2::text[])`,
    [CLASSIFICATIONS.map((c) => c.name), CLASSIFICATIONS.map((c) => c.assetClass)],
  );
  const classifications = new Map<string, string>();
  for (const row of await all<{ id: string; name: string }>(
    client,
    `select id, name from classification`,
  )) {
    classifications.set(row.name, row.id);
  }
  written.push({ table: "classification", rows: CLASSIFICATIONS.length });

  const instruments = new Map<string, string>();
  for (const row of await all<{ id: string; name: string }>(
    client,
    `insert into instrument (symbol, name, quote_type, price_source, classification_id)
     select * from unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::bigint[])
     returning id, name`,
    [
      INSTRUMENTS.map((i) => i.symbol),
      INSTRUMENTS.map((i) => i.name),
      INSTRUMENTS.map((i) => i.quoteType),
      INSTRUMENTS.map((i) => i.priceSource),
      INSTRUMENTS.map((i) => {
        const id = classifications.get(i.classification);
        if (id === undefined) throw new Error(`No classification named ${i.classification}.`);
        return id;
      }),
    ],
  )) {
    instruments.set(row.name, row.id);
  }

  // Re-key by the short name the account tables use, and pick up `USD`.
  const byKey = new Map<string, string>();
  for (const instrument of INSTRUMENTS) {
    const id = instruments.get(instrument.name);
    if (id === undefined) throw new Error(`Instrument ${instrument.name} was not inserted.`);
    byKey.set(instrument.key, id);
  }
  const usd = await one<{ id: string }>(client, `select id from instrument where symbol = 'USD'`);
  byKey.set("USD", usd.id);
  written.push({ table: "instrument", rows: INSTRUMENTS.length });

  /* aliases — every string a CSV has ever been seen to carry (§4.3) */
  const aliasStrings: string[] = [];
  const aliasIds: string[] = [];
  const pushAlias = (raw: string, id: string): void => {
    if (aliasStrings.includes(raw)) return;
    aliasStrings.push(raw);
    aliasIds.push(id);
  };
  for (const instrument of INSTRUMENTS) {
    const id = byKey.get(instrument.key);
    if (id === undefined) continue;
    if (instrument.symbol !== null) pushAlias(instrument.symbol, id);
    pushAlias(instrument.name, id);
    for (const alias of instrument.aliases ?? []) pushAlias(alias, id);
  }
  for (const raw of ["USD", "US Dollar", "CASH", "Cash", "FDIC-Insured Deposit Sweep"]) {
    pushAlias(raw, usd.id);
  }
  await client.query(
    `insert into instrument_alias (raw_string, instrument_id)
     select * from unnest($1::text[], $2::bigint[])`,
    [aliasStrings, aliasIds],
  );
  written.push({ table: "instrument_alias", rows: aliasStrings.length });

  /* the daily spine */
  const closeIds: string[] = [];
  const closeDates: IsoDate[] = [];
  const closeValues: string[] = [];
  for (const [key, series] of prices) {
    const id = byKey.get(key);
    if (id === undefined) continue;
    for (const point of series) {
      closeIds.push(id);
      closeDates.push(point.date);
      closeValues.push(point.close.toFixed(4));
    }
  }
  for (const batch of chunk(closeIds.map((_, index) => index), 4_000)) {
    await client.query(
      `insert into price_daily (instrument_id, date, close)
       select * from unnest($1::bigint[], $2::date[], $3::numeric[])`,
      [
        batch.map((index) => at(closeIds, index)),
        batch.map((index) => at(closeDates, index)),
        batch.map((index) => at(closeValues, index)),
      ],
    );
  }
  written.push({ table: "price_daily", rows: closeIds.length });

  /* the intraday tier: the last close, plus the one instrument left stale */
  const quoteIds: string[] = [];
  const quotePrices: string[] = [];
  const quoteYields: (string | null)[] = [];
  const quoteDividends: (string | null)[] = [];
  const quoteAsOf: Date[] = [];
  const quoteStale: boolean[] = [];
  const nowMs = Date.now();

  for (const instrument of INSTRUMENTS) {
    const series = prices.get(instrument.key);
    const id = byKey.get(instrument.key);
    if (series === undefined || id === undefined) continue;
    const close = at(series, series.length - 1).close;
    const percent = instrument.yieldPct;
    quoteIds.push(id);
    quotePrices.push(close.toFixed(4));
    quoteYields.push(percent ?? null);
    // Derived from the price rather than typed beside it, so the two agree.
    quoteDividends.push(percent === undefined ? null : ((close * Number(percent)) / 100).toFixed(4));
    // A stale quote is one that failed to refresh: the price is old, and used.
    quoteAsOf.push(new Date(nowMs - (instrument.stale === true ? 3 * DAY_MS : 12 * 60 * 1000)));
    quoteStale.push(instrument.stale === true);
  }
  await client.query(
    `insert into quote (instrument_id, price, yield_pct, annual_dividend_per_share, as_of, is_stale)
     select * from unnest($1::bigint[], $2::numeric[], $3::numeric[], $4::numeric[],
                          $5::timestamptz[], $6::boolean[])`,
    [quoteIds, quotePrices, quoteYields, quoteDividends, quoteAsOf, quoteStale],
  );
  written.push({ table: "quote", rows: quoteIds.length });

  const accounts = new Map<string, string>();
  for (const row of await all<{ id: string; name: string }>(
    client,
    `insert into account (name, institution, kind, owner_id, tax_treatment, external_account_number)
     select * from unnest($1::text[], $2::text[], $3::text[], $4::bigint[], $5::text[], $6::text[])
     returning id, name`,
    [
      ACCOUNTS.map((a) => a.name),
      ACCOUNTS.map((a) => a.institution),
      ACCOUNTS.map((a) => a.kind),
      ACCOUNTS.map((a) => {
        const id = people.get(a.owner);
        if (id === undefined) throw new Error(`No person named ${a.owner}.`);
        return id;
      }),
      ACCOUNTS.map((a) => a.taxTreatment),
      ACCOUNTS.map((a) => a.externalAccountNumber),
    ],
  )) {
    accounts.set(row.name, row.id);
  }
  written.push({ table: "account", rows: accounts.size });

  const holdingSets: string[] = [];
  const holdingInstruments: string[] = [];
  const holdingQuantities: string[] = [];
  const holdingBases: (string | null)[] = [];
  let sets = 0;

  for (const account of ACCOUNTS) {
    const accountId = accounts.get(account.name);
    if (accountId === undefined) throw new Error(`Account ${account.name} was not inserted.`);

    const dates = account.cadence === "quarterly" ? calendar.quarterly : calendar.monthly;
    const filenames = dates.map((date) =>
      account.filePrefix === null ? null : `${account.filePrefix}-${date}.csv`,
    );

    const setIds = new Map<IsoDate, string>();
    for (const row of await all<{ id: string; as_of_date: string }>(
      client,
      `insert into position_set (account_id, as_of_date, source, source_filename)
       select $1::bigint, t.date, $3::text, t.filename
       from unnest($2::date[], $4::text[]) as t(date, filename)
       returning id, cast(as_of_date as text) as as_of_date`,
      [accountId, dates, account.source, filenames],
    )) {
      setIds.set(row.as_of_date, row.id);
    }
    sets += setIds.size;

    for (const holding of account.holdings) {
      const instrumentId = byKey.get(holding.instrument);
      if (instrumentId === undefined) throw new Error(`No instrument ${holding.instrument}.`);

      const series = prices.get(holding.instrument);
      const { quantity, costBasis } = buildQuantities(holding, dates, series, random);

      for (let index = 0; index < dates.length; index++) {
        const setId = setIds.get(at(dates, index));
        if (setId === undefined) throw new Error(`No position set for ${at(dates, index)}.`);
        const basis = at(costBasis, index);
        holdingSets.push(setId);
        holdingInstruments.push(instrumentId);
        holdingQuantities.push(at(quantity, index).toFixed(6));
        // Never defaulted to zero, here or anywhere else: that would report a
        // fake gain equal to the whole untracked position.
        holdingBases.push(basis === null ? null : basis.toFixed(4));
      }
    }
  }

  for (const batch of chunk(holdingSets.map((_, index) => index), 4_000)) {
    await client.query(
      `insert into holding (position_set_id, instrument_id, quantity, cost_basis_per_share)
       select * from unnest($1::bigint[], $2::bigint[], $3::numeric[], $4::numeric[])`,
      [
        batch.map((index) => at(holdingSets, index)),
        batch.map((index) => at(holdingInstruments, index)),
        batch.map((index) => at(holdingQuantities, index)),
        batch.map((index) => holdingBases[index] ?? null),
      ],
    );
  }
  written.push({ table: "position_set", rows: sets });
  written.push({ table: "holding", rows: holdingSets.length });

  /* the hand-typed prefix, scaled off day zero in SQL */
  await client.query(
    `insert into manual_networth (date, amount)
     select t.date,
            cast((select coalesce(sum(value), 0) from holding_valued_at($3::date)) * t.factor
                 as numeric(20, 4))
     from unnest($1::date[], $2::numeric[]) as t(date, factor)`,
    [
      calendar.manualDates,
      MANUAL_PREFIX_FACTORS.map((factor) => factor.toFixed(6)),
      calendar.dayZero,
    ],
  );
  written.push({ table: "manual_networth", rows: calendar.manualDates.length });

  return written;
}

async function report(client: PoolClient, written: Written[]): Promise<void> {
  const database = await one<{ name: string }>(client, `select current_database() as name`);

  const total = await one<{ amount: string; known: string; total: string }>(
    client,
    `select cast(coalesce(sum(value), 0) as numeric(20, 4)) as amount,
            count(*) filter (where is_priced)               as known,
            count(*)                                        as total
     from holding_valued`,
  );

  const span = await one<{ first: string | null; last: string | null }>(
    client,
    `select cast(min(as_of_date) as text) as first, cast(max(as_of_date) as text) as last
     from position_set`,
  );

  const prefix = await one<{ first: string | null; last: string | null; points: string }>(
    client,
    `select cast(min(date) as text) as first, cast(max(date) as text) as last, count(*) as points
     from manual_networth`,
  );

  const closes = await one<{ first: string | null; last: string | null }>(
    client,
    `select cast(min(date) as text) as first, cast(max(date) as text) as last
     from price_daily where date > date '1970-01-01'`,
  );

  const byAccount = await all<{
    account_name: string; institution: string; account_kind: string;
    owner_name: string; amount: string; known: string; total: string;
  }>(
    client,
    `select account_name, institution, account_kind, owner_name,
            cast(coalesce(sum(value), 0) as numeric(20, 4)) as amount,
            count(*) filter (where is_priced)               as known,
            count(*)                                        as total
     from holding_valued
     group by account_name, institution, account_kind, owner_name
     order by coalesce(sum(value), 0) desc`,
  );

  const byPerson = await all<{ owner_name: string; amount: string }>(
    client,
    `select owner_name, cast(coalesce(sum(value), 0) as numeric(20, 4)) as amount
     from holding_valued group by owner_name order by coalesce(sum(value), 0) desc`,
  );

  const byAssetClass = await all<{ asset_class: string; amount: string; total: string }>(
    client,
    `select asset_class, cast(coalesce(sum(value), 0) as numeric(20, 4)) as amount, count(*) as total
     from holding_valued group by asset_class order by coalesce(sum(value), 0) desc`,
  );

  const unpriced = await all<{ instrument_name: string; account_name: string }>(
    client,
    `select instrument_name, account_name from holding_valued where not is_priced
     order by account_name, instrument_name`,
  );

  const basis = await one<{ with_basis: string; total: string }>(
    client,
    `select count(*) filter (where cost_basis_per_share is not null) as with_basis,
            count(*)                                                 as total
     from holding_valued`,
  );

  const line = (label: string, value: string): string => `  ${label.padEnd(22)}${value}`;

  console.log("");
  console.log(`Seeded ${database.name}.`);
  console.log("");
  console.log("  Rows written");
  for (const { table, rows } of written) {
    console.log(`    ${table.padEnd(20)}${pad(rows.toLocaleString("en-US"), 8)}`);
  }
  console.log("");
  console.log(line("Net worth now", `${money(total.amount)}  (known ${total.known} of ${total.total} holdings)`));
  console.log(line("Cost basis on", `${basis.with_basis} of ${basis.total} holdings`));
  console.log(line("Day zero", String(span.first)));
  console.log(line("Newest statement", String(span.last)));
  console.log(line("Daily closes", `${String(closes.first)} → ${String(closes.last)}`));
  console.log(line("Manual prefix", `${String(prefix.first)} → ${String(prefix.last)}  (${prefix.points} points)`));
  console.log("");
  console.log("  Accounts");
  for (const account of byAccount) {
    console.log(
      `    ${account.account_name.padEnd(22)}${account.institution.padEnd(12)}` +
        `${account.account_kind.padEnd(11)}${account.owner_name.padEnd(15)}` +
        `${pad(money(account.amount), 14)}  (${account.known} of ${account.total})`,
    );
  }
  console.log("");
  console.log("  By person");
  for (const person of byPerson) {
    console.log(`    ${person.owner_name.padEnd(22)}${pad(money(person.amount), 14)}`);
  }
  console.log("");
  console.log("  By asset class");
  for (const slice of byAssetClass) {
    console.log(`    ${slice.asset_class.padEnd(22)}${pad(money(slice.amount), 14)}  (${slice.total} holdings)`);
  }
  console.log("");
  console.log("  Unpriced, and therefore missing from every total above");
  for (const holding of unpriced) {
    console.log(`    ${holding.instrument_name} — ${holding.account_name}`);
  }
  console.log("");
}

async function main(): Promise<void> {
  const { DATABASE_URL } = loadConfig(process.env);

  let pending: string[];
  try {
    const probe: Pool = createPool(DATABASE_URL);
    try {
      pending = await pendingMigrations(probe);
    } finally {
      await probe.end();
    }
  } catch (cause) {
    throw new Error(
      `Cannot read the migration state of ${redact(DATABASE_URL)}.\n` +
        "Run this from the repository root, against a reachable database.",
      { cause },
    );
  }

  if (pending.length > 0) {
    throw new RefusedError(
      [
        `Refusing to seed: ${pending.length} migration(s) have not been applied.`,
        ...pending.map((filename) => `  ${filename}`),
        "",
        `Apply them first:  node --env-file=<file> ./server/migrate.ts`,
      ].join("\n"),
    );
  }

  console.log(`Seeding ${redact(DATABASE_URL)}`);

  const pool = createPool(DATABASE_URL);
  const client = await pool.connect();

  try {
    // One transaction around the guard, the wipe and the insert. A failure at
    // any point leaves the database exactly as it was found.
    await client.query("begin");

    const reseeding = await assertSafeToSeed(client);
    console.log(
      reseeding
        ? `Replacing the previous generation (the \`${MARKER_TABLE}\` marker is present).`
        : "Seeding a pristine database.",
    );

    for (const statement of WIPE) await client.query(statement);

    await client.query(`
      create table if not exists ${MARKER_TABLE} (
        only_row   boolean primary key default true
                   constraint demo_seed_one_row check (only_row),
        seeded_at  timestamptz not null default now(),
        seeded_by  text not null
      )
    `);
    await client.query(
      `insert into ${MARKER_TABLE} (only_row, seeded_at, seeded_by) values (true, now(), $1)
       on conflict (only_row) do update set seeded_at = now(), seeded_by = excluded.seeded_by`,
      ["scripts/seed-demo.ts"],
    );
    await client.query(
      `comment on table ${MARKER_TABLE} is
       'Written by scripts/seed-demo.ts. Its presence marks this database as a '
       'disposable demo instance whose contents that script may overwrite.'`,
    );

    const written = await seed(client, buildCalendar(new Date()));
    await report(client, written);

    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

try {
  await main();
} catch (error) {
  if (error instanceof ConfigError || error instanceof RefusedError) {
    console.error("");
    console.error(error.message);
    console.error("");
  } else {
    console.error("Seeding failed. Nothing was written.");
    console.error(error);
  }
  process.exit(1);
}
