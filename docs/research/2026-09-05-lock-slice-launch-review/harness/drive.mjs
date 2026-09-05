// The script the launch review's §8 was produced with (docs/research/2026-09-05-lock-slice-launch-review.md).
// Evidence, never a dependency: nothing in the application runs this.
//
// It drives headless Chromium (Playwright 1.62, CDP virtual authenticator) against a dev server on
// http://localhost:5173 backed by a migrated `portfolio_dev` database on 127.0.0.1:55432, and writes
// every observation to observations.log beside it (the copy here is the run this review cites).
// Before re-running: point SCRATCH at a writable directory, EXEC_PATH at a Chromium, and start the
// server with DATABASE_URL, PUBLIC_ORIGIN=http://localhost:5173 and AUTH_GATE=none. Steps S12-S14
// never ran in the cited run: Chromium's virtual-authenticator environment allows one *internal*
// authenticator per context and S11's second enrolment tried to add another; see §8 for what
// covers those steps instead.
//
// Verification driver for the WebAuthn passkey lock feature (S1-S15).
// Run with: node drive.mjs   (cwd must be the worktree so `playwright` resolves)
import { chromium } from "playwright";
import { execSync } from "node:child_process";
import fs from "node:fs";

const BASE = "http://localhost:5173";
const SCRATCH = "/tmp/claude-0/-home-user-portfolio/9533d9ca-4f2f-5142-8d39-930eb1463b54/scratchpad/live";
const EXEC_PATH = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const LOGFILE = `${SCRATCH}/observations.log`;

fs.writeFileSync(LOGFILE, `Run started ${new Date().toISOString()}\n`);

function log(label, obj) {
  let body = "";
  if (obj !== undefined) {
    try {
      body = typeof obj === "string" ? obj : JSON.stringify(obj, null, 2);
    } catch {
      body = String(obj);
    }
  }
  const line = `\n=== ${label} ===\n${body}`;
  console.log(line);
  fs.appendFileSync(LOGFILE, line + "\n");
}

function psql(sql) {
  const escaped = sql.replace(/'/g, "'\\''");
  const cmd = `PGPASSWORD=portfolio psql -h 127.0.0.1 -p 55432 -U portfolio -d portfolio_dev -t -A -c '${escaped}'`;
  try {
    return execSync(cmd, { encoding: "utf8" }).trim();
  } catch (e) {
    return `ERROR: ${e.message}`;
  }
}

function counts() {
  return {
    passkey: psql("select count(*) from passkey;"),
    unlock_grant: psql("select count(*) from unlock_grant;"),
  };
}

async function shot(page, name) {
  try {
    await page.screenshot({ path: `${SCRATCH}/${name}.png` });
    log(`screenshot`, `${name}.png`);
  } catch (e) {
    log(`screenshot FAILED`, `${name}.png :: ${e.message}`);
  }
}

async function addAuthenticator(page, label) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  log(`authenticator added (${label})`, { authenticatorId });
  return { cdp, authenticatorId };
}

async function copyCredential(fromAuth, toAuth) {
  const { credentials } = await fromAuth.cdp.send("WebAuthn.getCredentials", {
    authenticatorId: fromAuth.authenticatorId,
  });
  for (const credential of credentials) {
    await toAuth.cdp.send("WebAuthn.addCredential", {
      authenticatorId: toAuth.authenticatorId,
      credential,
    });
  }
  return credentials;
}

function cookieSummary(cookies, name = "__Host-unlock_grant") {
  const c = cookies.find((x) => x.name === name);
  if (!c) return { present: false };
  return {
    present: true,
    name: c.name,
    valueLength: c.value.length,
    httpOnly: c.httpOnly,
    secure: c.secure,
    sameSite: c.sameSite,
    path: c.path,
    expires: c.expires,
  };
}

async function text(locatorOrPage, selector) {
  try {
    const loc = selector ? locatorOrPage.locator(selector) : locatorOrPage;
    return (await loc.first().textContent())?.trim();
  } catch (e) {
    return `ERROR: ${e.message}`;
  }
}

// ---------------------------------------------------------------------------
// Enrolment flow helper (mirrors app/routes/settings/passkeys.tsx UI)
// ---------------------------------------------------------------------------
async function enrolFirstPasskey(page, label) {
  await page.goto(`${BASE}/settings/passkeys`, { waitUntil: "networkidle" });
  const labelInput = page.locator("#passkey-label");
  const checkbox = page.locator('input[type="checkbox"]').first();
  const continueBtn = page.getByRole("button", { name: "Continue" });

  const states = {};
  states.initialContinueDisabled = await continueBtn.isDisabled();

  await labelInput.fill(label);
  states.afterLabelOnlyContinueDisabled = await continueBtn.isDisabled();

  // undo label to test tick-only state cleanly
  await labelInput.fill("");
  states.labelClearedContinueDisabled = await continueBtn.isDisabled();
  await checkbox.check();
  states.afterTickOnlyContinueDisabled = await continueBtn.isDisabled();

  await labelInput.fill(label);
  states.afterBothContinueDisabled = await continueBtn.isDisabled();

  log("S1/S2 button-state matrix", states);

  await continueBtn.click();
  await page.waitForTimeout(500);

  const createBtn = page.getByRole("button", { name: `Create the passkey named "${label}"` });
  const createBtnText = await createBtn.textContent().catch(() => null);
  const labelDisabledNow = await labelInput.isDisabled().catch(() => null);
  log("S2 after Continue press", { createBtnText, labelInputDisabled: labelDisabledNow });

  await createBtn.click();
  await page.waitForTimeout(800);

  return states;
}

async function enrolSubsequentPasskey(page, label) {
  await page.goto(`${BASE}/settings/passkeys`, { waitUntil: "networkidle" });
  await page.locator("#passkey-label").fill(label);
  const confirmBtn = page.getByRole("button", { name: "Confirm with an existing passkey" });
  const noteAbove = await text(page.locator(".field-note").filter({ hasText: "confirm it is you" }));
  log("S11 note above confirm button", noteAbove);
  await confirmBtn.click();
  await page.waitForTimeout(700);
  const createBtn = page.getByRole("button", { name: `Create the passkey named "${label}"` });
  const nextBtnText = await createBtn.textContent().catch((e) => `ERROR: ${e.message}`);
  log("S11 next button text after confirm", nextBtnText);
  await createBtn.click();
  await page.waitForTimeout(800);
}

// ===========================================================================
async function main() {
  const browser = await chromium.launch({ headless: true, executablePath: EXEC_PATH });

  const lockNowNetwork = [];
  function wireLockNowCapture(page, tag) {
    page.on("request", (req) => {
      if (req.url().includes("/lock-now")) {
        lockNowNetwork.push({ tag, type: "request", method: req.method(), url: req.url() });
      }
    });
    page.on("response", (res) => {
      if (res.url().includes("/lock-now")) {
        lockNowNetwork.push({ tag, type: "response", status: res.status(), url: res.url() });
      }
    });
  }

  // -------------------------------------------------------------------------
  // S1
  // -------------------------------------------------------------------------
  log("S1 START");
  const ctxA = await browser.newContext();
  const pageA = await ctxA.newPage();
  wireLockNowCapture(pageA, "A");

  let resp = await pageA.goto(`${BASE}/`, { waitUntil: "networkidle" });
  log("S1 GET /", { status: resp.status(), url: pageA.url() });
  await shot(pageA, "s1-open-overview");

  resp = await pageA.goto(`${BASE}/settings/passkeys`, { waitUntil: "networkidle" });
  log("S1 GET /settings/passkeys", { status: resp.status(), url: pageA.url() });

  const emptyNote = await text(pageA.locator(".empty-note"));
  const panelHeading = await text(pageA.locator(".panel-title"));
  const labelInputEl = pageA.locator("#passkey-label");
  const maxLength = await labelInputEl.getAttribute("maxlength");
  const labelLabelText = await text(pageA.locator('label[for="passkey-label"]'));
  const strongWarning = await text(pageA.locator("strong"));
  const continueBtn = pageA.getByRole("button", { name: "Continue" });

  const initialDisabled = await continueBtn.isDisabled();
  await labelInputEl.fill("temp label");
  const afterLabelOnly = await continueBtn.isDisabled();
  await labelInputEl.fill("");
  const checkbox = pageA.locator('input[type="checkbox"]').first();
  await checkbox.check();
  const afterTickOnly = await continueBtn.isDisabled();
  await labelInputEl.fill("temp label");
  const afterBoth = await continueBtn.isDisabled();
  // reset for the real S2 flow
  await checkbox.uncheck();
  await labelInputEl.fill("");

  const lockNowPresent = (await pageA.locator("text=Lock now").count()) > 0;
  const maskingLabel = await text(pageA.locator(".app-rail-masking, [class*=masking]").first());

  log("S1 verbatim", {
    emptyNote,
    panelHeading,
    maxLength,
    labelLabelText,
    strongWarning,
    continueButton: { initialDisabled, afterLabelOnly, afterTickOnly, afterBoth },
    lockNowControlPresent: lockNowPresent,
    maskingToggleLabel: maskingLabel,
  });
  await shot(pageA, "s1-settings-passkeys-empty");

  // -------------------------------------------------------------------------
  // S2
  // -------------------------------------------------------------------------
  log("S2 START");
  const authA = await addAuthenticator(pageA, "A1");
  await enrolFirstPasskey(pageA, "Alex's phone");
  await pageA.waitForTimeout(500);

  const rowText = await text(pageA.locator(".record-list li").first());
  const rowAboveForm = await pageA.evaluate(() => {
    const list = document.querySelector(".record-list");
    const form = document.querySelector(".panel-form");
    if (!list || !form) return null;
    const listRect = list.getBoundingClientRect();
    const formRect = form.getBoundingClientRect();
    return listRect.top < formRect.top;
  });
  const oneNudgeText = await text(pageA.locator(".field-note").filter({ hasText: "one passkey" }));
  const cookiesA_afterEnrol = await ctxA.cookies();
  log("S2 after enrolment", {
    rowText,
    rowAboveForm,
    oneNudgeText,
    cookie: cookieSummary(cookiesA_afterEnrol),
    counts: counts(),
  });

  const lockNowNowPresent = (await pageA.locator("text=Lock now").count()) > 0;
  log("S2 Lock now control appears?", { present: lockNowNowPresent });
  await pageA.setViewportSize({ width: 1280, height: 900 });
  await shot(pageA, "s2-wide-1280");
  await pageA.setViewportSize({ width: 400, height: 800 });
  await shot(pageA, "s2-narrow-400");
  await pageA.setViewportSize({ width: 1280, height: 900 });

  // -------------------------------------------------------------------------
  // S3
  // -------------------------------------------------------------------------
  log("S3 START");
  const pageA2 = await ctxA.newPage();
  const respA2 = await pageA2.goto(`${BASE}/holdings`, { waitUntil: "networkidle" });
  log("S3 sibling tab GET /holdings", { status: respA2.status(), url: pageA2.url() });
  await pageA2.close();

  // -------------------------------------------------------------------------
  // S4
  // -------------------------------------------------------------------------
  log("S4 START");
  const ctxB = await browser.newContext();
  const pageB = await ctxB.newPage();
  wireLockNowCapture(pageB, "B");

  const respB = await pageB.goto(`${BASE}/`, { waitUntil: "networkidle" });
  log("S4 fresh context B GET /", { status: respB.status(), finalUrl: pageB.url() });

  const unlockTitle = await text(pageB.locator(".page-title"));
  const unlockSubtitle = await text(pageB.locator(".page-subtitle"));
  const unlockBtnText = await text(pageB.getByRole("button", { name: "Unlock" }));
  log("S4 unlock screen verbatim", { unlockTitle, unlockSubtitle, unlockBtnText });
  await shot(pageB, "s4-unlock-screen");

  const html = await pageB.content();
  const assetMatch = html.match(/\/assets\/[^"'>\s]+/);
  log("S4 asset url discovered in page source", assetMatch ? assetMatch[0] : null);

  async function probe(pathAndQuery, opts = {}) {
    const url = `${BASE}${pathAndQuery}`;
    try {
      const r = await ctxB.request.fetch(url, { method: opts.method ?? "GET", maxRedirects: 0, ...opts });
      let bodySize = null;
      try {
        bodySize = (await r.body()).length;
      } catch {}
      const headers = r.headersArray();
      const setCookie = headers.filter((h) => h.name.toLowerCase() === "set-cookie");
      const location = headers.find((h) => h.name.toLowerCase() === "location");
      return {
        path: pathAndQuery,
        method: opts.method ?? "GET",
        status: r.status(),
        location: location?.value ?? null,
        setCookiePresent: setCookie.length > 0,
        setCookie: setCookie.map((h) => h.value),
        bodySize,
      };
    } catch (e) {
      return { path: pathAndQuery, method: opts.method ?? "GET", error: e.message };
    }
  }

  const probePaths = [
    "/holdings",
    "/holdings.data",
    "/_root.data",
    "/.data",
    "/__manifest?p=/holdings&version=x",
    "/unlock",
    "/Unlock",
    "/unlock/",
    "/UNLOCK//",
    "/unlock%2F..%2Fholdings",
    "/healthz",
    "/settings/passkeys",
  ];
  const probeResults = [];
  for (const p of probePaths) {
    probeResults.push(await probe(p));
  }
  probeResults.push(await probe("/lock-now", { method: "GET" }));
  probeResults.push(await probe("/lock-now", { method: "POST" }));
  if (assetMatch) probeResults.push(await probe(assetMatch[0]));
  probeResults.push(await probe("/unlock?redirectTo=//evil.test"));
  probeResults.push(await probe("/unlock?redirectTo=/\\evil.test"));
  log("S4 probe results", probeResults);

  // -------------------------------------------------------------------------
  // S5
  // -------------------------------------------------------------------------
  log("S5 START");
  const authB = await addAuthenticator(pageB, "B1");
  await copyCredential(authA, authB);
  log("S5 credential copied A1 -> B1", {});

  await pageB.goto(`${BASE}/unlock?redirectTo=%2F%2Fevil.test`, { waitUntil: "networkidle" });
  const unlockBtn = pageB.getByRole("button", { name: "Unlock" });
  await unlockBtn.click();
  await pageB.waitForURL(/.*/, { timeout: 5000 }).catch(() => {});
  await pageB.waitForTimeout(800);
  log("S5 unlock (redirectTo=//evil.test) final URL", pageB.url());
  await shot(pageB, "s5-after-unlock");

  const cookiesB = await ctxB.cookies();
  log("S5 cookie set in B, DB grant count", { cookie: cookieSummary(cookiesB), counts: counts() });

  await pageB.goto(`${BASE}/settings/passkeys`, { waitUntil: "networkidle" });
  const lastUsedRowB = await text(pageB.locator(".record-list li").first());
  log('S5 "Last used" row text in B', lastUsedRowB);

  // -------------------------------------------------------------------------
  // S6
  // -------------------------------------------------------------------------
  log("S6 START");
  const cookiesA_now = await ctxA.cookies();
  const grantA = cookiesA_now.find((c) => c.name === "__Host-unlock_grant");
  const ctxC = await browser.newContext();
  if (grantA) {
    // Note: the `url` form of addCookies fails for a `__Host-` prefixed name
    // via CDP's Storage.setCookies ("Invalid cookie fields") in this
    // Chromium build — confirmed empirically (cookie-test.mjs). domain+path
    // is what actually lands the cookie.
    await ctxC.addCookies([
      {
        name: "__Host-unlock_grant",
        value: grantA.value,
        domain: "localhost",
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
  }
  const pageC = await ctxC.newPage();
  wireLockNowCapture(pageC, "C");
  const respC = await pageC.goto(`${BASE}/`, { waitUntil: "networkidle" });
  log("S6 bearer test: context C with copied cookie GET /", { status: respC.status(), url: pageC.url() });
  await shot(pageC, "s6-bearer-copy");

  // -------------------------------------------------------------------------
  // S7
  // -------------------------------------------------------------------------
  log("S7 START");
  await pageA.goto(`${BASE}/`, { waitUntil: "networkidle" });
  const lockNowLocatorA = pageA.locator("text=Lock now").first();
  await lockNowLocatorA.click();
  await pageA.waitForTimeout(800);
  log("S7 after Lock now click, final URL", pageA.url());
  const lockNowCalls = lockNowNetwork.filter((e) => e.tag === "A");
  log("S7 /lock-now network (context A)", lockNowCalls);
  log("S7 DB grant count after lock now", counts());
  const cookiesA_afterLock = await ctxA.cookies();
  log("S7 A cookie after lock now", cookieSummary(cookiesA_afterLock));

  const respA_after = await pageA.goto(`${BASE}/`, { waitUntil: "networkidle" });
  log("S7 A GET / after lock now", { status: respA_after.status(), url: pageA.url() });

  const respC_after = await pageC.goto(`${BASE}/`, { waitUntil: "networkidle" });
  log("S7 C (copied A cookie) GET / after A locked", { status: respC_after.status(), url: pageC.url() });

  // -------------------------------------------------------------------------
  // S8
  // -------------------------------------------------------------------------
  log("S8 START");
  const pageB2 = await ctxB.newPage();
  await pageB2.addInitScript(() => {
    const realNow = Date.now.bind(Date);
    const realPerf = performance.now.bind(performance);
    window.__skew = 0;
    window.__vis = undefined;
    Date.now = () => realNow() + window.__skew;
    performance.now = () => realPerf() + window.__skew;
    Object.defineProperty(document, "visibilityState", {
      get: () => window.__vis ?? "visible",
      configurable: true,
    });
  });
  wireLockNowCapture(pageB2, "B2-reentry");
  const respB2 = await pageB2.goto(`${BASE}/`, { waitUntil: "networkidle" });
  log("S8 context B fresh tab with fake clock, GET /", { status: respB2.status(), url: pageB2.url() });

  async function dispatchVis(page, vis) {
    await page.evaluate((v) => {
      window.__vis = v;
      document.dispatchEvent(new Event("visibilitychange"));
    }, vis);
  }
  async function setSkew(page, ms) {
    await page.evaluate((v) => {
      window.__skew = v;
    }, ms);
  }
  async function bumpSkew(page, delta) {
    await page.evaluate((d) => {
      window.__skew += d;
    }, delta);
  }

  const before8a = lockNowNetwork.filter((e) => e.tag === "B2-reentry").length;
  await dispatchVis(pageB2, "hidden");
  await setSkew(pageB2, 30000);
  await dispatchVis(pageB2, "visible");
  await pageB2.waitForTimeout(700);
  const after8a = lockNowNetwork.filter((e) => e.tag === "B2-reentry").length;
  log("S8 cycle 1 (30s skew, under grace)", {
    lockNowRequestsSeen: after8a - before8a,
    counts: counts(),
    url: pageB2.url(),
  });

  const before8b = lockNowNetwork.filter((e) => e.tag === "B2-reentry").length;
  await dispatchVis(pageB2, "hidden");
  await bumpSkew(pageB2, 61000);
  await dispatchVis(pageB2, "visible");
  await pageB2.waitForTimeout(1500);
  const after8b = lockNowNetwork.filter((e) => e.tag === "B2-reentry").length;
  log("S8 cycle 2 (+61s skew, over grace)", {
    lockNowRequestsSeen: after8b - before8b,
    lockNowEvents: lockNowNetwork.filter((e) => e.tag === "B2-reentry").slice(before8b),
    counts: counts(),
    url: pageB2.url(),
  });
  await shot(pageB2, "s8-after-reentry-lock");

  // -------------------------------------------------------------------------
  // S9
  // -------------------------------------------------------------------------
  log("S9 START");
  psql("delete from passkey;");
  log("S9 deleted all passkeys", counts());

  const ctxD = await browser.newContext();
  const pageD1 = await ctxD.newPage();
  await pageD1.addInitScript(() => {
    const realNow = Date.now.bind(Date);
    const realPerf = performance.now.bind(performance);
    window.__skew = 0;
    window.__vis = undefined;
    Date.now = () => realNow() + window.__skew;
    performance.now = () => realPerf() + window.__skew;
    Object.defineProperty(document, "visibilityState", {
      get: () => window.__vis ?? "visible",
      configurable: true,
    });
  });
  wireLockNowCapture(pageD1, "D1");
  const respD1 = await pageD1.goto(`${BASE}/`, { waitUntil: "networkidle" });
  log("S9 D1 open household GET /", { status: respD1.status(), url: pageD1.url() });

  const pageD2 = await ctxD.newPage();
  const authD2 = await addAuthenticator(pageD2, "D2");
  await enrolFirstPasskey(pageD2, "Tab two");
  await pageD2.waitForTimeout(500);
  log("S9 after D2 enrols first passkey", counts());

  const beforeD1 = lockNowNetwork.filter((e) => e.tag === "D1").length;
  await dispatchVis(pageD1, "hidden");
  await bumpSkew(pageD1, 61000);
  await dispatchVis(pageD1, "visible");
  await pageD1.waitForTimeout(1500);
  const afterD1 = lockNowNetwork.filter((e) => e.tag === "D1").length;
  log("S9 D1 reentry trigger (never knew about D2's enrolment)", {
    lockNowRequestsSeen: afterD1 - beforeD1,
    counts: counts(),
    finalUrlD1: pageD1.url(),
  });
  await shot(pageD1, "s9-d1-after-trigger");

  const respD2next = await pageD2.goto(`${BASE}/holdings`, { waitUntil: "networkidle" });
  log("S9 D2 next navigation after D1's post", { status: respD2next.status(), url: pageD2.url() });

  // -------------------------------------------------------------------------
  // S10
  // -------------------------------------------------------------------------
  log("S10 START");
  psql("delete from passkey;");
  log("S10 deleted all passkeys again", counts());

  const ctxE = await browser.newContext();
  const pageE = await ctxE.newPage();
  await pageE.addInitScript(() => {
    const realNow = Date.now.bind(Date);
    const realPerf = performance.now.bind(performance);
    window.__skew = 0;
    window.__vis = undefined;
    Date.now = () => realNow() + window.__skew;
    performance.now = () => realPerf() + window.__skew;
    Object.defineProperty(document, "visibilityState", {
      get: () => window.__vis ?? "visible",
      configurable: true,
    });
  });
  const respChainE = [];
  pageE.on("response", (res) => {
    const u = new URL(res.url());
    if (["/lock-now", "/unlock", "/"].includes(u.pathname)) {
      respChainE.push({ url: res.url(), status: res.status() });
    }
  });
  const respE = await pageE.goto(`${BASE}/`, { waitUntil: "networkidle" });
  log("S10 context E open household GET /", { status: respE.status(), url: pageE.url() });

  respChainE.length = 0;
  await dispatchVis(pageE, "hidden");
  await bumpSkew(pageE, 61000);
  await dispatchVis(pageE, "visible");
  await pageE.waitForTimeout(1500);
  log("S10 unprotected reentry trigger", {
    responseChain: respChainE,
    finalUrl: pageE.url(),
  });
  await shot(pageE, "s10-after-trigger");

  // -------------------------------------------------------------------------
  // S11
  // -------------------------------------------------------------------------
  log("S11 START");
  const ctxF = await browser.newContext();
  const pageF = await ctxF.newPage();
  const authF1 = await addAuthenticator(pageF, "F1");
  await enrolFirstPasskey(pageF, "First");
  await pageF.waitForTimeout(500);
  log("S11 first passkey enrolled in F", counts());
  const cookieF_afterFirst = cookieSummary(await ctxF.cookies());

  await enrolSubsequentPasskey(pageF, "Second");
  await pageF.waitForTimeout(500);
  const noteAfterSameAuth = await text(pageF.locator(".form-error, .field-note").last());
  log("S11 same-authenticator second-enrol attempt: on-screen message", noteAfterSameAuth);
  await shot(pageF, "s11-same-authenticator-refused");
  log("S11 counts after same-authenticator attempt", counts());

  const authF2 = await addAuthenticator(pageF, "F2");
  await enrolSubsequentPasskey(pageF, "Second (via F2)");
  await pageF.waitForTimeout(500);
  const rowsF = await pageF.locator(".record-list li").allTextContents();
  log("S11 rows after second authenticator enrols", rowsF);
  log("S11 counts after second passkey enrolled", counts());
  const cookieF_afterSecond = cookieSummary(await ctxF.cookies());
  log("S11 cookie value change across confirm step", {
    afterFirst: cookieF_afterFirst,
    afterSecond: cookieF_afterSecond,
    changed: cookieF_afterFirst.present && cookieF_afterSecond.present
      ? "compare valueLength/log manually (see raw cookie capture below)"
      : "n/a",
  });

  // -------------------------------------------------------------------------
  // S12
  // -------------------------------------------------------------------------
  log("S12 START");
  await pageF.goto(`${BASE}/settings/passkeys`, { waitUntil: "networkidle" });
  const firstRow = pageF.locator(".record-list li").first();
  const removeBtnReal = firstRow.locator("button", { hasText: "Remove" });
  const removeAriaLabel = await removeBtnReal.getAttribute("aria-label");
  const removeBtnText = await removeBtnReal.textContent();
  log("S12 first row Remove control", { ariaLabel: removeAriaLabel, text: removeBtnText?.trim() });

  const warningTextFirst = await text(firstRow.locator(".choice--prose").last());
  log("S12 checkbox warning text for first row", warningTextFirst);

  // The checkbox must be ticked BEFORE pressing Remove: PasskeyRow's
  // handleRemove only mints removal options (revealing "Confirm removal")
  // when `acknowledged` is already true at the moment Remove is pressed —
  // otherwise it submits an unauthorised removal directly and is refused.
  await firstRow.locator('input[type="checkbox"]').check();
  const dbBeforeSign1 = psql("select label, last_used_at from passkey order by label;");
  await removeBtnReal.click();
  await pageF.waitForTimeout(600);
  const confirmRemovalBtn = firstRow.getByRole("button", { name: "Confirm removal" });
  const confirmRemovalText = await confirmRemovalBtn.textContent().catch((e) => `ERROR: ${e.message}`);
  await confirmRemovalBtn.click();
  await pageF.waitForTimeout(800);
  const dbAfterSign1 = psql("select label, last_used_at from passkey order by label;");
  log("S12 confirm removal button text and outcome", {
    confirmRemovalText: confirmRemovalText?.trim?.() ?? confirmRemovalText,
    last_used_at_before: dbBeforeSign1,
    last_used_at_after: dbAfterSign1,
  });

  const rowsAfterFirstRemoval = await pageF.locator(".record-list li").allTextContents();
  log("S12 rows after removing first passkey", rowsAfterFirstRemoval);
  log("S12 counts after removing first passkey", counts());

  const holdingsAfterRemoval = await pageF.goto(`${BASE}/holdings`, { waitUntil: "networkidle" });
  log("S12 GET /holdings after first removal (cookie still valid?)", {
    status: holdingsAfterRemoval.status(),
    url: pageF.url(),
  });

  await pageF.goto(`${BASE}/settings/passkeys`, { waitUntil: "networkidle" });
  const lastRow = pageF.locator(".record-list li").first();
  const lastRemoveBtn = lastRow.locator("button", { hasText: "Remove" });
  const warningTextLast = await text(lastRow.locator(".choice--prose").last());
  log("S12 checkbox warning text for LAST passkey", warningTextLast);
  await lastRow.locator('input[type="checkbox"]').check();
  await lastRemoveBtn.click();
  await pageF.waitForTimeout(600);
  await lastRow.getByRole("button", { name: "Confirm removal" }).click();
  await pageF.waitForTimeout(800);
  log("S12 counts after removing last passkey", counts());

  const ctxG_check = await browser.newContext();
  const pageG_check = await ctxG_check.newPage();
  const respOpenAgain = await pageG_check.goto(`${BASE}/`, { waitUntil: "networkidle" });
  log("S12 fresh context GET / after removing last passkey (instance open?)", {
    status: respOpenAgain.status(),
    url: pageG_check.url(),
  });
  await ctxG_check.close();

  // -------------------------------------------------------------------------
  // S13
  // -------------------------------------------------------------------------
  log("S13 START (household currently open, 0 passkeys)");
  const ctxOpen = await browser.newContext();
  const label61 = "x".repeat(61);
  const label60 = "x".repeat(60);
  let r61 = await ctxOpen.request.post(`${BASE}/settings/passkeys`, {
    form: { intent: "beginEnrolment", label: label61, acknowledged: "true" },
  });
  log("S13 label 61 chars on open household", { status: r61.status(), body: await r61.text() });

  let r60 = await ctxOpen.request.post(`${BASE}/settings/passkeys`, {
    form: { intent: "beginEnrolment", label: label60, acknowledged: "true" },
  });
  log("S13 label 60 chars on open household", { status: r60.status(), body: await r60.text() });

  // Lock the household via a dedicated context G so we can test the locked-with-grant cases.
  const ctxGlock = await browser.newContext();
  const pageGlock = await ctxGlock.newPage();
  const authG = await addAuthenticator(pageGlock, "G1");
  await enrolFirstPasskey(pageGlock, "Locked-test key");
  await pageGlock.waitForTimeout(500);
  const gCounts = counts();
  log("S13 household re-locked for validation tests", gCounts);
  const realCredId = psql("select credential_id from passkey limit 1;");

  const rEnrolNoAssertion = await ctxGlock.request.post(`${BASE}/settings/passkeys`, {
    form: { intent: "beginEnrolment", label: "second attempt", acknowledged: "true" },
  });
  log("S13 locked+grant, beginEnrolment with NO assertion", {
    status: rEnrolNoAssertion.status(),
    body: await rEnrolNoAssertion.text(),
  });

  const rRemoveNoAssertion = await ctxGlock.request.post(`${BASE}/settings/passkeys`, {
    form: { intent: "remove", credentialId: realCredId, confirmRemoval: "true" },
  });
  log("S13 locked+grant, remove with confirmRemoval but NO assertion", {
    status: rRemoveNoAssertion.status(),
    body: await rRemoveNoAssertion.text(),
  });

  const rRemoveNoConfirm = await ctxGlock.request.post(`${BASE}/settings/passkeys`, {
    form: { intent: "remove", credentialId: realCredId },
  });
  log("S13 locked+grant, remove with NO confirmRemoval, no assertion", {
    status: rRemoveNoConfirm.status(),
    body: await rRemoveNoConfirm.text(),
  });

  // -------------------------------------------------------------------------
  // S14
  // -------------------------------------------------------------------------
  log("S14 START");
  const respUnlockedRedirect = await pageGlock.goto(`${BASE}/unlock?redirectTo=%2Fholdings`, {
    waitUntil: "networkidle",
  });
  log("S14 unlocked context GET /unlock?redirectTo=%2Fholdings", {
    status: respUnlockedRedirect.status(),
    finalUrl: pageGlock.url(),
  });

  // remove the passkey to open the household again, then check /unlock -> /
  await pageGlock.goto(`${BASE}/settings/passkeys`, { waitUntil: "networkidle" });
  const onlyRow = pageGlock.locator(".record-list li").first();
  await onlyRow.locator('input[type="checkbox"]').check();
  await onlyRow.locator("button", { hasText: "Remove" }).click();
  await pageGlock.waitForTimeout(600);
  await onlyRow.getByRole("button", { name: "Confirm removal" }).click();
  await pageGlock.waitForTimeout(800);
  log("S14 counts after opening household again", counts());

  const ctxOpenUnlock = await browser.newContext();
  const pageOpenUnlock = await ctxOpenUnlock.newPage();
  const respOpenUnlock = await pageOpenUnlock.goto(`${BASE}/unlock`, { waitUntil: "networkidle" });
  log("S14 open household GET /unlock", { status: respOpenUnlock.status(), finalUrl: pageOpenUnlock.url() });
  await ctxOpenUnlock.close();

  // -------------------------------------------------------------------------
  // S15
  // -------------------------------------------------------------------------
  log("S15 START — closing browser");
  await browser.close();
  log("DONE", new Date().toISOString());
}

main().catch((e) => {
  log("FATAL SCRIPT ERROR", { message: e.message, stack: e.stack });
  process.exitCode = 1;
});
