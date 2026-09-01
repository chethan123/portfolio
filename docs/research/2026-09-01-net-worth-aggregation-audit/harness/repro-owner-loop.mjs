/**
 * AUDIT — minimal repro: pick two owners in the household filter.
 * Counts the requests the page makes in 10 seconds and reports where it landed.
 */
import { BASE, open, shot } from "./lib.mjs";
const { browser, page } = await open();
let dataRequests = 0;
page.on("request", (r) => { if (r.url().includes(".data")) dataRequests += 1; });

await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
await page.click(".owner-filter summary");
await page.waitForTimeout(200);
await shot(page, "30-owner-filter-open");
const boxes = await page.$$(".owner-filter input[name=owner]");
await boxes[0].check();
await boxes[1].check();
await shot(page, "31-owner-two-ticked");

const before = dataRequests;
await page.click(".owner-filter button[type=submit]");
await page.waitForTimeout(10_000);
const storm = dataRequests - before;
console.log(`data requests in 10s after Apply : ${storm}`);
console.log(`URL after Apply                  : ${page.url()}`);
const headline = await page.$eval(".kpi-figure", (el) => {
  const c = el.cloneNode(true); c.querySelectorAll(".delta").forEach((d) => d.remove());
  return c.textContent.trim();
});
console.log(`headline still shown             : ${headline}`);
await shot(page, "32-owner-two-applied");

// The same selection typed straight into the address bar, JS irrelevant.
let navError = null;
try { await page.goto(`${BASE}/?owner=1,2`, { waitUntil: "domcontentloaded", timeout: 15000 }); }
catch (e) { navError = String(e).split("\n")[0]; }
console.log(`direct GET /?owner=1,2           : ${navError ?? "loaded " + page.url()}`);
await shot(page, "33-owner-direct-url");
await browser.close();
