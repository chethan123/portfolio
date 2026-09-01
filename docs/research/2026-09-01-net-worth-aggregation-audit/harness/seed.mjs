/**
 * AUDIT HARNESS — Step 3: seed the generated dataset through the real UI.
 *
 * Everything here goes through the application's own forms: Settings → People,
 * Settings → Accounts, the four-step upload flow, and the Set balance form.
 * Nothing is written to the database directly.
 *
 *   node audit/seed.mjs            # people + accounts + every statement + balances
 *   node audit/seed.mjs --only-accounts
 */
import fs from "node:fs";
import path from "node:path";
import { BASE, DATA, ledger, open, shot } from "./lib.mjs";

const L = ledger();
const only = process.argv.slice(2);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const { browser, page } = await open();

async function submit(selector) {
  await page.click(selector);
  await page.waitForTimeout(250);
  await page.waitForLoadState("networkidle");
}

/** A submit that is expected to navigate (the upload flow's four steps). */
async function submitNav(selector) {
  const before = page.url();
  await page.click(selector);
  await page
    .waitForFunction(
      (u) =>
        location.href !== u ||
        document.querySelector(".form-error, .field-error") !== null,
      before,
      { timeout: 120_000 },
    )
    .catch(() => {});
  await page.waitForLoadState("networkidle").catch(() => {});
}

// ---------------------------------------------------------------- people
async function seedPeople() {
  await page.goto(`${BASE}/settings/people`, { waitUntil: "networkidle" });
  const existing = await page.$$eval(".record input[name=name]", (els) =>
    els.map((e) => e.value),
  ).catch(() => []);
  for (const name of L.people) {
    if (existing.includes(name)) continue;
    await page.fill("#new-person-name", name);
    await submit("button[name=intent][value=create]");
  }
  await shot(page, "01-people");
  log("people seeded");
}

// -------------------------------------------------------------- accounts
async function seedAccounts() {
  for (const a of L.accounts) {
    await page.goto(`${BASE}/settings/accounts`, { waitUntil: "networkidle" });
    const already = await page.$$eval("table.data-table td:first-child", (els) =>
      els.map((e) => e.innerText.trim()),
    ).catch(() => []);
    if (already.some((t) => t.startsWith(a.name))) continue;
    await page.fill("#new-account-name", a.name);
    await page.fill("#new-account-institution", a.institution);
    await page.selectOption("#new-account-kind", a.kind);
    await page.selectOption("#new-account-ownerId", { label: a.owner });
    await page.selectOption("#new-account-taxTreatment", a.taxTreatment);
    await submit("form button:has-text('Add account')");
    const err = await page.$(".form-error, .field-error");
    if (err) throw new Error(`account ${a.name}: ${await err.innerText()}`);
  }
  await shot(page, "02-accounts");
  log(`accounts seeded (${L.accounts.length})`);
}

/** account name -> numeric id, read off Settings → Accounts. */
async function accountIds() {
  await page.goto(`${BASE}/settings/accounts`, { waitUntil: "networkidle" });
  const rows = await page.$$eval("table.data-table tbody tr", (trs) =>
    trs.map((tr) => {
      const link = tr.querySelector("a[href*='/settings/accounts/']");
      return {
        name: tr.querySelector("td")?.innerText.trim() ?? "",
        id: link?.getAttribute("href")?.split("/").pop() ?? null,
      };
    }),
  );
  const map = new Map();
  for (const r of rows) map.set(r.name.split("\n")[0].trim(), r.id);
  return map;
}

// ------------------------------------------------------- statement upload
async function uploadStatement(accountName, file) {
  await page.goto(`${BASE}/upload`, { waitUntil: "networkidle" });
  await page.waitForSelector("#upload-account");
  const opts = await page.$$eval("#upload-account option", (els) =>
    els.map((e) => ({ value: e.value, label: e.textContent.trim() })),
  );
  const opt = opts.find((o) => o.label.startsWith(accountName));
  if (opt === undefined) throw new Error(`no upload option for "${accountName}"`);
  await page.selectOption("#upload-account", opt.value);
  await page.setInputFiles("#upload-file", file);
  await submitNav("button:has-text('Continue to columns')");

  if (!page.url().includes("/columns")) {
    throw new Error(`upload step 1 stayed at ${page.url()}: ${await pageError()}`);
  }

  // --- columns
  await page.waitForSelector("#map-instrument");
  await page.selectOption("#map-instrument", "Symbol");
  await page.selectOption("#map-quantity", "Quantity");
  await page.selectOption("#map-name", "Description");
  await page.selectOption("#map-costBasis", "Cost Basis Per Share");
  await page.selectOption("#map-asOf", "As Of");
  await page.selectOption("#map-accountNumber", "__none__");
  await page.check("input[name=costBasisIs][value=per_share]");
  await submitNav("button:has-text('Save mapping and continue')");
  if (page.url().includes("/columns")) {
    throw new Error(`columns refused: ${await pageError()}`);
  }

  // --- instruments (skipped by redirect when nothing is new)
  if (page.url().includes("/instruments")) {
    await resolveInstruments();
  }
  if (page.url().includes("/instruments")) {
    throw new Error(`instruments refused: ${await pageError()}`);
  }

  // --- review
  if (!page.url().includes("/review")) throw new Error(`expected review, got ${page.url()}`);
  await page.waitForSelector("button:has-text('Record this statement')");
  const confirm = await page.$("input[name=confirmRemovals]");
  if (confirm) await confirm.check();
  await submitNav("button:has-text('Record this statement')");
  if (page.url().includes("/review")) throw new Error(`commit refused: ${await pageError()}`);
  return page.url();
}

async function resolveInstruments() {
  await page.waitForSelector("input[name^='raw-']", { state: "attached" });
  const n = await page.$$eval("input[name^='raw-']", (els) => els.length);
  if (n === 0) throw new Error("instruments step rendered no first sightings");
  const options = await page.$$eval("select[id^='classificationId-'] option", (els) =>
    els.map((e) => ({ value: e.value, label: e.textContent.trim() })),
  );
  const known = new Map(options.filter((o) => /^\d+$/.test(o.value)).map((o) => [o.label, o.value]));
  const byId = new Map(L.instruments.map((i) => [i.symbol, i]));

  for (let i = 0; i < n; i += 1) {
    const raw = await page.inputValue(`input[name='raw-${i}']`);
    const meta = byId.get(raw.trim());
    if (meta === undefined) throw new Error(`unknown first sighting "${raw}"`);
    await page.check(`input[name='kind-${i}'][value=create]`);
    await page.fill(`#symbol-${i}`, meta.symbol);
    await page.fill(`#name-${i}`, meta.name);
    await page.check(`input[name='priceSource-${i}'][value=feed]`);
    const existing = known.get(meta.classification);
    if (existing !== undefined) {
      await page.selectOption(`#classificationId-${i}`, existing);
    } else {
      await page.selectOption(`#classificationId-${i}`, "__new__");
      await page.fill(`#newClassificationName-${i}`, meta.classification);
      await page.selectOption(`#newClassificationAssetClass-${i}`, meta.assetClass);
    }
  }
  await submitNav("button:has-text('Save and continue')");
}

async function pageError() {
  const els = await page.$$(".form-error, .field-error");
  const texts = [];
  for (const e of els) texts.push((await e.innerText()).trim());
  return texts.join(" | ") || "(no error shown)";
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// -------------------------------------------------------------- balances
async function seedBalances(ids) {
  for (const b of L.balances) {
    const id = ids.get(b.accountName);
    if (id === undefined) throw new Error(`no id for ${b.accountName}`);
    await page.goto(`${BASE}/accounts/${id}`, { waitUntil: "networkidle" });
    await page.waitForSelector("#set-balance-amount");
    await page.fill("#set-balance-amount", b.amount);
    await page.fill("#set-balance-as-of", L.asOf);
    await submitNav("button:has-text('Record balance')");
    const err = await page.$(".form-error, .field-error");
    if (err) throw new Error(`balance ${b.accountName}: ${await err.innerText()}`);
  }
  log(`balances seeded (${L.balances.length})`);
}

// ------------------------------------------------------------------ main
try {
  await seedPeople();
  await seedAccounts();
  const ids = await accountIds();
  fs.writeFileSync(path.join(DATA, "account-ids.json"),
    JSON.stringify(Object.fromEntries(ids), null, 1));

  if (!only.includes("--only-accounts")) {
    const seeded = L.accounts.filter(
      (a) => ["brokerage", "401k", "ira"].includes(a.kind) && !a.empty,
    );
    let i = 0;
    for (const a of seeded) {
      i += 1;
      const file = path.join(DATA, "statements", `${a.key}.csv`);
      if (!fs.existsSync(file)) continue;
      const url = await uploadStatement(a.name, file);
      log(`[${i}/${seeded.length}] ${a.key} ${a.name} -> ${url.split("?")[0]}`);
      if (i === 1) await shot(page, "03-first-upload-receipt");
    }
    await seedBalances(ids);
  }
  log("seed complete");
} finally {
  await browser.close();
}
