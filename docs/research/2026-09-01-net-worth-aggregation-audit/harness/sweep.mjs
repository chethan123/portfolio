/**
 * AUDIT HARNESS — Step 5: every screen, filter, grouping, sort and owner slice,
 * with each screen's own arithmetic checked (do the parts add up to the whole?).
 *
 *   node audit/sweep.mjs [outfile]
 */
import fs from "node:fs";
import { BASE, open, shot } from "./lib.mjs";

const out = process.argv[2] ?? "/home/user/portfolio/audit/data/sweep.json";
const { browser, page } = await open();
const findings = [];
const record = (o) => { findings.push(o); };

const go = async (url) => {
  await page.goto(BASE + url, { waitUntil: "networkidle" });
  await page.waitForLoadState("networkidle");
};
const num = (t) => {
  if (t === null || t === undefined) return null;
  const c = String(t).replace(/−/g, "-").replace(/[^0-9.,-]/g, "").replace(/,/g, "");
  return c === "" || c === "-" ? null : Number(c);
};
const cents = (n) => Math.round(n * 100);

async function holdingsPage(query) {
  await go(`/holdings${query}`);
  const data = await page.evaluate(() => {
    const cell = (tr, l) => tr.querySelector(`td[data-label="${l}"]`)?.innerText.trim() ?? null;
    const table = document.querySelector("table.data-table--holdings");
    if (!table) return null;
    const bodyRows = [...table.querySelectorAll("tbody tr")];
    const rows = bodyRows
      .filter((tr) => tr.querySelector('td[data-label="Value"]') && !tr.classList.contains("row-subtotal"))
      .map((tr) => ({ value: cell(tr, "Value"), dividend: cell(tr, "Annual dividend"),
                      unrealized: cell(tr, "Unrealized"), costBasis: cell(tr, "Cost basis") }));
    const subtotals = bodyRows
      .filter((tr) => tr.classList.contains("row-subtotal"))
      .map((tr) => ({ label: tr.querySelector("th")?.innerText.trim() ?? null,
                      value: tr.querySelector('td[data-label="Value"]')?.innerText.trim() ?? null }));
    const totalCells = [...(table.querySelector("tfoot tr.row-total")?.querySelectorAll("td") ?? [])];
    const total = Object.fromEntries(totalCells.map((td) => [td.getAttribute("data-label"), td.innerText.trim()]));
    return { rows, subtotals, total, count: document.querySelector("p.panel-count")?.innerText.trim() ?? null };
  });
  return data;
}

// ---------------------------------------------------------- 1. groupings
const GROUPS = ["", "owner", "account", "institution", "kind", "tax", "classification", "assetClass"];
const base = await holdingsPage("");
const baseTotal = num(base.total.Value);
record({ check: "holdings baseline total", value: baseTotal, rows: base.rows.length, count: base.count });

for (const g of GROUPS) {
  const q = g === "" ? "" : `?group=${g}`;
  const d = await holdingsPage(q);
  const total = num(d.total.Value);
  const subSum = d.subtotals.reduce((s, r) => s + (num(r.value) ?? 0), 0);
  const rowSum = d.rows.reduce((s, r) => s + (num(r.value) ?? 0), 0);
  record({
    check: "holdings grouping", group: g || "(none)",
    total, subtotalSum: d.subtotals.length ? Number(subSum.toFixed(2)) : null,
    rowSum: Number(rowSum.toFixed(2)), rows: d.rows.length, groups: d.subtotals.length,
    subtotalMatchesTotal: d.subtotals.length ? cents(subSum) === cents(total) : null,
    rowsMatchTotal: cents(rowSum) === cents(total),
    totalMatchesUngrouped: cents(total) === cents(baseTotal),
  });
  if (g === "kind") await shot(page, "20-holdings-group-kind");
}

// ------------------------------------------------------------ 2. filters
await go("/holdings");
const dims = await page.$$eval("select[id^='filter-']", (els) =>
  els.map((e) => ({ id: e.id.replace("filter-", ""),
                    options: [...e.options].map((o) => ({ value: o.value, label: o.textContent.trim() })) })),
);
record({ check: "filter dimensions", dims: dims.map((d) => ({ id: d.id, options: d.options.length })) });

for (const d of dims) {
  let sum = 0;
  const parts = [];
  for (const o of d.options.filter((o) => o.value !== "")) {
    const page1 = await holdingsPage(`?${d.id}=${encodeURIComponent(o.value)}`);
    const t = num(page1.total.Value) ?? 0;
    parts.push({ option: o.value, total: t, rows: page1.rows.length });
    sum += t;
  }
  record({
    check: "filter partition", dimension: d.id, options: parts.length,
    sumOfParts: Number(sum.toFixed(2)), whole: baseTotal,
    matches: cents(sum) === cents(baseTotal),
    rowsCovered: parts.reduce((s, p) => s + p.rows, 0), baselineRows: base.rows.length,
    parts,
  });
}

// ------------------------------------------------------------- 3. sorting
for (const sort of ["asset", "account", "owner", "quantity", "price", "value", "costBasis", "unrealized", "annualDividend"]) {
  for (const dir of ["asc", "desc"]) {
    const d = await holdingsPage(`?sort=${sort}&dir=${dir}`);
    record({ check: "sort", sort, dir, total: num(d.total.Value), rows: d.rows.length,
             stable: cents(num(d.total.Value)) === cents(baseTotal) && d.rows.length === base.rows.length });
  }
}

// -------------------------------------------------------- 4. owner filter
await go("/");
const owners = await page.$$eval(".owner-filter input[name=owner]", (els) =>
  els.map((e) => ({ id: e.value, label: e.closest("label")?.innerText.trim() ?? e.value })),
).catch(() => []);
record({ check: "owner roster", owners });

const headline = async (q) => {
  await go(`/${q}`);
  const el = await page.$(".kpi-figure");
  if (!el) return null;
  return num(await el.evaluate((e) => { const c = e.cloneNode(true); c.querySelectorAll(".delta").forEach((d) => d.remove()); return c.textContent.trim(); }));
};

const whole = await headline("");
let ownerSum = 0;
const ownerTotals = [];
for (const o of owners) {
  const t = await headline(`?owner=${o.id}`);
  ownerTotals.push({ owner: o.label, id: o.id, total: t });
  ownerSum += t ?? 0;
}
record({ check: "owner partition (overview headline)", whole, sumOfOwners: Number(ownerSum.toFixed(2)),
         matches: cents(ownerSum) === cents(whole), ownerTotals });

// pairs — checked over plain HTTP: a looping URL wedges the browser tab.
if (owners.length >= 2) {
  for (let i = 0; i < owners.length; i += 1) {
    for (let j = i + 1; j < owners.length; j += 1) {
      const pair = `${owners[i].id},${owners[j].id}`;
      const expect = (ownerTotals[i].total ?? 0) + (ownerTotals[j].total ?? 0);
      const res = await fetch(`${BASE}/?owner=${pair}`, { redirect: "manual" });
      const loc = res.headers.get("location");
      record({
        check: "owner pair (HTTP)", pair, expected: Number(expect.toFixed(2)),
        status: res.status, location: loc,
        selfRedirect: res.status >= 300 && res.status < 400 && loc === `/?owner=${pair}`,
        matches: res.status === 200,
      });
    }
  }
}

// ---------------------------------------------------------- 5. analysis
await go("/analysis");
const panels = await page.$$eval("section.panel", (secs) =>
  secs.map((s) => ({
    title: s.querySelector(".panel-title")?.innerText.trim() ?? null,
    total: s.querySelector(".donut-total")?.innerText.trim() ?? null,
    rows: [...s.querySelectorAll("table.data-table tbody tr")].map((tr) =>
      [...tr.querySelectorAll("td,th")].map((td) => td.innerText.trim())),
  })),
);
for (const p of panels) {
  if (!p.total) continue;
  const t = num(p.total);
  const rowSum = p.rows.reduce((s, r) => s + (num(r[1]) ?? 0), 0);
  const shareSum = p.rows.reduce((s, r) => s + (num(r[2]) ?? 0), 0);
  record({ check: "analysis panel", title: p.title, total: t, rows: p.rows.length,
           rowSum: Number(rowSum.toFixed(2)), matches: cents(rowSum) === cents(t),
           shareSum: Number(shareSum.toFixed(2)) });
}

// ------------------------------------------------------------- 6. income
await go("/income");
const inc = await page.evaluate(() => ({
  headline: document.querySelector(".kpi-figure")?.innerText.trim() ?? null,
  panels: [...document.querySelectorAll("section.panel")].map((s) => ({
    title: s.querySelector(".panel-title")?.innerText.trim() ?? null,
    total: s.querySelector(".donut-total")?.innerText.trim() ?? null,
    rows: [...s.querySelectorAll("table.data-table tbody tr")].map((tr) =>
      [...tr.querySelectorAll("td,th")].map((td) => td.innerText.trim())),
  })),
}));
for (const p of inc.panels) {
  if (!p.total) continue;
  const t = num(p.total);
  const rowSum = p.rows.reduce((s, r) => s + (num(r[1]) ?? 0), 0);
  record({ check: "income panel", title: p.title, total: t, rows: p.rows.length,
           rowSum: Number(rowSum.toFixed(2)), matches: cents(rowSum) === cents(t) });
}
record({ check: "income headline", headline: num(inc.headline) });

// ------------------------------------------------------- 7. repeated reads
const repeats = [];
for (let i = 0; i < 8; i += 1) repeats.push(await headline(i % 2 === 0 ? "" : "?owner=" + (owners[0]?.id ?? "")));
record({ check: "repeated reads (alternating filter)", values: repeats });

fs.writeFileSync(out, JSON.stringify(findings, null, 1));
console.log(JSON.stringify(findings.filter((f) => f.matches === false || f.stable === false ||
  f.subtotalMatchesTotal === false || f.rowsMatchTotal === false || f.totalMatchesUngrouped === false), null, 1));
console.error("sweep written to", out, "checks:", findings.length);
await browser.close();
