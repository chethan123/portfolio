/** AUDIT HARNESS — shared Playwright plumbing. */
import { chromium } from "/home/user/portfolio/node_modules/playwright/index.mjs";
import fs from "node:fs";
import path from "node:path";

export const CHROME = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
export const BASE = process.env.AUDIT_BASE ?? "http://127.0.0.1:5173";
export const HERE = path.dirname(new URL(import.meta.url).pathname);
export const DATA = path.join(HERE, "data");
export const SHOTS = path.join(HERE, "shots");

export function ledger() {
  return JSON.parse(fs.readFileSync(path.join(DATA, "ledger.json"), "utf8"));
}

export async function open({ headless = true } = {}) {
  const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox"] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  // Amounts are masked by default; the audit needs the figures themselves.
  await context.addCookies([
    { name: "masked", value: "0", url: BASE },
    { name: "chart_range", value: "1y", url: BASE },
  ]);
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);
  return { browser, context, page };
}

export async function shot(page, name) {
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
}

/** Text of the first match, trimmed, or null. */
export async function textOf(page, selector) {
  const el = await page.$(selector);
  return el === null ? null : (await el.innerText()).trim();
}

/** "$1,234.56" / "−$12.00" → "-1234.56"; null when there is no figure. */
export function money(text) {
  if (text === null || text === undefined) return null;
  const cleaned = text.replace(/−/g, "-").replace(/[^0-9.,-]/g, "").replace(/,/g, "");
  if (cleaned === "" || cleaned === "-") return null;
  return cleaned;
}
