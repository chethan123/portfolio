/**
 * AUDIT — minimal repro: a statement is accepted, the review promises a change,
 * and nothing changes anywhere. Two positions, one correction, one re-upload.
 */
import path from "node:path";
import { BASE, HERE, open, shot } from "./lib.mjs";
import { accountIds, createAccount, editHolding, uploadStatement, submitNav } from "./flows.mjs";

const R = path.join(HERE, "data", "repro");
const { browser, page } = await open();
const NAME = "REPRO · Silent no-op";
const instruments = new Map([
  ["RPXA", { symbol: "RPXA", name: "RPXA Repro Fund A", classification: "US Large Cap", assetClass: "equity" }],
  ["RPXB", { symbol: "RPXB", name: "RPXB Repro Fund B", classification: "US Large Cap", assetClass: "equity" }],
]);
const columns = { instrument: "Symbol", quantity: "Quantity", name: "Description",
                  costBasis: "Cost Basis Per Share", asOf: "As Of", accountNumber: "__none__" };

await createAccount(page, { name: NAME, institution: "Repro Bank", kind: "brokerage",
                            owner: "Ana Whitfield", taxTreatment: "taxable" });
const ids = await accountIds(page);
const id = ids.get(NAME);
console.log("account id:", id);

await uploadStatement(page, { accountName: NAME, file: path.join(R, "step1.csv"), columns, instruments });
const read = async () => {
  await page.goto(`${BASE}/accounts/${id}`, { waitUntil: "networkidle" });
  return {
    total: await page.$eval("p.detail-figure", (e) => e.innerText.trim()).catch(() => null),
    rows: await page.$$eval("table.data-table tbody tr", (t) => t.length).catch(() => 0),
  };
};
console.log("after statement 1 (RPXA 100, RPXB 200):", JSON.stringify(await read()));

// One correction through the Holdings row editor — this dates the account TODAY.
const instIds = await page.$$eval("table.data-table tbody tr a", (as) => as.map((a) => a.getAttribute("href")));
await page.goto(`${BASE}/holdings?account=${id}`, { waitUntil: "networkidle" });
const editHref = await page.$eval("a.row-edit", (a) => a.getAttribute("href")).catch(() => null);
const rowKey = editHref?.match(/edit=([^&]+)/)?.[1];
console.log("editing row:", rowKey);
const [accId, instId] = decodeURIComponent(rowKey).split(".");
await editHolding(page, { accountId: accId, instrumentId: instId, quantity: "150" });
console.log("after correcting one quantity:", JSON.stringify(await read()));

// Statement 2, same as-of date as statement 1, dropping RPXB.
await page.goto(`${BASE}/upload`, { waitUntil: "networkidle" });
const res = await (async () => {
  // stop at review to photograph what the user is promised
  await page.waitForSelector("#upload-account");
  const opts = await page.$$eval("#upload-account option", (els) =>
    els.map((e) => ({ value: e.value, label: e.textContent.trim() })));
  await page.selectOption("#upload-account", opts.find((o) => o.label.startsWith(NAME)).value);
  await page.setInputFiles("#upload-file", path.join(R, "step2.csv"));
  await submitNav(page, "button:has-text('Continue to columns')");
  await page.waitForSelector("#map-instrument");
  for (const [f, c] of Object.entries(columns)) await page.selectOption(`#map-${f}`, c);
  await submitNav(page, "button:has-text('Save mapping and continue')");
  await page.waitForSelector("button:has-text('Record this statement')");
  const promised = await page.$eval("span.panel-count", (e) => e.innerText.trim()).catch(() => null);
  await shot(page, "70-repro-review-promises");
  const confirm = await page.$("input[name=confirmRemovals]");
  if (confirm) await confirm.check();
  await submitNav(page, "button:has-text('Record this statement')");
  return { promised, landed: page.url() };
})();
console.log("review promised :", res.promised);
console.log("landed on       :", res.landed);
const msg = await page.$eval("p[role=status]", (e) => e.innerText.trim()).catch(() => null);
console.log("message shown   :", JSON.stringify(msg));
await shot(page, "71-repro-after-commit");
console.log("after statement 2 (RPXB removed):", JSON.stringify(await read()));
await browser.close();
