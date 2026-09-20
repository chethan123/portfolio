// Read-only diagnostic: fetch existing HTML, simulate geometry serialization in memory,
// compare identical compression settings, and print JSON. No files or app state are written.
// Replay (server must use the audit fixture with 1,620 observed instants):
// node chart-precision.mjs http://127.0.0.1:3417/?range=1d 1620
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gzipSync, brotliCompressSync, constants } from "node:zlib";

const url = process.argv[2] ?? "http://127.0.0.1:3417/?range=1d";
const expectedTargets = Number(process.argv[3] ?? "1620");
const response = await fetch(url);
assert.equal(response.status, 200);
const original = await response.text();

let originalEdgePercent = 0;
let previousRoundedEdgeMilliPercent = 0;
let maxSvgCoordinateErrorViewBoxUnits = 0;
let maxGuideOrMarkerErrorPercentagePoints = 0;
let maxHitEdgeErrorPercentagePoints = 0;
let maxHitWidthErrorPercentagePoints = 0;
let svgCoordinateValuesChanged = 0;

const geometryOnly = original
  .replace(
    /<(?:polyline|path)\b[^>]*\bclass="chart-(?:line|area)[^"]*"[^>]*>/g,
    (tag) => tag.replace(/\b(points|d)="([^"]*)"/g, (_, attribute, value) =>
      `${attribute}="${value.replace(/-?\d+\.\d+/g, (number) => {
        const rounded = Number(Number(number).toFixed(2));
        const error = Math.abs(Number(number) - rounded);
        maxSvgCoordinateErrorViewBoxUnits = Math.max(maxSvgCoordinateErrorViewBoxUnits, error);
        if (error > 0) svgCoordinateValuesChanged += 1;
        return String(rounded);
      })}"`,
    ),
  )
  .replace(
    /<(?:div|span)\b[^>]*\bclass="chart-(?:hit|guide|marker)"[^>]*>/g,
    (tag) => tag.replace(/(width|left|top):(-?\d+(?:\.\d+)?)%/g, (_, property, number) => {
      const value = Number(number);
      if (property === "width") {
        // Round cumulative edges, then difference them. Independent width rounding drifts.
        originalEdgePercent += value;
        const roundedEdgeMilliPercent = Math.round(originalEdgePercent * 1000);
        const roundedWidth = (roundedEdgeMilliPercent - previousRoundedEdgeMilliPercent) / 1000;
        previousRoundedEdgeMilliPercent = roundedEdgeMilliPercent;
        maxHitEdgeErrorPercentagePoints = Math.max(
          maxHitEdgeErrorPercentagePoints,
          Math.abs(originalEdgePercent - roundedEdgeMilliPercent / 1000),
        );
        maxHitWidthErrorPercentagePoints = Math.max(
          maxHitWidthErrorPercentagePoints,
          Math.abs(value - roundedWidth),
        );
        return `${property}:${roundedWidth}%`;
      }
      const rounded = Number(value.toFixed(3));
      maxGuideOrMarkerErrorPercentagePoints = Math.max(
        maxGuideOrMarkerErrorPercentagePoints,
        Math.abs(value - rounded),
      );
      return `${property}:${rounded}%`;
    }),
  );

function readouts(html, className) {
  return [...html.matchAll(new RegExp(`<span class="${className}">([\\s\\S]*?)<\\/span>`, "g"))]
    .map((match) => match[1]);
}

function hitWidths(html) {
  return [...html.matchAll(/<div\b[^>]*\bclass="chart-hit"[^>]*>/g)]
    .map(([tag]) => Number(tag.match(/\bwidth:([\d.]+)%/)?.[1]));
}

function linePointCounts(html) {
  return [...html.matchAll(/<polyline\b[^>]*\bclass="chart-line[^"]*"[^>]*>/g)]
    .map(([tag]) => tag.match(/\bpoints="([^"]*)"/)?.[1].trim().split(/\s+/).length ?? 0);
}

const datesBefore = readouts(original, "chart-readout-date");
const datesAfter = readouts(geometryOnly, "chart-readout-date");
const amountsBefore = readouts(original, "chart-readout-value");
const amountsAfter = readouts(geometryOnly, "chart-readout-value");
const widthsBefore = hitWidths(original);
const widthsAfter = hitWidths(geometryOnly);
const pointsBefore = linePointCounts(original);
const pointsAfter = linePointCounts(geometryOnly);
assert.equal(widthsBefore.length, expectedTargets, "Unexpected audit fixture point count");
assert.equal(widthsAfter.length, widthsBefore.length);
assert.equal(datesBefore.length, expectedTargets + 1, "Point readouts plus the resting readout");
assert.equal(amountsBefore.length, datesBefore.length);
assert.deepEqual(datesAfter, datesBefore, "Date readout strings changed");
assert.deepEqual(amountsAfter, amountsBefore, "Amount readout strings changed");
assert.deepEqual(pointsAfter, pointsBefore, "SVG point count changed");
assert.ok(widthsAfter.every((width) => Number.isFinite(width) && width >= 0));
assert.equal(widthsAfter.filter((width, i) => width === 0 && widthsBefore[i] > 0).length, 0,
  "A previously positive hit target collapsed to zero width");
const totalMilliPercentAfter = widthsAfter.reduce((sum, width) => sum + Math.round(width * 1000), 0);
assert.equal(totalMilliPercentAfter, 100000, "Hit targets must tile exactly 100 percent");
assert.ok(maxSvgCoordinateErrorViewBoxUnits <= 0.005 + 1e-10);
assert.ok(maxGuideOrMarkerErrorPercentagePoints <= 0.0005 + 1e-10);
assert.ok(maxHitEdgeErrorPercentagePoints <= 0.0005 + 1e-10);

function sizes(html) {
  return {
    rawBytes: Buffer.byteLength(html),
    gzipLevel6Bytes: gzipSync(html, { level: 6 }).length,
    brotliQuality4Bytes: brotliCompressSync(html, {
      params: { [constants.BROTLI_PARAM_QUALITY]: 4 },
    }).length,
  };
}
const before = sizes(original);
const after = sizes(geometryOnly);
console.log(JSON.stringify({
  measuredAt: new Date().toISOString(),
  sourceUrl: response.url,
  nodeVersion: process.version,
  responseSha256: createHash("sha256").update(original).digest("hex"),
  method: "Existing response fetched once; chart geometry serialization simulated in memory. Neither app implementation nor served response changed.",
  compressionCaveat: "Both versions recompressed locally with identical settings. Brotli quality 4 figures are estimates, not observed transfer sizes; live streaming and flush behavior can change them.",
  before,
  after,
  saved: Object.fromEntries(Object.keys(before).map((key) => [key, before[key] - after[key]])),
  preserved: {
    targetsBefore: widthsBefore.length,
    targetsAfter: widthsAfter.length,
    linePointCountsBefore: pointsBefore,
    linePointCountsAfter: pointsAfter,
    dateReadoutCount: datesBefore.length,
    amountReadoutCount: amountsBefore.length,
    exactDateReadoutStringsEqual: true,
    exactAmountReadoutStringsEqual: true,
    newlyZeroWidthTargets: 0,
    targetWidthsTotalPercentBefore: widthsBefore.reduce((sum, width) => sum + width, 0),
    targetWidthsTotalPercentAfterExactDecimal: totalMilliPercentAfter / 1000,
  },
  geometry: {
    svgCoordinateValuesChanged,
    maxSvgCoordinateErrorViewBoxUnits,
    svgErrorInterpretation: "Theoretical maximum is 0.005 viewBox units per coordinate; CSS-pixel errors are 0.005 * renderedWidth / 1000 horizontally and 0.005 * renderedHeight / 300 vertically.",
    maxGuideOrMarkerErrorPercentagePoints,
    maxHitEdgeErrorPercentagePoints,
    maxHitWidthErrorPercentagePoints,
    percentErrorInterpretation: "Guide/marker offsets and cumulative hit edges move at most 0.0005 percentage points, or 0.000005 * rendered dimension CSS pixels. Individual widths are differences of rounded edges and can differ by up to 0.001 percentage points; total width stays exactly 100 percent.",
  },
}, null, 2));
