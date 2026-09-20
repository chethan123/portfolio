import { chromium } from "playwright";
import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";

const outputDirectory = process.argv[2];
if (!outputDirectory) throw new Error("Usage: node measure.mjs <new-output-directory>");
const origin = process.env.REVIEW_BASELINE_ORIGIN ?? "http://127.0.0.1:3417";
const routes = ["/?range=1w", "/?range=1d", "/holdings"];
const results = [];
const documents = [];
for (const route of [...routes, "/?range=1y"]) {
  const timings = [];
  let body;
  let headers;
  for (let run = 0; run < 3; run++) {
    const start = performance.now();
    const response = await fetch(origin + route, { headers: { "accept-encoding": "identity" } });
    const ttfbMs = performance.now() - start;
    body = await response.text();
    headers = Object.fromEntries(response.headers);
    timings.push({ ttfbMs, endMs: performance.now() - start });
    if (response.status !== 200) throw new Error(`${route}: ${response.status}`);
  }
  documents.push({ route, decodedBytes: Buffer.byteLength(body), timings, cacheControl: headers["cache-control"] });
}
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH });
try {
  for (const route of routes) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, serviceWorkers: "block" });
    const page = await context.newPage();
    await page.addInitScript(() => {
      window.reviewPerf = { lcp: 0, longTasks: [] };
      new PerformanceObserver(list => { for (const entry of list.getEntries()) window.reviewPerf.lcp = entry.startTime; }).observe({ type: "largest-contentful-paint", buffered: true });
      new PerformanceObserver(list => { for (const entry of list.getEntries()) window.reviewPerf.longTasks.push({ start: entry.startTime, duration: entry.duration }); }).observe({ type: "longtask", buffered: true });
    });
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 150, downloadThroughput: 187500, uploadThroughput: 93750, connectionType: "cellular3g" });
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    const failures = [];
    page.on("pageerror", error => failures.push(error.message));
    for (const visit of ["cold", "repeat"]) {
      const response = await page.goto(origin + route, { waitUntil: "networkidle", timeout: 60000 });
      const measurements = await page.evaluate(() => {
        const navigation = performance.getEntriesByType("navigation")[0];
        const resources = performance.getEntriesByType("resource").map(entry => ({
          path: new URL(entry.name).pathname,
          initiator: entry.initiatorType,
          transferBytes: entry.transferSize,
          encodedBytes: entry.encodedBodySize,
          decodedBytes: entry.decodedBodySize,
          durationMs: entry.duration,
          startMs: entry.startTime,
        }));
        return {
          ttfbMs: navigation.responseStart,
          responseEndMs: navigation.responseEnd,
          loadMs: navigation.loadEventEnd,
          fcpMs: performance.getEntriesByName("first-contentful-paint")[0]?.startTime,
          lcpMs: window.reviewPerf.lcp,
          documentEncodedBytes: navigation.encodedBodySize,
          documentDecodedBytes: navigation.decodedBodySize,
          documentTransferBytes: navigation.transferSize,
          totalTransferBytes: navigation.transferSize + resources.reduce((sum, resource) => sum + resource.transferBytes, 0),
          elements: document.querySelectorAll("*").length,
          longTasks: window.reviewPerf.longTasks,
          resources,
        };
      });
      const record = { route, visit, status: response.status(), encoding: response.headers()["content-encoding"], failures: [...failures], ...measurements };
      results.push(record);
      console.log(JSON.stringify({ ...record, resources: record.resources.map(r => ({ path: r.path, transferBytes: r.transferBytes })), longTasks: record.longTasks.length }));
      await page.goto("about:blank");
    }
    await context.close();
  }
} finally {
  await browser.close();
}
const report = {
  generated: new Date().toISOString(),
  origin,
  conditions: { downloadMbps: 1.5, latencyMs: 150, cpuSlowdown: 4, viewport: "390×844", serviceWorker: "blocked for HTTP cache isolation", transport: "loopback HTTP; gate, TLS and VPN excluded", sampling: "one cold and one repeat visit per route; illustrative, not a production percentile" },
  referenceDataset: { accounts: 21, holdings: 97, feedInstruments: 98, observationRows: 174636, sessions: 66, latestSessionInstants: 1620 },
  documents,
  results,
};
await writeFile(resolve(outputDirectory, "measurements.json"), JSON.stringify(report, null, 2), { flag: "wx" });
console.log("Saved measurements.json");
