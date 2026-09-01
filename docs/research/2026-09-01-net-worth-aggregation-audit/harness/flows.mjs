/** AUDIT HARNESS — the app's real write workflows, driven through the UI. */
import { BASE } from "./lib.mjs";

export const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export async function submit(page, selector) {
  await page.click(selector);
  await page.waitForTimeout(250);
  await page.waitForLoadState("networkidle");
}

export async function submitNav(page, selector) {
  const before = page.url();
  await page.click(selector);
  await page
    .waitForFunction(
      (u) => location.href !== u || document.querySelector(".form-error, .field-error") !== null,
      before,
      { timeout: 120_000 },
    )
    .catch(() => {});
  await page.waitForLoadState("networkidle").catch(() => {});
}

export async function pageError(page) {
  const els = await page.$$(".form-error, .field-error");
  const t = [];
  for (const e of els) t.push((await e.innerText()).trim());
  return t.join(" | ") || "(no error shown)";
}

export async function createAccount(page, a) {
  await page.goto(`${BASE}/settings/accounts`, { waitUntil: "networkidle" });
  await page.waitForSelector("#new-account-name");
  await page.fill("#new-account-name", a.name);
  await page.fill("#new-account-institution", a.institution);
  await page.selectOption("#new-account-kind", a.kind);
  await page.selectOption("#new-account-ownerId", { label: a.owner });
  await page.selectOption("#new-account-taxTreatment", a.taxTreatment);
  await submit(page, "form button:has-text('Add account')");
  const err = await page.$(".form-error, .field-error");
  if (err) throw new Error(`createAccount ${a.name}: ${await err.innerText()}`);
}

export async function accountIds(page) {
  await page.goto(`${BASE}/settings/accounts`, { waitUntil: "networkidle" });
  const rows = await page.$$eval("table.data-table tbody tr", (trs) =>
    trs.map((tr) => ({
      name: tr.querySelector("td")?.innerText.trim() ?? "",
      id: tr.querySelector("a[href*='/settings/accounts/']")?.getAttribute("href")?.split("/").pop() ?? null,
    })),
  );
  return new Map(rows.map((r) => [r.name.split("\n")[0].trim(), r.id]));
}

/**
 * The four-step upload flow. `columns` names the header cells to map;
 * `instruments` supplies facts for any first sighting, keyed by raw string.
 */
export async function uploadStatement(page, { accountName, file, columns, instruments }) {
  await page.goto(`${BASE}/upload`, { waitUntil: "networkidle" });
  await page.waitForSelector("#upload-account");
  const opts = await page.$$eval("#upload-account option", (els) =>
    els.map((e) => ({ value: e.value, label: e.textContent.trim() })),
  );
  const opt = opts.find((o) => o.label.startsWith(accountName));
  if (opt === undefined) throw new Error(`no upload option for "${accountName}"`);
  await page.selectOption("#upload-account", opt.value);
  await page.setInputFiles("#upload-file", file);
  await submitNav(page, "button:has-text('Continue to columns')");
  if (!page.url().includes("/columns")) throw new Error(`step 1: ${await pageError(page)}`);

  await page.waitForSelector("#map-instrument");
  for (const [field, cell] of Object.entries(columns)) {
    await page.selectOption(`#map-${field}`, cell);
  }
  if (columns.owedAsPositive) await page.check("input[name=owedAsPositive][value=true]");
  await page.check(`input[name=costBasisIs][value=${columns.costBasisIs ?? "per_share"}]`);
  await submitNav(page, "button:has-text('Save mapping and continue')");
  if (page.url().includes("/columns")) throw new Error(`columns: ${await pageError(page)}`);

  let combined = null;
  if (page.url().includes("/instruments")) {
    await page.waitForSelector("input[name^='raw-']", { state: "attached" });
    const n = await page.$$eval("input[name^='raw-']", (e) => e.length);
    const options = await page.$$eval("select[id^='classificationId-'] option", (els) =>
      els.map((e) => ({ value: e.value, label: e.textContent.trim() })),
    );
    const known = new Map(options.filter((o) => /^\d+$/.test(o.value)).map((o) => [o.label, o.value]));
    for (let i = 0; i < n; i += 1) {
      const raw = (await page.inputValue(`input[name='raw-${i}']`)).trim();
      const meta = instruments.get(raw);
      if (meta === undefined) throw new Error(`unknown first sighting "${raw}"`);
      await page.check(`input[name='kind-${i}'][value=create]`);
      await page.fill(`#symbol-${i}`, meta.symbol ?? "");
      await page.fill(`#name-${i}`, meta.name);
      await page.check(`input[name='priceSource-${i}'][value=${meta.priceSource ?? "feed"}]`);
      const existing = known.get(meta.classification);
      if (existing !== undefined) await page.selectOption(`#classificationId-${i}`, existing);
      else {
        await page.selectOption(`#classificationId-${i}`, "__new__");
        await page.fill(`#newClassificationName-${i}`, meta.classification);
        await page.selectOption(`#newClassificationAssetClass-${i}`, meta.assetClass);
      }
    }
    await submitNav(page, "button:has-text('Save and continue')");
    if (page.url().includes("/instruments")) throw new Error(`instruments: ${await pageError(page)}`);
  }

  if (!page.url().includes("/review")) throw new Error(`expected review, at ${page.url()}`);
  await page.waitForSelector("button:has-text('Record this statement')");
  const summary = await page.$("span.panel-count");
  const diff = summary ? (await summary.innerText()).trim() : null;
  // Rows the review screen shows as combined, for the lot-folding check.
  combined = await page.$$eval("p, .field-note", (els) =>
    els.map((e) => e.innerText.trim()).filter((t) => /combined|lines/i.test(t)),
  ).catch(() => []);
  const confirm = await page.$("input[name=confirmRemovals]");
  if (confirm) await confirm.check();
  await submitNav(page, "button:has-text('Record this statement')");
  if (page.url().includes("/review")) throw new Error(`commit: ${await pageError(page)}`);
  return { url: page.url(), diff, combined };
}

export async function setBalance(page, { accountId, amount, asOf }) {
  await page.goto(`${BASE}/accounts/${accountId}`, { waitUntil: "networkidle" });
  await page.waitForSelector("#set-balance-amount");
  await page.fill("#set-balance-amount", amount);
  if (asOf) await page.fill("#set-balance-as-of", asOf);
  await submitNav(page, "button:has-text('Record balance')");
  const err = await page.$(".form-error, .field-error");
  if (err) throw new Error(`setBalance: ${await err.innerText()}`);
}

/** The Holdings row editor: /holdings?edit=<accountId>.<instrumentId> */
export async function editHolding(page, { accountId, instrumentId, quantity, costBasisPerShare }) {
  await page.goto(`${BASE}/holdings?edit=${accountId}.${instrumentId}`, { waitUntil: "networkidle" });
  await page.waitForSelector("#revise-quantity");
  await page.fill("#revise-quantity", quantity);
  if (costBasisPerShare !== undefined) await page.fill("#revise-cost-basis", costBasisPerShare);
  await submitNav(page, "form#revise-position button:has-text('Save')");
  const err = await page.$(".form-error, .field-error");
  if (err) throw new Error(`editHolding: ${await err.innerText()}`);
}

export async function closeAccount(page, accountId) {
  await page.goto(`${BASE}/settings/accounts/${accountId}`, { waitUntil: "networkidle" });
  await page.waitForSelector("input[name=confirmClose]");
  await page.check("input[name=confirmClose][value=true]");
  await submitNav(page, "button[name=intent][value=close]");
}

/** The header "Refresh now" control on any figure screen. */
export async function refreshNow(page) {
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  const btn = await page.$("button.refresh-button");
  if (btn === null) return null;
  await submitNav(page, "button.refresh-button");
  const note = await page.$("p.coverage-note, p.form-error");
  return note ? (await note.innerText()).trim() : null;
}
