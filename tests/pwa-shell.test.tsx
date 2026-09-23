// worker's fetch logic is deliberately untested: one short file kept readable enough to audit
// by eye. Its rule — nothing ever stored on the device — is ADR-0007's, tripwired below.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { renderThroughLayout } from "./support/render.tsx";

const PUBLIC = new URL("../public/", import.meta.url);
const APP = new URL("../app/", import.meta.url);

type Manifest = {
  name: string;
  short_name: string;
  start_url: string;
  display: string;
  icons: { src: string; sizes: string; purpose: string }[];
};

const manifestSource = readFileSync(new URL("manifest.webmanifest", PUBLIC), "utf8");
const manifest = JSON.parse(manifestSource) as Manifest;

const committedIcons = {
  "192x192:any": { file: "icon-192.png", edge: 192, transparent: true },
  "512x512:any": { file: "icon-512.png", edge: 512, transparent: true },
  "512x512:maskable": { file: "icon-maskable-512.png", edge: 512, transparent: false },
} as const;

function pngChunkTypes(bytes: Buffer): string[] {
  const chunks: string[] = [];
  let offset = 8;

  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) throw new Error("Invalid PNG chunk length");
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    chunks.push(type);
    offset = end;
    if (type === "IEND") break;
  }

  return chunks;
}

describe("the document shell", () => {
  it("links the manifest with credentials so the gate's cookie travels with Chrome's fetch", () => {
    const html = renderThroughLayout("/", { gated: true, firstRun: null });

    expect(html).toContain('rel="manifest"');
    expect(html).toContain('href="/manifest.webmanifest"');
    expect(html).toContain('crossorigin="use-credentials"');
  });

  it("names an icon for the tab and registers the service worker", () => {
    const html = renderThroughLayout("/", { gated: true, firstRun: null });

    expect(html).toContain('rel="icon"');
    expect(html).toContain('navigator.serviceWorker.register("/sw.js")');
  });

  it("preloads the font as a CORS fetch, or the browser discards the preload and fetches it twice", () => {
    const html = renderThroughLayout("/", { gated: true, firstRun: null });

    const preload = html.match(/<link [^>]*rel="preload"[^>]*>/)?.[0];
    expect(preload).toBeDefined();
    expect(preload).toContain('as="font"');
    expect(preload).toContain('type="font/woff2"');
    expect(preload).toContain('crossorigin="anonymous"');
    expect(preload).toMatch(/href="[^"]*inter-latin-var[^"]*\.woff2"/);
  });
});

describe("the type stack", () => {
  const css = readFileSync(new URL("app.css", APP), "utf8");

  it("declares a size-adjusted face for every fallback it names, or the browser skips the name silently", () => {
    const stack = css.match(/--font-ui:\s*([^;]+);/)?.[1];
    expect(stack).toBeDefined();

    const families = (stack ?? "").split(",").map((family) => family.trim());
    expect(families[0]).toBe('"Inter"');

    // Everything between Inter and the first system family. A name here with no `@font-face`
    // is skipped silently, which is the failure this pins.
    const fallbacks: string[] = [];
    for (const family of families.slice(1)) {
      if (!family.startsWith('"Inter Fallback')) break;
      fallbacks.push(family);
    }
    expect(fallbacks.length).toBeGreaterThan(0);

    const faces = css.split("@font-face").slice(1);
    for (const family of fallbacks) {
      const declared = faces.filter((block) => block.includes(`font-family: ${family};`));
      expect(declared.length, `${family} has no @font-face`).toBeGreaterThan(0);
      for (const face of declared) expect(face).toContain("size-adjust:");
    }
  });
});

describe("the manifest", () => {
  it("carries the members installation depends on", () => {
    expect(manifest.name).toBeTruthy();
    // Lighthouse's home-screen label budget
    expect(manifest.short_name.length).toBeLessThanOrEqual(12);
    expect(manifest.start_url).toBe("/");
    expect(manifest.display).toBe("standalone");
  });

  it("offers 192, 512 and a separate maskable icon", () => {
    const sizes = manifest.icons.map((icon) => icon.sizes);
    expect(sizes).toContain("192x192");
    expect(sizes).toContain("512x512");

    // separate entries, never combined "any maskable" — Android renders the combined form badly
    const purposes = manifest.icons.map((icon) => icon.purpose);
    expect(purposes).toContain("maskable");
    expect(purposes).not.toContain("any maskable");
  });

  it("inlines each icon as a data: URI matching its committed PNG, so no icon fetch can hit the gate", () => {
    // Android's WebAPK icon hasher fetches icon URLs without cookies — an icon URL behind the
    // gate greys out install. A data: URI leaves nothing to fetch.
    expect(manifest.icons).toHaveLength(Object.keys(committedIcons).length);
    for (const icon of manifest.icons) {
      const committed = committedIcons[`${icon.sizes}:${icon.purpose}` as keyof typeof committedIcons];
      expect(committed).toBeDefined();
      const bytes = readFileSync(new URL(`icons/${committed.file}`, PUBLIC));
      expect(icon.src).toBe(`data:image/png;base64,${bytes.toString("base64")}`);
    }
  });

  it("keeps its inline icons as compact palette PNGs", () => {
    expect(Buffer.byteLength(manifestSource, "utf8")).toBeLessThan(9_000);

    const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    for (const icon of Object.values(committedIcons)) {
      const bytes = readFileSync(new URL(`icons/${icon.file}`, PUBLIC));
      expect(bytes.subarray(0, signature.length)).toEqual(signature);
      expect(bytes.toString("ascii", 12, 16)).toBe("IHDR");
      expect(bytes.readUInt32BE(16)).toBe(icon.edge);
      expect(bytes.readUInt32BE(20)).toBe(icon.edge);
      expect(bytes[25]).toBe(3);

      const chunks = pngChunkTypes(bytes);
      expect(chunks).toContain("PLTE");
      if (icon.transparent) expect(chunks).toContain("tRNS");
      else expect(chunks).not.toContain("tRNS");
    }
  });
});

describe("the service worker", () => {
  const worker = readFileSync(new URL("sw.js", PUBLIC), "utf8");

  it("carries the way back in on its offline page", () => {
    expect(worker).toContain("Connect the VPN");
  });

  it("opens no storage of any kind, which is the whole of ADR-0007", () => {
    expect(worker).not.toContain("caches.open");
    expect(worker).not.toContain("indexedDB");
  });
});
