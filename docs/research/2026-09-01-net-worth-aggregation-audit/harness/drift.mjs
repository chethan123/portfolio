/**
 * AUDIT — Step 6 drift probe: hammer the screens and the price refresh, and
 * watch whether any figure moves while the holdings do not.
 */
import { BASE, open } from "./lib.mjs";
import { refreshNow } from "./flows.mjs";
const { browser, page } = await open();
const read = async (url, sel) => {
  await page.goto(BASE + url, { waitUntil: "networkidle" });
  return page.$eval(sel, (el) => {
    const c = el.cloneNode(true); c.querySelectorAll(".delta,.kpi-aside").forEach((d) => d.remove());
    return c.textContent.trim();
  }).catch(() => null);
};
const screens = [
  ["/", ".kpi-figure"],
  ["/holdings", 'tfoot tr.row-total td[data-label="Value"]'],
  ["/analysis", ".donut-total"],
  ["/holdings?group=kind", 'tfoot tr.row-total td[data-label="Value"]'],
  ["/holdings?sort=quantity&dir=asc", 'tfoot tr.row-total td[data-label="Value"]'],
  ["/?owner=1", ".kpi-figure"],
  ["/income", ".kpi-figure"],
];
const seen = new Map();
for (let round = 0; round < 6; round += 1) {
  for (const [url, sel] of screens) {
    const v = await read(url, sel);
    const key = url + " " + sel;
    const list = seen.get(key) ?? [];
    list.push(v);
    seen.set(key, list);
  }
}
let unstable = 0;
for (const [key, list] of seen) {
  const distinct = [...new Set(list)];
  if (distinct.length > 1) { unstable += 1; console.log("UNSTABLE", key, distinct); }
  else console.log("stable  ", key.padEnd(52), distinct[0]);
}
console.log("unstable screens:", unstable);

// The app's own "Refresh now" control, pressed five times. The provider is
// unreachable from here, which is the interesting case: last known prices must
// be kept, not zeroed.
for (let i = 0; i < 5; i += 1) {
  const note = await refreshNow(page);
  const total = await read("/", ".kpi-figure");
  console.log(`refresh-now ${i + 1}: total ${total} | ${String(note).slice(0, 90)}`);
}
await browser.close();
