/**
 * AUDIT HARNESS — read every figure the UI shows, into JSON on stdout.
 *
 *   node audit/scrape.mjs [outfile]
 */
import fs from "node:fs";
import { BASE, DATA, open, shot } from "./lib.mjs";

const out = process.argv[2] ?? null;
const { browser, page } = await open();
const go = async (url) => {
  await page.goto(BASE + url, { waitUntil: "networkidle" });
  await page.waitForLoadState("networkidle");
};
const txt = async (sel) => {
  const el = await page.$(sel);
  return el === null ? null : (await el.innerText()).trim();
};
const num = (t) => {
  if (t === null || t === undefined) return null;
  const c = t.replace(/−/g, "-").replace(/[^0-9.,-]/g, "").replace(/,/g, "");
  return c === "" || c === "-" ? null : c;
};

const result = { at: new Date().toISOString() };

// ---------------------------------------------------------------- overview
async function overview(owner = "") {
  await go(`/${owner}`);
  const kpi = await page.$(".kpi-figure");
  let headline = null;
  if (kpi) {
    headline = await kpi.evaluate((el) => {
      const clone = el.cloneNode(true);
      clone.querySelectorAll(".delta").forEach((d) => d.remove());
      return clone.textContent.trim();
    });
  }
  const accounts = await page.$$eval("a.account-row", (rows) =>
    rows.map((r) => ({
      id: r.getAttribute("href").split("/").pop().split("?")[0],
      name: r.querySelector(".account-name")?.innerText.trim() ?? null,
      amount: r.querySelector(".account-amount")?.innerText.trim() ?? null,
      owner: r.querySelector(".account-owner")?.innerText.trim() ?? null,
    })),
  );
  const count = await txt(".panel-count");
  return { headline: num(headline), accounts: accounts.map((a) => ({ ...a, amount: num(a.amount) })), count };
}

// ---------------------------------------------------------------- holdings
async function holdings(query = "") {
  await go(`/holdings${query}`);
  const rows = await page.$$eval("table.data-table--holdings tbody tr", (trs) =>
    trs
      .filter((tr) => !tr.classList.contains("row-group") && !tr.classList.contains("row-subtotal") && !tr.classList.contains("row-note"))
      .map((tr) => {
        const cell = (l) => tr.querySelector(`td[data-label="${l}"]`)?.innerText.trim() ?? null;
        return {
          asset: cell("Asset"), account: cell("Account"), owner: cell("Owner"),
          quantity: cell("Quantity"), price: cell("Price"), value: cell("Value"),
          costBasis: cell("Cost basis"), unrealized: cell("Unrealized"),
          dividend: cell("Annual dividend"),
        };
      }),
  );
  const total = await page.$$eval("tfoot tr.row-total td", (tds) =>
    Object.fromEntries(tds.map((td) => [td.getAttribute("data-label"), td.innerText.trim()])),
  ).catch(() => ({}));
  const subtotals = await page.$$eval("tr.row-subtotal", (trs) =>
    trs.map((tr) => ({
      label: tr.querySelector("th")?.innerText.trim() ?? null,
      value: tr.querySelector('td[data-label="Value"]')?.innerText.trim() ?? null,
    })),
  );
  return {
    count: await txt("p.panel-count"),
    rows: rows.length,
    firstRows: rows.slice(0, 3),
    allRows: rows,
    total: Object.fromEntries(Object.entries(total).map(([k, v]) => [k, v])),
    subtotals,
  };
}

// ---------------------------------------------------------------- analysis
async function analysis(owner = "") {
  await go(`/analysis${owner}`);
  const panels = await page.$$eval("section.panel", (sections) =>
    sections.map((s) => ({
      title: s.querySelector(".panel-title")?.innerText.trim() ?? null,
      total: s.querySelector(".donut-total")?.innerText.trim() ?? null,
      rows: [...s.querySelectorAll("table.data-table tbody tr")].map((tr) => {
        const tds = [...tr.querySelectorAll("td,th")].map((td) => td.innerText.trim());
        return tds;
      }),
    })),
  );
  return panels;
}

// ------------------------------------------------------------------ income
async function income() {
  await go("/income");
  return {
    total: num(await txt(".kpi-figure")),
    panels: await page.$$eval("section.panel", (sections) =>
      sections.map((s) => ({
        title: s.querySelector(".panel-title")?.innerText.trim() ?? null,
        total: s.querySelector(".donut-total")?.innerText.trim() ?? null,
        rows: [...s.querySelectorAll("table.data-table tbody tr")].map((tr) =>
          [...tr.querySelectorAll("td,th")].map((td) => td.innerText.trim()),
        ),
      })),
    ),
  };
}

// ------------------------------------------------------------- per account
async function accountPages(ids) {
  const seen = {};
  for (const id of ids) {
    await go(`/accounts/${id}`);
    const figure = num(await txt("p.detail-figure"));
    const rows = await page.$$eval("table.data-table tbody tr", (trs) =>
      trs.map((tr) => [...tr.querySelectorAll("td,th")].map((td) => td.innerText.trim())),
    ).catch(() => []);
    seen[id] = { total: figure, rows: rows.length };
  }
  return seen;
}

result.overview = await overview();
await shot(page, "10-overview");
result.holdings = await holdings();
await shot(page, "11-holdings");
result.analysis = await analysis();
await shot(page, "12-analysis");
result.income = await income();
await shot(page, "13-income");
result.accounts = await accountPages(result.overview.accounts.map((a) => a.id));

if (out) fs.writeFileSync(out, JSON.stringify(result, null, 1));
else console.log(JSON.stringify(result, null, 1));
console.error("scraped:", result.overview.headline, "| holdings rows:", result.holdings.rows);
await browser.close();
