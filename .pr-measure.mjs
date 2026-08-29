import { chromium } from "playwright";
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
for (const width of [1600, 1440, 1280, 1100, 900, 820, 768, 640, 390]) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  await page.goto("http://127.0.0.1:5173/holdings?owner=1", { waitUntil: "networkidle" });
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  const narrated = await page.evaluate(() => {
    const el = document.querySelector(".narrowed-to");
    return el ? Math.round(el.getBoundingClientRect().right) : null;
  });
  console.log(`${String(width).padStart(4)}  overflow=${String(over).padStart(4)}  narration right edge=${narrated}  client=${await page.evaluate(() => document.documentElement.clientWidth)}`);
  await page.close();
}
await browser.close();
