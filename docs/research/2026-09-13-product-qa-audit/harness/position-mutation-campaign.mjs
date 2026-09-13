/**
 * Follow-up evidence for the 2026-09-13 product QA audit.
 *
 * Drives successful position corrections through Chromium, then calculates the expected household,
 * owner, account, cost-basis, gain, and income figures from raw latest holdings and quotes. The
 * arithmetic below intentionally does not import application code.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";
import pg from "pg";

const BASE = process.env.AUDIT_BASE ?? "http://localhost:4279";
const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgres://portfolio:portfolio@127.0.0.1:55439/portfolio_latent";
const CHROME =
  process.env.CHROME ??
  "/home/ubuntu/.cache/ms-playwright/chromium-1234/chrome-linux/chrome";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "position-mutation-ledger.json");
const FIGURES = path.resolve(HERE, "../figures");

const mutations = [
  [1, 2, "300", "165.4961", "VTI ordinary increase"],
  [1, 2, "300.00000001", "165.4961", "VTI eighth-decimal increment"],
  [1, 2, "0", "", "VTI close to zero and clear basis"],
  [1, 2, "-1", "100", "VTI reopen short after zero"],
  [1, 2, "-123.45678901", "120.1234", "VTI negative fractional quantity"],
  [1, 2, "0", "0", "VTI short to zero with zero basis"],
  [1, 2, "0.00000001", "9999999999999999.9999", "VTI tiny quantity and maximal per-share basis"],
  [1, 2, "999999999999", "0.0001", "VTI very large quantity"],
  [1, 2, "1.23456789", "165.4961", "VTI precision boundary"],
  [1, 2, "282.144455", "165.4961", "VTI restore"],

  [1, 6, "100", "100", "AAPL whole quantity"],
  [1, 6, "100.55555555", "0", "AAPL fractional with zero basis"],
  [1, 6, "0", "", "AAPL close and clear basis"],
  [1, 6, "50.5", "200.1234", "AAPL reopen"],
  [1, 6, "139.153103", "108.2561", "AAPL restore"],

  [1, 8, "16000.01", "", "cash cent increment"],
  [1, 8, "0", "", "cash close"],
  [1, 8, "0.01", "", "cash one cent"],
  [1, 8, "16000", "", "cash restore"],

  [2, 9, "350", "400", "401k add basis"],
  [2, 9, "0.00000001", "", "401k minimum positive quantity"],
  [2, 9, "999999.99999999", "482.9198", "401k large fractional quantity"],
  [2, 9, "350.071327", "", "401k restore"],

  [3, 12, "0", "", "Roth position close"],
  [3, 12, "1", "510.5873", "Roth one share"],
  [3, 12, "114.451110", "310.5506", "Roth restore"],

  [4, 15, "755.20145", "50.538", "Jordan no-op normalized spelling"],
  [4, 15, "1000.00000001", "74.5664", "Jordan quantity increase"],
  [4, 15, "755.201450", "50.5380", "Jordan restore"],

  [4, 17, "0", "", "unpriced trust close"],
  [4, 17, "1450.12345678", "25.5", "unpriced trust with basis"],
  [4, 17, "1450", "", "unpriced trust restore"],
];

function units(value, scale) {
  const trimmed = String(value).trim();
  const negative = trimmed.startsWith("-");
  const unsigned = negative || trimmed.startsWith("+") ? trimmed.slice(1) : trimmed;
  const [whole = "0", fraction = ""] = unsigned.split(".");
  const result = BigInt(`${whole || "0"}${fraction.padEnd(scale, "0").slice(0, scale)}`);
  return negative ? -result : result;
}

function roundedQuotient(value, denominator) {
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const rounded = magnitude / denominator + ((magnitude % denominator) * 2n >= denominator ? 1n : 0n);
  return negative ? -rounded : rounded;
}

function product4(quantity, perShare) {
  return roundedQuotient(units(quantity, 8) * units(perShare, 4), 100000000n);
}

function cents(value4) {
  return roundedQuotient(value4, 100n);
}

function moneyFromUi(text) {
  const match = String(text).replaceAll("−", "-").match(/-?\$[\d,]+\.\d{2}/);
  if (!match) throw new Error(`No money value in ${JSON.stringify(text)}`);
  const value = match[0].replace(/[$,]/g, "");
  return units(value, 2);
}

async function rawRows(client) {
  const result = await client.query(`
    select
      a.id::text as account_id,
      a.name as account_name,
      a.owner_id::text as owner_id,
      p.name as owner_name,
      h.instrument_id::text as instrument_id,
      h.quantity::text as quantity,
      h.cost_basis_per_share::text as cost_basis_per_share,
      q.price::text as price,
      q.annual_dividend_per_share::text as annual_dividend_per_share
    from account a
    join person p on p.id = a.owner_id
    join lateral (
      select ps.id
      from position_set ps
      where ps.account_id = a.id
      order by ps.as_of_date desc, ps.created_at desc, ps.id desc
      limit 1
    ) latest on true
    join holding h on h.position_set_id = latest.id
    left join quote q on q.instrument_id = h.instrument_id
    where a.closed_at is null
    order by a.id, h.instrument_id
  `);
  return result.rows;
}

function oracle(rows, predicate = () => true) {
  let value = 0n;
  let basis = 0n;
  let unrealized = 0n;
  let dividend = 0n;
  let priced = 0;
  let based = 0;
  let gains = 0;

  for (const row of rows.filter(predicate)) {
    const rowValue = row.price === null ? null : product4(row.quantity, row.price);
    const rowBasis =
      row.cost_basis_per_share === null ? null : product4(row.quantity, row.cost_basis_per_share);
    const rowDividend =
      row.annual_dividend_per_share === null
        ? 0n
        : product4(row.quantity, row.annual_dividend_per_share);

    if (rowValue !== null) {
      value += rowValue;
      priced += 1;
    }
    if (rowBasis !== null) {
      basis += rowBasis;
      based += 1;
    }
    if (rowValue !== null && rowBasis !== null) {
      unrealized += rowValue - rowBasis;
      gains += 1;
    }
    dividend += rowDividend;
  }

  return {
    value: cents(value),
    basis: cents(basis),
    unrealized: cents(unrealized),
    dividend: cents(dividend),
    holdings: rows.filter(predicate).length,
    priced,
    based,
    gains,
  };
}

async function readHoldingTotals(page, query = "") {
  await page.goto(`${BASE}/holdings${query}`, { waitUntil: "networkidle" });
  const row = page.locator("tfoot tr.row-total");
  return {
    value: moneyFromUi(await row.locator('[data-label="Value"]').innerText()),
    basis: moneyFromUi(await row.locator('[data-label="Cost basis"]').innerText()),
    unrealized: moneyFromUi(await row.locator('[data-label="Unrealized"]').innerText()),
    dividend: moneyFromUi(await row.locator('[data-label="Annual dividend"]').innerText()),
  };
}

async function readOverview(page, query = "") {
  const response = await page.goto(`${BASE}/${query}`, { waitUntil: "networkidle" });
  const figure = page.locator(".kpi-figure");
  return {
    status: response?.status() ?? null,
    value: (await figure.count()) === 0 ? null : moneyFromUi(await figure.innerText()),
  };
}

async function readIncome(page, query = "") {
  await page.goto(`${BASE}/income${query}`, { waitUntil: "networkidle" });
  return moneyFromUi(await page.locator(".kpi-figure").innerText());
}

async function readAccount(page, accountId) {
  await page.goto(`${BASE}/accounts/${accountId}`, { waitUntil: "networkidle" });
  return moneyFromUi(await page.locator(".detail-figure").innerText());
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected} cents, got ${actual} cents`);
  }
}

async function revise(page, accountId, instrumentId, quantity, basis) {
  await page.goto(`${BASE}/holdings?edit=${accountId}.${instrumentId}`, { waitUntil: "networkidle" });
  await page.locator("#revise-quantity").fill(quantity);
  await page.locator("#revise-cost-basis").fill(basis);
  await Promise.all([
    page.waitForURL(/\?saved=/, { timeout: 30_000 }),
    page.locator("#revise-position button", { hasText: "Save" }).click(),
  ]);
  const receipt = await page.locator(".saved-note, .status-note, [role=status]").allInnerTexts();
  return { url: page.url(), receipt };
}

const pool = new pg.Pool({ connectionString: DATABASE_URL });
const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox"] });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await context.addCookies([{ name: "masked", value: "0", url: BASE }]);
const page = await context.newPage();
page.setDefaultTimeout(30_000);

const ledger = [];
let failed = false;

try {
  for (let index = 0; index < mutations.length; index += 1) {
    const [accountId, instrumentId, quantity, basis, scenario] = mutations[index];
    const beforeCount = Number(
      (await pool.query("select count(*)::int as n from position_set where account_id=$1", [accountId])).rows[0].n,
    );

    const receipt = await revise(page, accountId, instrumentId, quantity, basis);
    const afterCount = Number(
      (await pool.query("select count(*)::int as n from position_set where account_id=$1", [accountId])).rows[0].n,
    );
    if (afterCount !== beforeCount + 1) {
      throw new Error(`${scenario}: expected exactly one appended position set`);
    }

    const rows = await rawRows(pool);
    const household = oracle(rows);
    const account = oracle(rows, (row) => row.account_id === String(accountId));
    const holdingUi = await readHoldingTotals(page);
    const overviewUi = await readOverview(page);
    const accountUi = await readAccount(page, accountId);

    assertEqual(holdingUi.value, household.value, `${scenario} holdings value`);
    assertEqual(holdingUi.basis, household.basis, `${scenario} holdings basis`);
    assertEqual(holdingUi.unrealized, household.unrealized, `${scenario} holdings gain`);
    assertEqual(holdingUi.dividend, household.dividend, `${scenario} holdings dividend`);
    const overviewFailed = overviewUi.value === null;
    if (overviewFailed && scenario !== "VTI very large quantity") {
      throw new Error(`${scenario} overview returned ${overviewUi.status} without a net-worth figure`);
    }
    if (!overviewFailed) {
      assertEqual(overviewUi.value, household.value, `${scenario} overview value`);
    } else {
      await page.screenshot({
        path: path.join(FIGURES, "position-large-value-overview-500.png"),
        fullPage: true,
      });
    }
    assertEqual(accountUi, account.value, `${scenario} account value`);

    const entry = {
      step: index + 1,
      scenario,
      accountId,
      instrumentId,
      input: { quantity, costBasisPerShare: basis === "" ? null : basis },
      expectedCents: {
        householdValue: household.value.toString(),
        householdBasis: household.basis.toString(),
        householdUnrealized: household.unrealized.toString(),
        annualDividend: household.dividend.toString(),
        accountValue: account.value.toString(),
      },
      actualCents: {
        holdingsValue: holdingUi.value.toString(),
        holdingsBasis: holdingUi.basis.toString(),
        holdingsUnrealized: holdingUi.unrealized.toString(),
        holdingsDividend: holdingUi.dividend.toString(),
        overviewValue: overviewUi.value?.toString() ?? null,
        overviewStatus: overviewUi.status,
        accountValue: accountUi.toString(),
      },
      coverage: {
        holdings: household.holdings,
        priced: household.priced,
        based: household.based,
        gainKnown: household.gains,
      },
      positionSetsBefore: beforeCount,
      positionSetsAfter: afterCount,
      receipt,
      url: receipt.url,
      result: overviewFailed ? "finding" : "pass",
      finding: overviewFailed
        ? "Accepted large position makes Overview return 500 while Holdings and account detail still render."
        : undefined,
    };

    // Every fifth state also exercises owner slicing and Income.
    if ((index + 1) % 5 === 0 || index === mutations.length - 1) {
      const ownerId = String(accountId) === "4" || String(accountId) === "5" ? "2" : "1";
      const ownerExpected = oracle(rows, (row) => row.owner_id === ownerId);
      const ownerQuery = `?owner=${ownerId}`;
      const ownerHoldingUi = await readHoldingTotals(page, ownerQuery);
      const ownerOverviewUi = await readOverview(page, ownerQuery);
      const ownerIncomeUi = await readIncome(page, ownerQuery);
      const householdIncomeUi = await readIncome(page);

      assertEqual(ownerHoldingUi.value, ownerExpected.value, `${scenario} owner holdings value`);
      if (ownerOverviewUi.value === null) {
        throw new Error(`${scenario} owner overview returned ${ownerOverviewUi.status}`);
      }
      assertEqual(ownerOverviewUi.value, ownerExpected.value, `${scenario} owner overview value`);
      assertEqual(ownerIncomeUi, ownerExpected.dividend, `${scenario} owner income`);
      assertEqual(householdIncomeUi, household.dividend, `${scenario} household income`);
      entry.ownerCheckpoint = {
        ownerId,
        expectedValueCents: ownerExpected.value.toString(),
        expectedDividendCents: ownerExpected.dividend.toString(),
        result: "pass",
      };
    }

    ledger.push(entry);
    process.stdout.write(
      `${overviewFailed ? "FINDING" : "PASS"} ${String(index + 1).padStart(2, "0")}/${mutations.length} ${scenario}\n`,
    );
  }

  await page.goto(`${BASE}/holdings`, { waitUntil: "networkidle" });
  await page.screenshot({ path: path.join(FIGURES, "position-campaign-final-holdings.png"), fullPage: true });
} catch (error) {
  failed = true;
  ledger.push({ step: ledger.length + 1, result: "fail", error: String(error?.stack ?? error) });
  await page.screenshot({ path: path.join(FIGURES, "position-campaign-failure.png"), fullPage: true }).catch(() => {});
  throw error;
} finally {
  fs.writeFileSync(
    OUT,
    `${JSON.stringify({ base: BASE, mutationCount: mutations.length, failed, ledger }, null, 2)}\n`,
  );
  await browser.close();
  await pool.end();
}
