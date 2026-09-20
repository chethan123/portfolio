import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const outputDirectory = process.argv[2];
if (!outputDirectory) throw new Error("Usage: node compare-formatters.mjs <new-output-directory>");
const origins = [process.env.REVIEW_BASELINE_ORIGIN ?? "http://127.0.0.1:3417", process.env.REVIEW_REUSED_ORIGIN ?? "http://127.0.0.1:3418"];
const results = [];
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
for (const range of ["1w", "3m", "1d"]) {
  const measurements = [[], []];
  const hashes = [new Set(), new Set()];
  for (let run = 0; run < 9; run++) {
    for (const index of run % 2 === 0 ? [0, 1] : [1, 0]) {
      const start = performance.now();
      const response = await fetch(`${origins[index]}/?range=${range}`, { headers: { "accept-encoding": "identity" } });
      const ttfbMs = performance.now() - start;
      const body = await response.text();
      if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
      if (run >= 2) measurements[index].push({ ttfbMs, totalMs: performance.now() - start, bytes: Buffer.byteLength(body) });
      hashes[index].add(createHash("sha256").update(body).digest("hex"));
    }
  }
  const result = {
    range,
    sameHtml: hashes[0].size === 1 && hashes[1].size === 1 && [...hashes[0]][0] === [...hashes[1]][0],
    baselineMedianTtfbMs: median(measurements[0].map(x => x.ttfbMs)),
    reusedMedianTtfbMs: median(measurements[1].map(x => x.ttfbMs)),
    baselineMedianTotalMs: median(measurements[0].map(x => x.totalMs)),
    reusedMedianTotalMs: median(measurements[1].map(x => x.totalMs)),
    measurements,
  };
  results.push(result);
  console.log(JSON.stringify(result));
}
await writeFile(resolve(outputDirectory, "formatter-comparison.json"), JSON.stringify({ method: "Same production build and isolated seeded database, second process reuses only identical en-CA/h23/weekday-short Intl formatters. Two warmups then seven alternating pairs per range. Loopback HTTP, identity encoding, no network or CPU throttle. No source modifications.", results }, null, 2), { flag: "wx" });
