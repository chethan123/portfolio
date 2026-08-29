/**
 * The committed PWA icons, retaken in one command.
 *
 * `public/icon.svg` is the source of truth — the brand tile's white "P" on its
 * blue, as the rail draws it. The PNGs under `public/icons/` are
 * rasterizations of it, committed rather than generated at build time for the
 * same reason the screenshots are: the build stays a build, and the artifacts
 * only change when someone means them to. After editing the SVG:
 *
 *   node ./scripts/render-icons.ts
 *
 * The maskable variant is the same drawing with the corner radius removed.
 * Android crops its own shape out of a full-bleed square and guarantees only a
 * centred circle of 40% radius; the glyph sits well inside it, so no rescaling
 * is needed — just square corners.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { chromium } from "playwright";

/** Same escape hatch as `capture-screenshots.ts`, for images with a browser. */
const EXECUTABLE = process.env.CHROMIUM_EXECUTABLE;

const svg = readFileSync(new URL("../public/icon.svg", import.meta.url), "utf8");

/** name → [markup, edge in pixels] */
const RENDERS: Record<string, [string, number]> = {
  "icon-192.png": [svg, 192],
  "icon-512.png": [svg, 512],
  "icon-maskable-512.png": [svg.replace('rx="14"', 'rx="0"'), 512],
};

async function main(): Promise<void> {
  const outDir = new URL("../public/icons/", import.meta.url);
  mkdirSync(outDir, { recursive: true });

  const browser = await chromium.launch({
    executablePath: EXECUTABLE,
    args: ["--no-sandbox"],
  });

  try {
    const page = await browser.newPage();
    for (const [name, [markup, edge]] of Object.entries(RENDERS)) {
      const sized = markup.replace("<svg ", `<svg width="${edge}" height="${edge}" `);
      await page.setContent(`<body style="margin:0">${sized}</body>`);
      const png = await page.locator("svg").screenshot({ omitBackground: true });
      writeFileSync(new URL(name, outDir), png);
      console.log(`wrote public/icons/${name} (${png.length} bytes)`);
    }
  } finally {
    await browser.close();
  }
}

await main();
