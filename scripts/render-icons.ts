/**
 * The committed PWA icons, retaken in one command. `public/icon.svg` is the
 * source of truth; the PNGs under `public/icons/` are its rasterizations,
 * committed so the build stays a build and artifacts change only when someone
 * means them to. After editing the SVG:
 *
 *   node ./scripts/render-icons.ts
 *
 * The manifest's `icons` array is this script's to write, as `data:` URIs —
 * the rest of `public/manifest.webmanifest` stays hand-written. Inlined
 * because Android's WebAPK icon hasher fetches manifest icons with no cookies
 * (Chromium `webapk_single_icon_hasher.cc`): behind the gate an icon URL gets
 * the sign-in redirect and install greys out. A `data:` URI leaves nothing to
 * fetch and keeps every path gated.
 *
 * The maskable variant is the same drawing minus the corner radius: Android
 * crops its own shape from a full-bleed square, guaranteeing only a centred
 * 40%-radius circle, and the glyph already sits well inside it.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { chromium } from "playwright";

/** Same escape hatch as `capture-screenshots.ts`, for images with a browser. */
const EXECUTABLE = process.env.CHROMIUM_EXECUTABLE;

const svg = readFileSync(new URL("../public/icon.svg", import.meta.url), "utf8");

const ICONS = [
  { file: "icon-192.png", edge: 192, markup: svg, purpose: "any" },
  { file: "icon-512.png", edge: 512, markup: svg, purpose: "any" },
  { file: "icon-maskable-512.png", edge: 512, markup: svg.replace('rx="14"', 'rx="0"'), purpose: "maskable" },
] as const;

async function main(): Promise<void> {
  const outDir = new URL("../public/icons/", import.meta.url);
  mkdirSync(outDir, { recursive: true });

  const browser = await chromium.launch({
    executablePath: EXECUTABLE,
    args: ["--no-sandbox"],
  });

  const rendered: { icon: (typeof ICONS)[number]; png: Buffer }[] = [];
  try {
    const page = await browser.newPage();
    for (const icon of ICONS) {
      const sized = icon.markup.replace("<svg ", `<svg width="${icon.edge}" height="${icon.edge}" `);
      await page.setContent(`<body style="margin:0">${sized}</body>`);
      const png = await page.locator("svg").screenshot({ omitBackground: true });
      writeFileSync(new URL(icon.file, outDir), png);
      console.log(`wrote public/icons/${icon.file} (${png.length} bytes)`);
      rendered.push({ icon, png });
    }
  } finally {
    await browser.close();
  }

  const manifestUrl = new URL("../public/manifest.webmanifest", import.meta.url);
  const manifest = JSON.parse(readFileSync(manifestUrl, "utf8")) as { icons: unknown };
  manifest.icons = rendered.map(({ icon, png }) => ({
    src: `data:image/png;base64,${png.toString("base64")}`,
    sizes: `${icon.edge}x${icon.edge}`,
    type: "image/png",
    purpose: icon.purpose,
  }));
  writeFileSync(manifestUrl, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log("wrote public/manifest.webmanifest icons as data: URIs");
}

await main();
