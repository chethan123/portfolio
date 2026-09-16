/**
 * Cross-tab browser regressions for QA-23's masking cookie.
 *
 * Requires a running production build and the same seeded fixture as
 * masked-correction-toggle-race.mjs. No financial value crosses the tab notification channel.
 */
import assert from "node:assert/strict";

import pg from "pg";
import { chromium } from "playwright";

const base = process.env.PORTFOLIO_URL ?? "http://127.0.0.1:3100";
const databaseUrl = process.env.DATABASE_URL;
const accountName = process.env.MASKING_RACE_ACCOUNT ?? "Fidelity Individual";
const symbol = process.env.MASKING_RACE_SYMBOL ?? "VTI";
const lifecyclePasskey = "qa-cross-tab-lifecycle";
const lifecycleGrant = "qa-cross-tab-lifecycle-grant-0000000000000001";

if (databaseUrl === undefined) throw new Error("DATABASE_URL is required.");

const pool = new pg.Pool({ connectionString: databaseUrl });
const target = await pool
  .query(
    `select account_id::text as account_id,
            instrument_id::text as instrument_id
       from holding_valued
      where account_name = $1 and symbol = $2`,
    [accountName, symbol],
  )
  .then(({ rows }) => rows[0]);

if (target === undefined) throw new Error("The selected fixture must have one current holding.");

const path = `/holdings?account=${target.account_id}&edit=${target.account_id}.${target.instrument_id}`;
const inputs = "input[name=quantity], input[name=costBasisPerShare]";

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
    return await Promise.race([
      barrier.promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}.`)), 30_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function maskingCookie(context) {
  return (await context.cookies(base)).find(({ name }) => name === "masked")?.value;
}

async function buttonLabel(page) {
  return page.getByRole("banner").locator("button.masking-toggle span").first().textContent();
}

const browser = await chromium.launch({ args: ["--no-sandbox"] });

try {
  // A refused enhanced policy save preserves the current Hide; a successful one still resets it.
  await pool.query("update app_setting set masking_policy = 'masked'");
  const settingsFlow = await browser.newContext({ viewport: { width: 1000, height: 800 } });
  await settingsFlow.addCookies([{ name: "masked", value: "1", url: base }]);
  const settingsFlowPage = await settingsFlow.newPage();
  await settingsFlowPage.goto(`${base}/settings/display`, { waitUntil: "networkidle" });
  await settingsFlowPage
    .locator('input[name="maskingPolicy"]:checked')
    .evaluate((radio) => {
      radio.value = "sometimes";
    });
  await settingsFlowPage.getByRole("button", { name: "Save", exact: true }).click();
  await settingsFlowPage.getByText("Choose a masking policy.", { exact: true }).waitFor();
  const refusedSettingsCookie = await maskingCookie(settingsFlow);

  await settingsFlowPage.getByRole("radio", { name: /Showing amounts/ }).check();
  await settingsFlowPage.getByRole("button", { name: "Save", exact: true }).click();
  await settingsFlowPage.waitForFunction(() => !document.cookie.includes("masked="));
  const successfulSettingsCookie = await maskingCookie(settingsFlow);
  await settingsFlow.close();
  await pool.query("update app_setting set masking_policy = 'masked'");

  // Show in a sibling tab cannot fill a projection that deliberately omitted exact values. The
  // receiving tab remains gated until its own Show submits and revalidates.
  const showScope = await browser.newContext({ viewport: { width: 1000, height: 800 } });
  await showScope.addCookies([{ name: "masked", value: "1", url: base }]);
  const showHere = await showScope.newPage();
  const stayGated = await showScope.newPage();
  await showHere.goto(`${base}${path}`, { waitUntil: "networkidle" });
  await stayGated.goto(`${base}${path}`, { waitUntil: "networkidle" });
  await showHere.getByRole("button", { name: "Show amounts", exact: true }).first().click();
  await showHere.locator(inputs).first().waitFor();
  const siblingShowInputs = await stayGated.locator(inputs).count();
  const siblingShowLabel = await buttonLabel(stayGated);
  await stayGated.getByRole("button", { name: "Show amounts", exact: true }).first().click();
  await stayGated.locator(inputs).first().waitFor();
  const localShowInputs = await stayGated.locator(inputs).count();
  await showScope.close();

  // One tab hides while another still has exact correction inputs mounted.
  const shared = await browser.newContext({ viewport: { width: 1000, height: 800 } });
  await shared.addCookies([{ name: "masked", value: "0", url: base }]);
  const editor = await shared.newPage();
  const control = await shared.newPage();
  await editor.goto(`${base}${path}`, { waitUntil: "networkidle" });
  await control.goto(`${base}/holdings?account=${target.account_id}`, { waitUntil: "networkidle" });
  assert.equal(await editor.locator(inputs).count(), 2);

  await control
    .getByRole("banner")
    .getByRole("button", { name: "Hide amounts", exact: true })
    .click();
  await control
    .getByRole("banner")
    .getByRole("button", { name: "Show amounts", exact: true })
    .waitFor();
  assert.equal(await maskingCookie(shared), "1");

  try {
    await editor.waitForFunction(
      (selector) => document.querySelectorAll(selector).length === 0,
      inputs,
      { timeout: 2_000 },
    );
  } catch {
    // Collected below so the delayed-response scenario runs in the same proof.
  }

  const remainingInputs = await editor.locator(inputs).count();
  const editorLabel = await buttonLabel(editor);
  await shared.close();

  // A fetcher Show response from one tab must not overwrite a newer direct Hide cookie from another.
  const delayed = await browser.newContext({ viewport: { width: 1000, height: 800 } });
  await delayed.addCookies([{ name: "masked", value: "1", url: base }]);
  const showing = await delayed.newPage();
  await showing.goto(`${base}${path}`, { waitUntil: "networkidle" });

  const showCaptured = deferred();
  const showRelease = deferred();
  let showSetCookie = "unknown";

  await showing.route("**/masking.data*", async (route) => {
    showCaptured.resolve();
    await waitForBarrier(showRelease, "the delayed Show request release");
    await route.continue();
  });

  await showing
    .getByRole("banner")
    .getByRole("button", { name: "Show amounts", exact: true })
    .click();
  await waitForBarrier(showCaptured, "the delayed Show action response");
  assert.equal(await maskingCookie(delayed), "0");

  const hiding = await delayed.newPage();
  await hiding.goto(`${base}${path}`, { waitUntil: "networkidle" });
  assert.equal(await hiding.locator(inputs).count(), 2);
  await hiding
    .getByRole("banner")
    .getByRole("button", { name: "Hide amounts", exact: true })
    .click();
  await hiding
    .getByRole("banner")
    .getByRole("button", { name: "Show amounts", exact: true })
    .waitFor();
  assert.equal(await maskingCookie(delayed), "1");

  const showActionFinished = showing.waitForResponse(
    (response) => response.url().includes("/masking.data") && response.request().method() === "POST",
  );
  const showLoaderFinished = showing.waitForResponse((response) =>
    response.url().includes("/holdings.data"),
  );
  showRelease.resolve();
  const showResponse = await showActionFinished;
  const showHeaders = await showResponse.allHeaders();
  showSetCookie = showHeaders["set-cookie"] === undefined ? "absent" : "present";
  await showLoaderFinished;
  await showing.waitForLoadState("networkidle");
  await showing.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  const finalCookie = await maskingCookie(delayed);
  const reopenedInputs = await showing.locator(inputs).count();
  await delayed.close();

  // Display settings is another cookie writer. An older policy save must not clear a newer Hide.
  await pool.query("update app_setting set masking_policy = 'masked'");
  const settingsRace = await browser.newContext({ viewport: { width: 1000, height: 800 } });
  await settingsRace.addCookies([{ name: "masked", value: "0", url: base }]);
  const settings = await settingsRace.newPage();
  const settingsEditor = await settingsRace.newPage();
  await settings.goto(`${base}/settings/display`, { waitUntil: "networkidle" });
  await settingsEditor.goto(`${base}${path}`, { waitUntil: "networkidle" });
  assert.equal(await settingsEditor.locator(inputs).count(), 2);

  const settingsCaptured = deferred();
  const settingsRelease = deferred();
  await settings.route("**/settings/display.data*", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    settingsCaptured.resolve();
    await waitForBarrier(settingsRelease, "the delayed Display request release");
    await route.continue();
  });

  await settings.getByRole("radio", { name: /Showing amounts/ }).check();
  await settings.getByRole("button", { name: "Save", exact: true }).click();
  await waitForBarrier(settingsCaptured, "the delayed Display action request");

  await settingsEditor
    .getByRole("banner")
    .getByRole("button", { name: "Hide amounts", exact: true })
    .click();
  await settingsEditor
    .getByRole("banner")
    .getByRole("button", { name: "Show amounts", exact: true })
    .waitFor();
  assert.equal(await maskingCookie(settingsRace), "1");

  const settingsActionFinished = settings.waitForResponse(
    (response) =>
      response.url().includes("/settings/display.data") &&
      response.request().method() === "POST",
  );
  settingsRelease.resolve();
  const settingsResponse = await settingsActionFinished;
  const settingsHeaders = await settingsResponse.allHeaders();
  const settingsSetCookie =
    settingsHeaders["set-cookie"] === undefined ? "absent" : "present";
  await settings.waitForLoadState("networkidle");
  const settingsFinalCookie = await maskingCookie(settingsRace);
  await settingsEditor.reload({ waitUntil: "networkidle" });
  const settingsReopenedInputs = await settingsEditor.locator(inputs).count();
  await settingsRace.close();
  await pool.query("update app_setting set masking_policy = 'masked'");

  // `/unlock` is a real shell state with no Amount or MaskingToggle subscribers. Preserve this
  // tab's client module across the route transition, Hide elsewhere, then remount the exact
  // Overview data behind a root loader that now says masked.
  await pool.query("delete from passkey where credential_id = $1", [lifecyclePasskey]);
  await pool.query(
    `insert into passkey
       (credential_id, public_key, counter, transports, backup_eligible, label, bootstrap)
     values ($1, $2, 0, null, false, 'QA lifecycle', false)`,
    [lifecyclePasskey, Buffer.from([1])],
  );
  await pool.query(
    `insert into unlock_grant (id, passkey_id, expires_at)
     values ($1, $2, now() + interval '1 hour')`,
    [lifecycleGrant, lifecyclePasskey],
  );

  const lifecycle = await browser.newContext({ viewport: { width: 1000, height: 800 } });
  await lifecycle.addCookies([
    { name: "masked", value: "0", url: base },
    {
      name: "__Host-unlock_grant",
      value: lifecycleGrant,
      domain: new URL(base).hostname,
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  const remounting = await lifecycle.newPage();
  const lifecycleControl = await lifecycle.newPage();
  await remounting.goto(base, { waitUntil: "networkidle" });
  await lifecycleControl.goto(base, { waitUntil: "networkidle" });
  const exactBeforeUnmount = await remounting.locator(".account-amount").first().textContent();
  assert.ok(exactBeforeUnmount?.includes("$"));
  assert.ok(!exactBeforeUnmount?.includes("••••••"));

  await pool.query("delete from unlock_grant where id = $1", [lifecycleGrant]);
  await remounting.evaluate(() => {
    history.pushState({}, "", "/unlock");
    dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
  });
  await remounting.getByRole("heading", { name: "Locked", exact: true }).waitFor();
  assert.equal(await remounting.locator(".masking-toggle").count(), 0);

  await pool.query(
    `insert into unlock_grant (id, passkey_id, expires_at)
     values ($1, $2, now() + interval '1 hour')`,
    [lifecycleGrant, lifecyclePasskey],
  );
  await lifecycleControl.getByRole("button", { name: "Hide amounts", exact: true }).first().click();
  await lifecycleControl.getByRole("button", { name: "Show amounts", exact: true }).first().waitFor();
  assert.equal(await maskingCookie(lifecycle), "1");

  await remounting.evaluate((exact) => {
    window.__maskingExactObserved = false;
    new MutationObserver(() => {
      if (document.body.innerText.includes(exact)) window.__maskingExactObserved = true;
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
  }, exactBeforeUnmount);
  await remounting.goBack({ waitUntil: "networkidle" });
  await remounting.locator(".account-amount").first().waitFor();
  const amountAfterRemount = await remounting.locator(".account-amount").first().textContent();
  const exactPaintedAfterRemount = await remounting.evaluate(
    () => window.__maskingExactObserved,
  );
  const labelAfterRemount = await buttonLabel(remounting);
  await lifecycle.close();
  await pool.query("delete from passkey where credential_id = $1", [lifecyclePasskey]);

  console.log(
    `Cross-tab Hide: remaining inputs ${remainingInputs}; editor control ${JSON.stringify(editorLabel)}.`,
  );
  console.log(
    `Display success gate: refused cookie ${JSON.stringify(refusedSettingsCookie)}; successful reset ${JSON.stringify(successfulSettingsCookie)}.`,
  );
  console.log(
    `Sibling Show: gated inputs ${siblingShowInputs}, control ${JSON.stringify(siblingShowLabel)}; local Show inputs ${localShowInputs}.`,
  );
  console.log(
    `Delayed Show response: Set-Cookie ${showSetCookie}; final masked cookie ${JSON.stringify(finalCookie)}.`,
  );
  console.log(
    `Delayed Display response: Set-Cookie ${settingsSetCookie}; final masked cookie ${JSON.stringify(settingsFinalCookie)}; reloaded inputs ${settingsReopenedInputs}.`,
  );
  console.log(
    `Subscriber remount: exact before ${JSON.stringify(exactBeforeUnmount)}; after ${JSON.stringify(amountAfterRemount)}; exact mutation ${exactPaintedAfterRemount}; control ${JSON.stringify(labelAfterRemount)}.`,
  );

  assert.equal(remainingInputs, 0, "Hide in one tab must remove exact inputs from every open tab.");
  assert.equal(refusedSettingsCookie, "1", "A refused Display save must preserve the Hide cookie.");
  assert.equal(
    successfulSettingsCookie,
    undefined,
    "A successful Display save with no newer intent must reset the browser override.",
  );
  assert.equal(siblingShowInputs, 0, "Show in another tab must not reveal a redacted projection.");
  assert.equal(siblingShowLabel, "Show amounts", "The redacted tab must retain its local Show gate.");
  assert.equal(localShowInputs, 2, "Show in that tab must fetch and mount the exact editor inputs.");
  assert.equal(editorLabel, "Show amounts", "Every open tab must reflect the shared Hide cookie.");
  assert.equal(
    finalCookie,
    "1",
    "An older fetcher Show response must not overwrite a newer Hide from another tab.",
  );
  assert.equal(reopenedInputs, 0, "An older Show response must not remount exact inputs.");
  assert.equal(
    settingsFinalCookie,
    "1",
    "An older Display save must not clear a newer Hide from another tab.",
  );
  assert.equal(
    settingsReopenedInputs,
    0,
    "Reloading after an older Display save must remain masked.",
  );
  assert.ok(
    amountAfterRemount?.includes("••••••"),
    "A remounted Amount must adopt a Hide that arrived while the tab had no subscribers.",
  );
  assert.equal(exactPaintedAfterRemount, false, "The remount must not paint the cached exact value.");
  assert.equal(labelAfterRemount, "Show amounts");
  console.log("PASS: cross-tab Hide wins immediately and remains ahead of both older cookie writers.");
} finally {
  await pool.query("update app_setting set masking_policy = 'masked'").catch(() => undefined);
  await pool
    .query("delete from passkey where credential_id = $1", [lifecyclePasskey])
    .catch(() => undefined);
  await pool.end();
  await browser.close();
}
