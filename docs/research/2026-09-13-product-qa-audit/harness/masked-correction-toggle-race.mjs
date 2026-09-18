/**
 * Browser follow-up regression for the QA-23 remediation's masking races.
 *
 * Requires a running production build and a seeded database containing the named account/symbol:
 *   PORTFOLIO_URL=http://127.0.0.1:3100 \
 *   DATABASE_URL=postgres://... \
 *   node docs/research/2026-09-13-product-qa-audit/harness/masked-correction-toggle-race.mjs
 *
 * Optional: MASKING_RACE_ACCOUNT, MASKING_RACE_SYMBOL (demo defaults below).
 *
 * To reproduce the failing main behavior, temporarily make `useMasked()` return the successful
 * root loader's `masked` value instead of giving the current browser cookie precedence. A resolved
 * `route.fulfill()` proves network delivery only; the MutationObserver below proves whether React
 * Router committed and painted the stale exact payload after the newer Hide.
 */
import assert from "node:assert/strict";

import pg from "pg";
import { chromium } from "playwright";

const base = process.env.PORTFOLIO_URL ?? "http://127.0.0.1:3100";
const databaseUrl = process.env.DATABASE_URL;
const accountName = process.env.MASKING_RACE_ACCOUNT ?? "Fidelity Individual";
const symbol = process.env.MASKING_RACE_SYMBOL ?? "VTI";

if (databaseUrl === undefined) throw new Error("DATABASE_URL is required.");

const pool = new pg.Pool({ connectionString: databaseUrl });
const target = await pool
  .query(
    `select account_id::text as account_id,
            instrument_id::text as instrument_id,
            quantity,
            cost_basis_per_share
       from holding_valued
      where account_name = $1 and symbol = $2`,
    [accountName, symbol],
  )
  .then(({ rows }) => rows[0]);
await pool.end();

if (target === undefined || target.cost_basis_per_share === null) {
  throw new Error("The selected fixture must have one current holding with a cost basis.");
}

const path = `/holdings?account=${target.account_id}&edit=${target.account_id}.${target.instrument_id}`;

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitForBarrier(barrier, label) {
  let timer;
  try {
    await Promise.race([
      barrier.promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}.`)), 30_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function nextPaint(page) {
  await page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
  );
}

const browser = await chromium.launch({ args: ["--no-sandbox"] });

try {
  const context = await browser.newContext({ viewport: { width: 390, height: 900 } });
  await context.addCookies([{ name: "masked", value: "1", url: base }]);
  const page = await context.newPage();
  await page.goto(`${base}${path}`, { waitUntil: "networkidle" });

  const showCaptured = deferred();
  const showRelease = deferred();
  const showFinished = deferred();
  const hideCaptured = deferred();
  const hideRelease = deferred();
  const hideFinished = deferred();
  let showDelivery = "pending";
  let hideDelivery = "pending";
  let sequence = 0;

  await page.evaluate(() => {
    window.maskRaceHideStarted = false;
    window.maskRaceLeaks = [];
    new MutationObserver(() => {
      if (!window.maskRaceHideStarted) return;
      const values = [
        ...document.querySelectorAll("input[name=quantity], input[name=costBasisPerShare]"),
      ].map((input) => input.value);
      if (values.length > 0) window.maskRaceLeaks.push(values);
    }).observe(document.body, { childList: true, subtree: true, attributes: true });
  });

  await page.route("**/holdings.data*", async (route) => {
    if (route.request().method() !== "GET") return route.continue();

    const number = ++sequence;
    const response = await route.fetch();
    const body = await response.text();

    if (number === 1) {
      assert.ok(body.includes(target.quantity));
      assert.ok(body.includes(target.cost_basis_per_share));
      showCaptured.resolve();
      await waitForBarrier(showRelease, "the stale Show response release");
    } else if (number === 2) {
      assert.ok(!body.includes(target.quantity));
      assert.ok(!body.includes(target.cost_basis_per_share));
      hideCaptured.resolve();
      await waitForBarrier(hideRelease, "the newer Hide response release");
    }

    try {
      await route.fulfill({ response });
      if (number === 1) showDelivery = "delivered";
      if (number === 2) hideDelivery = "delivered";
    } catch (error) {
      if (!/closed|canceled|cancelled|Invalid Interception/i.test(String(error))) throw error;
      if (number === 1) showDelivery = "cancelled";
      if (number === 2) hideDelivery = "cancelled";
    } finally {
      if (number === 1) showFinished.resolve();
      if (number === 2) hideFinished.resolve();
    }
  });

  await page
    .getByRole("banner")
    .getByRole("button", { name: "Show amounts", exact: true })
    .click();
  await waitForBarrier(showCaptured, "the Show loader response");
  assert.equal(await page.locator("input[name=quantity]").count(), 0);

  await page.evaluate(() => {
    window.maskRaceHideStarted = true;
  });
  await page
    .getByRole("banner")
    .getByRole("button", { name: "Hide amounts", exact: true })
    .click();
  await waitForBarrier(hideCaptured, "the Hide loader response");

  hideRelease.resolve();
  await waitForBarrier(hideFinished, "the Hide response delivery");
  assert.equal(hideDelivery, "delivered", "The newer Hide response must reach the router.");
  await page
    .getByRole("banner")
    .getByRole("button", { name: "Show amounts", exact: true })
    .waitFor();
  await nextPaint(page);

  showRelease.resolve();
  await waitForBarrier(showFinished, "the stale Show response delivery");
  assert.equal(
    showDelivery,
    "delivered",
    "The older Show response must reach the router for this harness to exercise precedence.",
  );
  console.log(`Race delivery: Hide ${hideDelivery}; older Show ${showDelivery}.`);
  await page.waitForLoadState("networkidle");
  await nextPaint(page);

  assert.deepEqual(await page.evaluate(() => window.maskRaceLeaks), []);
  assert.equal(await page.locator("input[name=quantity], input[name=costBasisPerShare]").count(), 0);

  await context.close();

  const failedContext = await browser.newContext({ viewport: { width: 390, height: 900 } });
  await failedContext.addCookies([{ name: "masked", value: "1", url: base }]);
  const failedPage = await failedContext.newPage();
  await failedPage.goto(`${base}${path}`, { waitUntil: "networkidle" });
  await failedPage
    .getByRole("banner")
    .getByRole("button", { name: "Show amounts", exact: true })
    .click();
  await failedPage.locator("input[name=quantity]").waitFor();

  await failedPage.route("**/masking.data*", (route) => route.abort("failed"));
  await failedPage
    .getByRole("banner")
    .getByRole("button", { name: "Hide amounts", exact: true })
    .click();
  await failedPage
    .getByRole("banner")
    .getByRole("button", { name: "Show amounts", exact: true })
    .waitFor();
  await nextPaint(failedPage);

  assert.equal(
    await failedPage.locator("input[name=quantity], input[name=costBasisPerShare]").count(),
    0,
  );
  assert.match(
    (await failedContext.cookies(base)).find(({ name }) => name === "masked")?.value ?? "",
    /^1$/,
  );

  await failedContext.close();
  console.log(
    `PASS: Hide ${hideDelivery}; older Show ${showDelivery}; neither stale Show data nor a failed Hide remounted correction inputs.`,
  );
} finally {
  await browser.close();
}
