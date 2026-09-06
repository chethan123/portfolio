// worker's fetch logic is deliberately untested: one short file kept readable enough to audit
// by eye. Its rule — nothing ever stored on the device — is ADR-0007's, tripwired below.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { renderThroughLayout } from "./support/render.tsx";

const PUBLIC = new URL("../public/", import.meta.url);

type Manifest = {
  name: string;
  short_name: string;
  start_url: string;
  display: string;
  icons: { src: string; sizes: string; purpose: string }[];
};

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
});

describe("the manifest", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("manifest.webmanifest", PUBLIC), "utf8"),
  ) as Manifest;

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
    const committed: Record<string, string> = {
      "192x192:any": "icon-192.png",
      "512x512:any": "icon-512.png",
      "512x512:maskable": "icon-maskable-512.png",
    };

    expect(manifest.icons).toHaveLength(Object.keys(committed).length);
    for (const icon of manifest.icons) {
      const file = committed[`${icon.sizes}:${icon.purpose}`];
      expect(file).toBeDefined();
      const bytes = readFileSync(new URL(`icons/${file}`, PUBLIC));
      expect(icon.src).toBe(`data:image/png;base64,${bytes.toString("base64")}`);
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
