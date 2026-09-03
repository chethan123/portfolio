/**
 * What every screen costs on a phone, measured rather than eyeballed.
 *
 * The question this answers is "how much of the first screenful is spent
 * before the thing the screen exists for" — the table, the chart, the
 * figure. Counting that off a screenshot is guesswork at a 2x device pixel
 * ratio, so this walks the real box tree instead and reports CSS pixels.
 *
 * Run from the repository root against a demo instance already serving
 * (`scripts/capture-screenshots.ts` documents standing one up):
 *
 *   node --env-file=.env.demo \
 *     ./docs/research/2026-09-03-phone-layout/harness/measure-phone.ts
 *
 * Two deliberate choices, both copied from `scripts/capture-screenshots.ts`
 * because a second convention here would be a second thing to keep in step:
 *
 * **390x900 with `isMobile`.** The narrowest phone the project draws for
 * (`docs/design/holdings-ui-brief.md` says to draw the card at 390px), and
 * the width the committed shots already use — so a figure here and a figure
 * there mean the same thing.
 *
 * **Never full-page.** The bottom navigation is `position: fixed`, so a
 * full-page capture paints it through the middle of the image. The whole
 * subject here is the first screenful anyway.
 */
import { chromium, type Browser, type Page } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";

const BASE_URL = process.env.BASE_URL ?? "http://127.0.0.1:5173";
const EXECUTABLE = process.env.CHROMIUM_EXECUTABLE;
const OUT = "docs/research/2026-09-03-phone-layout/figures";

const PHONE = { width: 390, height: 900 } as const;

/**
 * Every screen, and the selector for the first thing that screen exists to
 * show. `content` is what the vertical budget is measured *to*: everything
 * above it is preamble, however necessary.
 */
const SCREENS: ReadonlyArray<{ name: string; path: string; content: string }> = [
  { name: "overview", path: "/", content: ".panel .chart, .panel .empty-note" },
  { name: "holdings", path: "/holdings", content: ".data-table--holdings tbody tr" },
  { name: "holdings-grouped", path: "/holdings?group=assetClass", content: ".data-table--holdings tbody tr" },
  { name: "analysis", path: "/analysis", content: ".panel .data-table tbody tr, .panel .chart" },
  { name: "income", path: "/income", content: ".panel .data-table tbody tr, .panel .chart" },
  // Resolved at run time: account ids climb on every re-seed, so this
  // follows the first account link on Overview rather than hardcoding one —
  // the same rule `scripts/capture-screenshots.ts` states for its own shots.
  { name: "account-detail", path: "@first-account", content: ".panel .chart, .panel .empty-note" },
  // The write screens are the control group, so their selector has to mean
  // the same thing as the read screens': the first content INSIDE a panel,
  // past its header — not the panel's own top edge, which would flatter them
  // by a panel header and exaggerate the very gap this report is about.
  { name: "settings", path: "/settings", content: ".panel .panel-body > *, .panel .data-table tbody tr" },
  { name: "settings-accounts", path: "/settings/accounts", content: ".panel .data-table tbody tr, .panel .panel-body > *" },
  { name: "upload", path: "/upload", content: ".panel .panel-body > *, .panel .panel-form > *" },
];

type Block = { tag: string; cls: string; top: number; height: number; text: string };
type Measurement = {
  screen: string;
  /** Height of the ungated-demo banner, discounted from every figure below. */
  bannerCost: number;
  path: string;
  viewport: number;
  /** Bottom edge of the sticky top bar — where page content may first appear. */
  chromeBottom: number;
  /** Top of the first element the screen exists to show, or null if absent. */
  contentTop: number | null;
  /** Usable first screenful: viewport height less the top bar and bottom nav. */
  usable: number;
  /** Top-level blocks stacked above the content, with the gap that follows each. */
  blocks: ReadonlyArray<Block & { gapAfter: number }>;
  /** Chrome bottom to the first block. */
  leading: number;
  /** Sum of the gaps between sibling blocks — space carrying nothing. */
  gaps: number;
  /** Last block to the content: a panel header and its padding, not blank. */
  trailing: number;
  /** How many elements scroll sideways. */
  overflowCount: number;
  /** Elements wider than the viewport, i.e. something scrolls or clips sideways. */
  overflowing: ReadonlyArray<{ cls: string; width: number }>;
};

async function resolve(page: Page, path: string): Promise<string> {
  if (path !== "@first-account") return path;
  await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });
  const href = await page.getAttribute('a[href^="/accounts/"]', "href");
  if (href === null) throw new Error("no account link on Overview — is the demo household seeded?");
  return href;
}

async function measure(page: Page, screen: (typeof SCREENS)[number]): Promise<Measurement> {
  const path = await resolve(page, screen.path);
  await page.goto(`${BASE_URL}${path}`, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);

  return page.evaluate(
    ({ contentSel, name, path }) => {
      const rect = (el: Element) => el.getBoundingClientRect();
      const topbar = document.querySelector(".app-topbar");
      const bottomnav = document.querySelector(".app-bottomnav");
      const chromeBottom = topbar ? rect(topbar).bottom : 0;
      const navHeight = bottomnav ? rect(bottomnav).height : 0;

      // The demo instance runs ungated, so `root.tsx` draws the
      // open-instance banner above every page. A real household's instance
      // sits behind the forward-auth gate and never shows it, so its height
      // (and the flex gap it brings) is discounted from every figure here —
      // reported separately rather than silently folded in.
      const banner = document.querySelector(".open-instance-banner");
      const bannerCost = banner === null ? 0 : Math.round((rect(banner).height + 24) * 10) / 10;

      const content = document.querySelector(contentSel);
      const contentTop = content ? rect(content).top + window.scrollY : null;

      // The stacked blocks a reader scrolls past, taken from ONE container so
      // that a parent and its own children are never both counted: `.page`
      // holds the screen's blocks, and anything `.app-main` adds beside it
      // (the first-run prompt, the open-instance banner) is a sibling of the
      // page, not an ancestor of anything in it.
      const page = document.querySelector(".page");
      const main = document.querySelector(".app-main");
      const stacked: Element[] = [];
      if (main) {
        for (const child of Array.from(main.children)) {
          if (child !== page) stacked.push(child);
        }
      }
      if (page) stacked.push(...Array.from(page.children));

      const raw: Array<{ el: Element; top: number; height: number }> = [];
      for (const el of stacked) {
        const r = rect(el);
        if (r.height === 0) continue;
        const top = r.top + window.scrollY;
        // Only what sits wholly above the content counts as preamble; the
        // block that CONTAINS the content is where the screen begins.
        if (contentTop !== null && top + r.height > contentTop) continue;
        raw.push({ el, top, height: r.height });
      }
      raw.sort((a, b) => a.top - b.top);

      const blocks = raw.map((b, i) => {
        const next = raw[i + 1];
        const end = b.top + b.height;
        const gapAfter = next ? Math.round((next.top - end) * 10) / 10 : 0;
        return {
          tag: b.el.tagName.toLowerCase(),
          cls: b.el.className.toString().slice(0, 48),
          top: Math.round(b.top * 10) / 10,
          height: Math.round(b.height * 10) / 10,
          text: (b.el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 44),
          gapAfter,
        };
      });

      // Three different spaces, kept apart because they mean different
      // things: `leading` is chrome-to-first-block, `gaps` is the rhythm
      // between sibling blocks (the only one that is purely empty), and
      // `trailing` is the last block down to the content — which is not
      // blank at all on a panelled screen, it is the panel's own header.
      const leading = blocks.length > 0 ? Math.round((blocks[0].top - chromeBottom) * 10) / 10 : 0;
      const last = blocks[blocks.length - 1];
      const trailing =
        blocks.length > 0 && contentTop !== null
          ? Math.round((contentTop - (last.top + last.height)) * 10) / 10
          : 0;
      const gaps = Math.round(blocks.slice(0, -1).reduce((sum, b) => sum + b.gapAfter, 0) * 10) / 10;

      // A box clamps its own rect inside a scroll container, so a wide table
      // reads as exactly the container's width. What actually overflows is
      // scrollWidth against clientWidth — that is the sideways scroll.
      const overflowing: Array<{ cls: string; width: number }> = [];
      for (const el of Array.from(document.querySelectorAll("*"))) {
        const over = el.scrollWidth - el.clientWidth;
        if (over > 4 && el.clientWidth > 0 && el.className.toString().length > 0) {
          overflowing.push({
            cls: el.className.toString().slice(0, 44),
            width: Math.round(el.scrollWidth),
          });
        }
      }

      return {
        screen: name,
        bannerCost,
        path,
        viewport: window.innerHeight,
        chromeBottom: Math.round(chromeBottom * 10) / 10,
        contentTop: contentTop === null ? null : Math.round(contentTop * 10) / 10,
        usable: Math.round(window.innerHeight - chromeBottom - navHeight),
        blocks,
        leading,
        gaps,
        trailing,
        overflowCount: overflowing.length,
        overflowing: overflowing.slice(0, 6),
      };
    },
    { contentSel: screen.content, name: screen.name, path },
  );
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser: Browser = await chromium.launch(
    EXECUTABLE === undefined ? {} : { executablePath: EXECUTABLE },
  );
  const context = await browser.newContext({
    viewport: PHONE,
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();

  const results: Measurement[] = [];
  for (const screen of SCREENS) {
    const m = await measure(page, screen);
    results.push(m);
    await page.screenshot({ path: `${OUT}/${screen.name}.png`, fullPage: false });

    const preamble =
      m.contentTop === null ? null : Math.round(m.contentTop - m.chromeBottom - m.bannerCost);
    const spent = preamble === null ? "n/a" : `${preamble}px`;
    const share = preamble === null ? "" : ` (${Math.round((preamble / m.usable) * 100)}% of ${m.usable}px)`;
    console.log(
      `${screen.name.padEnd(18)} preamble ${spent.padStart(7)}${share}  lead ${String(m.leading).padStart(5)}  gaps ${String(m.gaps).padStart(5)}  panel-hdr ${String(m.trailing).padStart(5)}  sideways ${m.overflowCount}`,
    );
  }

  writeFileSync(`${OUT}/measurements.json`, `${JSON.stringify(results, null, 2)}\n`);
  console.log(`\nwrote ${OUT}/measurements.json and ${results.length} captures`);
  await browser.close();
}

await main();
