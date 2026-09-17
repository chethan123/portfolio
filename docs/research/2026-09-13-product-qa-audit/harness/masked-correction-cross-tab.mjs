/**
 * Cross-tab browser regressions for QA-23's masking cookie.
 *
 * Requires a running production build and the same seeded fixture as
 * masked-correction-toggle-race.mjs. No financial value crosses the tab notification channel.
 * Use a loopback PORTFOLIO_URL: the `/unlock` lifecycle scenario below relies on Chromium's
 * secure-cookie loopback exemption. Run against a disposable fixture: the lock is instance-wide
 * while that scenario runs.
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

async function waitForMaskingCookie(context, predicate, label) {
  const deadline = Date.now() + 2_000;
  let cookie;
  do {
    cookie = (await context.cookies(base)).find(({ name }) => name === "masked");
    if (predicate(cookie)) return cookie;
    await new Promise((resolve) => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${label}; last cookie ${JSON.stringify(cookie)}.`);
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
  assert.equal(refusedSettingsCookie, "1", "A refused Display save must preserve the Hide cookie.");

  await settingsFlowPage.getByRole("radio", { name: /Showing amounts/ }).check();
  await settingsFlowPage.getByRole("button", { name: "Save", exact: true }).click();
  await settingsFlowPage.waitForFunction(() => !document.cookie.includes("masked="));
  const successfulSettingsCookie = await maskingCookie(settingsFlow);
  assert.equal(
    successfulSettingsCookie,
    undefined,
    "A successful Display save with no newer intent must reset the browser override.",
  );
  await settingsFlow.close();
  await pool.query("update app_setting set masking_policy = 'masked'");

  // A tab can submit with an old as-last-left policy after another tab saved a fixed policy. Its
  // optimistic Show remains session-only once the toggle revalidation returns the fresh policy.
  await pool.query("update app_setting set masking_policy = 'as_last_left'");
  const lifetime = await browser.newContext({ viewport: { width: 1000, height: 800 } });
  await lifetime.addCookies([{ name: "masked", value: "1", url: base }]);
  const stalePolicy = await lifetime.newPage();
  const policyEditor = await lifetime.newPage();
  await stalePolicy.goto(`${base}${path}`, { waitUntil: "networkidle" });
  await policyEditor.goto(`${base}/settings/display`, { waitUntil: "networkidle" });
  await stalePolicy.getByRole("button", { name: "Show amounts", exact: true }).first().click();
  await stalePolicy.locator(inputs).first().waitFor();
  await stalePolicy.waitForLoadState("networkidle");
  const rememberedShow = (await lifetime.cookies(base)).find(({ name }) => name === "masked");
  assert.equal(rememberedShow?.value, "0");
  assert.ok(
    (rememberedShow?.expires ?? -1) > Date.now() / 1000,
    "An as-last-left Show must become persistent after fresh policy revalidation.",
  );
  const rememberedHideAction = stalePolicy.waitForResponse(
    (response) =>
      response.url().includes("/masking.data") && response.request().method() === "POST",
  );
  const rememberedHideLoader = stalePolicy.waitForResponse((response) =>
    response.url().includes("/holdings.data"),
  );
  await stalePolicy.getByRole("button", { name: "Hide amounts", exact: true }).first().click();
  await stalePolicy.locator(inputs).first().waitFor({ state: "detached" });
  await Promise.all([rememberedHideAction, rememberedHideLoader]);
  await stalePolicy.waitForLoadState("networkidle");
  const rememberedHide = await waitForMaskingCookie(
    lifetime,
    (cookie) => cookie?.value === "1" && cookie.expires > Date.now() / 1000,
    "the as-last-left Hide lifetime repair",
  );
  assert.equal(rememberedHide?.value, "1");
  assert.ok(
    (rememberedHide?.expires ?? -1) > Date.now() / 1000,
    "An as-last-left Hide must become persistent after fresh policy revalidation.",
  );
  const fixedPolicySaved = policyEditor.waitForResponse(
    (response) =>
      response.url().includes("/settings/display.data") &&
      response.request().method() === "POST",
  );
  await policyEditor.getByRole("radio", { name: /Masked —/ }).check();
  await policyEditor.getByRole("button", { name: "Save", exact: true }).click();
  await fixedPolicySaved;
  await policyEditor.waitForLoadState("networkidle");
  await stalePolicy.getByRole("button", { name: "Show amounts", exact: true }).first().click();
  await stalePolicy.locator(inputs).first().waitFor();
  await stalePolicy.waitForLoadState("networkidle");
  const reconciledCookie = (await lifetime.cookies(base)).find(({ name }) => name === "masked");
  assert.equal(reconciledCookie?.value, "0");
  assert.equal(
    reconciledCookie?.expires,
    -1,
    "A stale tab's Show must adopt the fresh fixed policy's session lifetime.",
  );
  await lifetime.close();
  await pool.query("update app_setting set masking_policy = 'masked'");

  // A failed enhanced action provides no fresh policy data. React Router currently remounts the
  // root error subtree; the identity guard independently keeps the staged Show session-scoped if
  // that lifecycle changes. Normal completion above remains the positive persistent-lifetime case.
  const failedToggleLifetimes = [];
  for (const failureMode of ["network", "http-500"]) {
    await pool.query("update app_setting set masking_policy = 'as_last_left'");
    const failedToggle = await browser.newContext({ viewport: { width: 1000, height: 800 } });
    await failedToggle.addCookies([{ name: "masked", value: "1", url: base }]);
    const failedTogglePage = await failedToggle.newPage();
    await failedTogglePage.goto(`${base}${path}`, { waitUntil: "networkidle" });
    await pool.query("update app_setting set masking_policy = 'masked'");

    await failedTogglePage.route("**/masking.data*", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      if (failureMode === "network") await route.abort("failed");
      else await route.fulfill({ status: 500, contentType: "text/plain", body: "failed" });
    });
    const actionFinished =
      failureMode === "network"
        ? failedTogglePage.waitForEvent("requestfailed", (request) =>
            request.url().includes("/masking.data"),
          )
        : failedTogglePage.waitForResponse(
            (response) =>
              response.url().includes("/masking.data") && response.status() === 500,
          );
    await failedTogglePage
      .getByRole("button", { name: "Show amounts", exact: true })
      .first()
      .click();
    await actionFinished;
    await failedTogglePage.evaluate(
      () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
    );

    const failedCookie = (await failedToggle.cookies(base)).find(({ name }) => name === "masked");
    assert.equal(failedCookie?.value, "0", `A ${failureMode} failure must retain the staged Show.`);
    assert.equal(
      failedCookie?.expires,
      -1,
      `A ${failureMode} failure must not promote Show with stale as-last-left policy data.`,
    );
    failedToggleLifetimes.push(`${failureMode}:${failedCookie.expires}`);
    await failedToggle.close();
  }
  await pool.query("update app_setting set masking_policy = 'masked'");

  // The policy bridge has one revalidation to cover and never receives the saved policy's lifetime.
  await pool.query("update app_setting set masking_policy = 'unmasked'");
  const bridge = await browser.newContext({ viewport: { width: 1000, height: 800 } });
  await bridge.addCookies([{ name: "masked", value: "0", url: base }]);
  const bridgePage = await bridge.newPage();
  await bridgePage.goto(`${base}/settings/display`, { waitUntil: "networkidle" });
  const bridgeCaptured = deferred();
  const bridgeRelease = deferred();
  let displayGets = 0;
  await bridgePage.route("**/settings/display.data*", async (route) => {
    if (route.request().method() === "GET" && ++displayGets === 2) {
      bridgeCaptured.resolve();
      await waitForBarrier(bridgeRelease, "the Settings bridge revalidation release");
    }
    await route.continue();
  });
  await bridgePage.getByRole("radio", { name: /However it was last left/ }).check();
  await bridgePage.getByRole("button", { name: "Save", exact: true }).click();
  await waitForBarrier(bridgeCaptured, "the Settings bridge revalidation");
  const bridgeCookie = (await bridge.cookies(base)).find(({ name }) => name === "masked");
  assert.equal(bridgeCookie?.value, "1");
  assert.equal(bridgeCookie?.expires, -1, "The temporary Settings bridge must be session-only.");
  bridgeRelease.resolve();
  await bridgePage.waitForLoadState("networkidle");
  const clearedBridge = await waitForMaskingCookie(
    bridge,
    (cookie) => cookie === undefined,
    "the Settings bridge clear",
  );
  assert.equal(clearedBridge, undefined, "The Settings bridge must clear after revalidation.");
  await bridge.close();
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
  await stayGated.waitForLoadState("networkidle");
  // Passive Show intentionally emits no sibling request; a bounded settle plus two paint frames is
  // the observable barrier before proving that no DOM update arrived.
  await stayGated.waitForTimeout(250);
  await stayGated.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
  );
  const siblingShowInputs = await stayGated.locator(inputs).count();
  const siblingShowLabel = await buttonLabel(stayGated);
  assert.equal(siblingShowInputs, 0, "Show in another tab must not reveal a redacted projection.");
  assert.equal(siblingShowLabel, "Show amounts", "The redacted tab must retain its local Show gate.");
  await stayGated.getByRole("button", { name: "Show amounts", exact: true }).first().click();
  await stayGated.locator(inputs).first().waitFor();
  const localShowInputs = await stayGated.locator(inputs).count();
  assert.equal(localShowInputs, 2, "Show in that tab must fetch and mount the exact editor inputs.");
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
  assert.equal(remainingInputs, 0, "Hide in one tab must remove exact inputs from every open tab.");
  assert.equal(editorLabel, "Show amounts", "Every open tab must reflect the shared Hide cookie.");
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
  assert.equal(showSetCookie, "absent", "An enhanced toggle response must not set a cookie.");
  await showLoaderFinished;
  await showing.waitForLoadState("networkidle");
  await showing.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  const finalCookie = await maskingCookie(delayed);
  const reopenedInputs = await showing.locator(inputs).count();
  assert.equal(
    finalCookie,
    "1",
    "An older fetcher Show response must not overwrite a newer Hide from another tab.",
  );
  assert.equal(reopenedInputs, 0, "An older Show response must not remount exact inputs.");
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
  assert.equal(settingsSetCookie, "absent", "An enhanced Display response must not set a cookie.");
  await settings.waitForLoadState("networkidle");
  const settingsFinalCookie = await maskingCookie(settingsRace);
  await settingsEditor.reload({ waitUntil: "networkidle" });
  const settingsReopenedInputs = await settingsEditor.locator(inputs).count();
  assert.equal(
    settingsFinalCookie,
    "1",
    "An older Display save must not clear a newer Hide from another tab.",
  );
  assert.equal(settingsReopenedInputs, 0, "Reloading after an older Display save must remain masked.");
  await settingsRace.close();
  await pool.query("update app_setting set masking_policy = 'masked'");

  // If storage cannot carry an ordering token, a successful save preserves the existing Hide.
  const unavailable = await browser.newContext({ viewport: { width: 1000, height: 800 } });
  await unavailable.addCookies([{ name: "masked", value: "1", url: base }]);
  await unavailable.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      get() {
        throw new DOMException("Disabled", "SecurityError");
      },
    });
  });
  const unavailablePage = await unavailable.newPage();
  await unavailablePage.goto(`${base}/settings/display`, { waitUntil: "networkidle" });
  const unavailableResponse = unavailablePage.waitForResponse(
    (response) =>
      response.url().includes("/settings/display.data") &&
      response.request().method() === "POST",
  );
  await unavailablePage.getByRole("radio", { name: /Showing amounts/ }).check();
  await unavailablePage.getByRole("button", { name: "Save", exact: true }).click();
  const savedWithoutStorage = await unavailableResponse;
  assert.ok(savedWithoutStorage.ok(), "The unavailable-storage Display save must succeed.");
  await unavailablePage.waitForLoadState("networkidle");
  const savedPolicyWithoutStorage = await pool
    .query("select masking_policy from app_setting")
    .then(({ rows }) => rows[0]?.masking_policy);
  assert.equal(
    savedPolicyWithoutStorage,
    "unmasked",
    "The unavailable-storage scenario must exercise a committed policy change.",
  );
  assert.equal(await maskingCookie(unavailable), "1");
  await unavailablePage.goto(`${base}${path}`, { waitUntil: "networkidle" });
  assert.equal(await unavailablePage.locator(inputs).count(), 0);
  await unavailable.close();
  await pool.query("update app_setting set masking_policy = 'masked'");

  // A Show followed by Hide has the bridge's original value again; the intent token distinguishes it.
  const aba = await browser.newContext({ viewport: { width: 1000, height: 800 } });
  await aba.addCookies([{ name: "masked", value: "1", url: base }]);
  const abaSettings = await aba.newPage();
  const abaEditor = await aba.newPage();
  await abaSettings.goto(`${base}/settings/display`, { waitUntil: "networkidle" });
  await abaEditor.goto(`${base}${path}`, { waitUntil: "networkidle" });
  const abaCaptured = deferred();
  const abaRelease = deferred();
  await abaSettings.route("**/settings/display.data*", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    abaCaptured.resolve();
    await waitForBarrier(abaRelease, "the ABA Display request release");
    await route.continue();
  });
  await abaSettings.getByRole("radio", { name: /Showing amounts/ }).check();
  await abaSettings.getByRole("button", { name: "Save", exact: true }).click();
  await waitForBarrier(abaCaptured, "the delayed ABA Display action request");
  await abaEditor.getByRole("button", { name: "Show amounts", exact: true }).first().click();
  await abaEditor.locator(inputs).first().waitFor();
  await abaEditor.getByRole("button", { name: "Hide amounts", exact: true }).first().click();
  await abaEditor.locator(inputs).first().waitFor({ state: "detached" });
  const abaFinished = abaSettings.waitForResponse(
    (response) =>
      response.url().includes("/settings/display.data") &&
      response.request().method() === "POST",
  );
  abaRelease.resolve();
  await abaFinished;
  await abaSettings.waitForLoadState("networkidle");
  assert.equal(await maskingCookie(aba), "1");
  await abaEditor.reload({ waitUntil: "networkidle" });
  assert.equal(await abaEditor.locator(inputs).count(), 0);
  await aba.close();
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
  assert.ok(
    amountAfterRemount?.includes("••••••"),
    "A remounted Amount must adopt a Hide that arrived while the tab had no subscribers.",
  );
  assert.equal(exactPaintedAfterRemount, false, "The remount must not paint the cached exact value.");
  assert.equal(labelAfterRemount, "Show amounts");
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
  console.log(`Failed toggle lifetimes: ${failedToggleLifetimes.join(", ")}.`);
  console.log(
    `Delayed Show response: Set-Cookie ${showSetCookie}; final masked cookie ${JSON.stringify(finalCookie)}.`,
  );
  console.log(
    `Delayed Display response: Set-Cookie ${settingsSetCookie}; final masked cookie ${JSON.stringify(settingsFinalCookie)}; reloaded inputs ${settingsReopenedInputs}.`,
  );
  console.log(
    `Subscriber remount: exact before ${JSON.stringify(exactBeforeUnmount)}; after ${JSON.stringify(amountAfterRemount)}; exact mutation ${exactPaintedAfterRemount}; control ${JSON.stringify(labelAfterRemount)}.`,
  );

  console.log("PASS: cross-tab Hide wins immediately and remains ahead of both older cookie writers.");
} finally {
  let cleanupFailed = false;
  await pool.query("update app_setting set masking_policy = 'masked'").catch((error) => {
    cleanupFailed = true;
    console.error("Failed to restore the masking policy after the cross-tab harness:", error);
  });
  await pool
    .query("delete from passkey where credential_id = $1", [lifecyclePasskey])
    .catch((error) => {
      cleanupFailed = true;
      console.error("Failed to remove the cross-tab harness passkey:", error);
    });
  await pool.end();
  await browser.close();
  if (cleanupFailed) process.exitCode = 1;
}
