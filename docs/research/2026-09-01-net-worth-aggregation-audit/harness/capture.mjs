/** AUDIT — the report's figures, captured at viewport size against the live app. */
import fs from "node:fs";
import path from "node:path";
import { chromium } from "/home/user/portfolio/node_modules/playwright/index.mjs";
import { BASE, HERE } from "./lib.mjs";
import { submitNav, accountIds, createAccount } from "./flows.mjs";

const OUT = path.join(HERE, "figures");
fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--no-sandbox"] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await ctx.addCookies([{ name: "masked", value: "0", url: BASE }]);
const page = await ctx.newPage();
page.setDefaultTimeout(60_000);

const grab = async (name, url, { full = false, wait } = {}) => {
  if (url) await page.goto(BASE + url, { waitUntil: "networkidle" });
  if (wait) await page.waitForSelector(wait).catch(() => {});
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: full });
  console.log("captured", name);
};

// ---- setup / workflows
await grab("01-settings-people", "/settings/people");
await grab("02-settings-accounts", "/settings/accounts");

// one throwaway upload, photographed at every step
const NAME = "FIGURES · Walkthrough";
const ids0 = await accountIds(page);
if (!ids0.has(NAME)) {
  await createAccount(page, { name: NAME, institution: "Repro Bank", kind: "brokerage",
                              owner: "Ana Whitfield", taxTreatment: "taxable" });
}
const ids = await accountIds(page);
fs.writeFileSync(path.join(HERE, "data", "repro", "walkthrough.csv"),
  "Symbol,Description,Quantity,Cost Basis Per Share,As Of\n" +
  "RPXA,RPXA Repro Fund A,42.5,11.0000,2026-08-31\n" +
  "FIGX,FIGX Walkthrough Fund,300,25.0000,2026-08-31\n");
await page.goto(`${BASE}/upload`, { waitUntil: "networkidle" });
await page.waitForSelector("#upload-account");
const opts = await page.$$eval("#upload-account option", (e) => e.map((o) => ({ v: o.value, l: o.textContent.trim() })));
await page.selectOption("#upload-account", opts.find((o) => o.l.startsWith(NAME)).v);
await page.setInputFiles("#upload-file", path.join(HERE, "data", "repro", "walkthrough.csv"));
await grab("03-upload-step1");
await submitNav(page, "button:has-text('Continue to columns')");
await page.waitForSelector("#map-instrument");
await grab("04-upload-columns", null, { full: true });
for (const [f, c] of Object.entries({ instrument: "Symbol", quantity: "Quantity", name: "Description",
    costBasis: "Cost Basis Per Share", asOf: "As Of", accountNumber: "__none__" }))
  await page.selectOption(`#map-${f}`, c);
await submitNav(page, "button:has-text('Save mapping and continue')");
if (page.url().includes("/instruments")) {
  await page.waitForSelector("input[name^='raw-']", { state: "attached" });
  await grab("05-upload-instruments");
  const n = await page.$$eval("input[name^='raw-']", (e) => e.length);
  const o = await page.$$eval("#classificationId-0 option", (e) => e.map((x) => ({ v: x.value, l: x.textContent.trim() })));
  for (let i = 0; i < n; i += 1) {
    const raw = (await page.inputValue(`input[name='raw-${i}']`)).trim();
    await page.check(`input[name='kind-${i}'][value=create]`);
    await page.fill(`#symbol-${i}`, raw);
    await page.fill(`#name-${i}`, `${raw} Walkthrough Fund`);
    await page.check(`input[name='priceSource-${i}'][value=feed]`);
    await page.selectOption(`#classificationId-${i}`, o.find((x) => x.l === "US Large Cap").v);
  }
  await submitNav(page, "button:has-text('Save and continue')");
}
await page.waitForSelector("button:has-text('Record this statement')");
await grab("06-upload-review");
await submitNav(page, "button:has-text('Record this statement')");
await grab("07-upload-receipt");

// set balance, on a bank account
const bankId = ids.get("BANK 3 · Core");
await page.goto(`${BASE}/accounts/${bankId}#set-balance`, { waitUntil: "networkidle" });
await page.waitForSelector("#set-balance-amount");
await page.$eval("#set-balance", (e) => e.scrollIntoView());
await grab("08-set-balance");

// ---- the figure screens
await grab("10-overview", "/?range=1d");
await grab("11-holdings", "/holdings");
await grab("12-holdings-grouped", "/holdings?group=kind");
await grab("13-holdings-filtered", "/holdings?kind=liability");
await grab("14-analysis", "/analysis");
await grab("15-income", "/income");
await grab("16-account-page", `/accounts/${ids.get("BROKERAGE 3 · Growth")}?range=1d`);

// the Holdings footer, where the grand total lives
await page.goto(`${BASE}/holdings?group=kind`, { waitUntil: "networkidle" });
await page.$eval("tfoot tr.row-total", (e) => e.scrollIntoView({ block: "center" }));
await grab("17-holdings-total");

// ---- finding 1: the owner filter
await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
await page.click(".owner-filter summary");
await page.waitForTimeout(200);
const boxes = await page.$$(".owner-filter input[name=owner]");
await boxes[0].check(); await boxes[1].check();
await grab("20-owner-two-ticked");
await page.goto(`${BASE}/?owner=1,2`, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
await page.waitForTimeout(500);
await grab("21-owner-redirect-loop");

// ---- finding 3: chart endpoint vs headline
await grab("40-chart-vs-headline", "/?range=1y");

// ---- edge cases
const idsB = await accountIds(page);
await grab("50-unpriced-account", `/accounts/${idsB.get("REPRO · Unpriced")}?range=1d`);
await grab("51-empty-account", `/accounts/${idsB.get("BROKERAGE 11 · Everyday")}?range=1d`);
await page.goto(`${BASE}/settings/accounts`, { waitUntil: "networkidle" });
await page.$eval("tr.record-row--closed", (e) => e.scrollIntoView({ block: "center" })).catch(() => {});
await grab("52-closed-account-row");
await browser.close();
