/**
 * AUDIT — two edge cases:
 *  1. one instrument named three different ways in one file (the spelling fold)
 *  2. a product that cannot fit numeric(20,4) (the overflow guard)
 */
import path from "node:path";
import { BASE, HERE, open, shot } from "./lib.mjs";
import { accountIds, createAccount, uploadStatement, submitNav, pageError } from "./flows.mjs";
const R = path.join(HERE, "data", "repro");
const { browser, page } = await open();
const columns = { instrument: "Symbol", quantity: "Quantity", name: "Description",
                  costBasis: "Cost Basis Per Share", asOf: "As Of", accountNumber: "__none__" };

// ---- 1. spelling fold
const NAME = "REPRO · Spellings";
await createAccount(page, { name: NAME, institution: "Repro Bank", kind: "brokerage",
                            owner: "Ana Whitfield", taxTreatment: "taxable" });
const ids = await accountIds(page);
const id = ids.get(NAME);
// Both new strings are mapped onto the instrument that already exists.
await page.goto(`${BASE}/upload`, { waitUntil: "networkidle" });
await page.waitForSelector("#upload-account");
const opts = await page.$$eval("#upload-account option", (e) => e.map((o) => ({ v: o.value, l: o.textContent.trim() })));
await page.selectOption("#upload-account", opts.find((o) => o.l.startsWith(NAME)).v);
await page.setInputFiles("#upload-file", path.join(R, "spellings.csv"));
await submitNav(page, "button:has-text('Continue to columns')");
await page.waitForSelector("#map-instrument");
for (const [f, c] of Object.entries(columns)) await page.selectOption(`#map-${f}`, c);
await submitNav(page, "button:has-text('Save mapping and continue')");
if (page.url().includes("/instruments")) {
  await page.waitForSelector("input[name^='raw-']", { state: "attached" });
  const n = await page.$$eval("input[name^='raw-']", (e) => e.length);
  console.log("first sightings:", n);
  for (let i = 0; i < n; i += 1) {
    await page.check(`input[name='kind-${i}'][value=existing]`);
    const o = await page.$$eval(`#instrumentId-${i} option`, (els) =>
      els.map((e) => ({ v: e.value, l: e.textContent.trim() })));
    await page.selectOption(`#instrumentId-${i}`, o.find((x) => x.l.startsWith("RPXA —")).v);
  }
  await submitNav(page, "button:has-text('Save and continue')");
}
await page.waitForSelector("button:has-text('Record this statement')");
console.log("review says:", await page.$eval("span.panel-count", (e) => e.innerText.trim()));
await shot(page, "97-spelling-fold-review");
await submitNav(page, "button:has-text('Record this statement')");
await page.goto(`${BASE}/accounts/${id}`, { waitUntil: "networkidle" });
const rows = await page.$$eval("table.data-table tbody tr", (trs) =>
  trs.map((tr) => [...tr.querySelectorAll("td,th")].map((c) => c.innerText.trim())));
console.log("stored rows:", JSON.stringify(rows));
console.log("account total:", await page.$eval("p.detail-figure", (e) => e.innerText.trim()));

// ---- 2. overflow guard
await page.goto(`${BASE}/upload`, { waitUntil: "networkidle" });
await page.waitForSelector("#upload-account");
const o2 = await page.$$eval("#upload-account option", (e) => e.map((x) => ({ v: x.value, l: x.textContent.trim() })));
await page.selectOption("#upload-account", o2.find((x) => x.l.startsWith(NAME)).v);
await page.setInputFiles("#upload-file", path.join(R, "overflow.csv"));
await submitNav(page, "button:has-text('Continue to columns')");
await page.waitForSelector("#map-instrument");
for (const [f, c] of Object.entries(columns)) await page.selectOption(`#map-${f}`, c);
await submitNav(page, "button:has-text('Save mapping and continue')");
let outcome = page.url();
if (page.url().includes("/review")) {
  await page.waitForSelector("button:has-text('Record this statement')");
  await submitNav(page, "button:has-text('Record this statement')");
  outcome = `review -> ${page.url()}`;
}
console.log("overflow outcome:", outcome);
console.log("refusal:", (await pageError(page)).slice(0, 240));
await shot(page, "98-overflow-guard");
await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
console.log("overview still renders:", await page.$eval(".kpi-figure", (el) => {
  const c = el.cloneNode(true); c.querySelectorAll(".delta").forEach((d) => d.remove()); return c.textContent.trim(); }));
await browser.close();
