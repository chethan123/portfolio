/** AUDIT — cycle 5: close an account and check every screen's treatment of it. */
import { BASE, open, shot } from "./lib.mjs";
import { closeAccount } from "./flows.mjs";
const ID = process.argv[2] ?? "4";
const { browser, page } = await open();
const headline = async () => {
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  return page.$eval(".kpi-figure", (el) => {
    const c = el.cloneNode(true); c.querySelectorAll(".delta").forEach((d) => d.remove());
    return c.textContent.trim();
  });
};
const holdingsCount = async () => {
  await page.goto(`${BASE}/holdings`, { waitUntil: "networkidle" });
  return page.$eval("p.panel-count", (e) => e.innerText.trim());
};
console.log("before close  headline:", await headline(), "|", await holdingsCount());
await page.goto(`${BASE}/accounts/${ID}`, { waitUntil: "networkidle" });
await shot(page, "80-account-before-close");
await closeAccount(page, ID);
await shot(page, "81-settings-after-close");
console.log("after close   headline:", await headline(), "|", await holdingsCount());
const res = await fetch(`${BASE}/accounts/${ID}`, { redirect: "manual" });
console.log(`GET /accounts/${ID} after close:`, res.status);
await page.goto(`${BASE}/settings/accounts`, { waitUntil: "networkidle" });
const closedRow = await page.$$eval("tr.record-row--closed td", (t) => t.map((x) => x.innerText.trim()));
console.log("settings row:", closedRow.join(" | "));
await browser.close();
