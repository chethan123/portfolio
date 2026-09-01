/** AUDIT — an instrument with no feed price: is its absence reported, or silently dropped? */
import path from "node:path";
import { BASE, HERE, open, shot } from "./lib.mjs";
import { accountIds, createAccount, uploadStatement } from "./flows.mjs";
const { browser, page } = await open();
const NAME = "REPRO · Unpriced";
await createAccount(page, { name: NAME, institution: "Repro Bank", kind: "401k",
                            owner: "Ana Whitfield", taxTreatment: "tax_deferred" });
const ids = await accountIds(page);
const id = ids.get(NAME);
await uploadStatement(page, {
  accountName: NAME,
  file: path.join(HERE, "data", "repro", "unpriced.csv"),
  columns: { instrument: "Symbol", quantity: "Quantity", name: "Description",
             costBasis: "Cost Basis Per Share", asOf: "As Of", accountNumber: "__none__" },
  instruments: new Map([
    // No symbol at all, priced manually -> nothing will ever quote it.
    ["PLANTRUST", { symbol: "", name: "Workplace Collective Trust",
                    priceSource: "manual", classification: "US Large Cap", assetClass: "equity" }],
    ["RPXA", { symbol: "RPXA", name: "RPXA Repro Fund A", classification: "US Large Cap", assetClass: "equity" }],
  ]),
});
await page.goto(`${BASE}/accounts/${id}`, { waitUntil: "networkidle" });
console.log("account total :", await page.$eval("p.detail-figure", (e) => e.innerText.trim()).catch(() => "(withheld)"));
console.log("coverage note :", await page.$eval("p.coverage-note", (e) => e.innerText.trim()).catch(() => "(none)"));
await shot(page, "90-unpriced-account");
await page.goto(`${BASE}/holdings`, { waitUntil: "networkidle" });
console.log("holdings count:", await page.$eval("p.panel-count", (e) => e.innerText.trim()));
console.log("holdings total:", await page.$eval('tfoot tr.row-total td[data-label="Value"]', (e) => e.innerText.trim()));
console.log("holdings note :", await page.$eval("p.coverage-note", (e) => e.innerText.trim()).catch(() => "(none)"));
await shot(page, "91-unpriced-holdings-total");
await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
console.log("overview head :", await page.$eval(".kpi-figure", (el) => { const c = el.cloneNode(true); c.querySelectorAll(".delta").forEach((d) => d.remove()); return c.textContent.trim(); }));
const notes = await page.$$eval("p.coverage-note", (els) => els.map((e) => e.innerText.trim()));
console.log("overview notes:", JSON.stringify(notes));
await shot(page, "92-unpriced-overview");
await browser.close();
