/** Targeted follow-up: prove the blast radius of an accepted large position, then restore it. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const BASE = process.env.AUDIT_BASE ?? "http://localhost:4279";
const CHROME =
  process.env.CHROME ??
  "/home/ubuntu/.cache/ms-playwright/chromium-1234/chrome-linux/chrome";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "large-position-route-sweep.json");
const FIGURES = path.resolve(HERE, "../figures");

const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox"] });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await context.addCookies([{ name: "masked", value: "0", url: BASE }]);
const page = await context.newPage();
page.setDefaultTimeout(30_000);

async function revise(quantity, basis) {
  await page.goto(`${BASE}/holdings?edit=1.2`, { waitUntil: "networkidle" });
  await page.locator("#revise-quantity").fill(quantity);
  await page.locator("#revise-cost-basis").fill(basis);
  await Promise.all([
    page.waitForURL(/\?saved=/),
    page.locator("#revise-position button", { hasText: "Save" }).click(),
  ]);
}

const routes = [
  ["Overview", "/"],
  ["Overview, Alex", "/?owner=1"],
  ["Overview, Jordan", "/?owner=2"],
  ["Holdings", "/holdings"],
  ["Analysis", "/analysis"],
  ["Income", "/income"],
  ["Fidelity account", "/accounts/1"],
];

const results = [];
try {
  await revise("25000000", "165.4961");

  for (const [name, route] of routes) {
    const response = await page.goto(`${BASE}${route}`, { waitUntil: "networkidle" });
    results.push({
      name,
      route,
      status: response?.status() ?? null,
      heading: await page.locator("h1").first().innerText().catch(() => null),
      figure: await page.locator(".kpi-figure, .detail-figure").first().innerText().catch(() => null),
    });
    if ((response?.status() ?? 200) >= 500) {
      await page.screenshot({
        path: path.join(FIGURES, `large-position-${name.toLowerCase().replaceAll(/[^a-z]+/g, "-")}.png`),
        fullPage: true,
      });
    }
  }
} finally {
  await revise("282.144455", "165.4961");
  fs.writeFileSync(OUT, `${JSON.stringify({ quantity: "25000000", results }, null, 2)}\n`);
  await browser.close();
}

for (const result of results) {
  process.stdout.write(`${result.status} ${result.name}: ${result.heading}\n`);
}
