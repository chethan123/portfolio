// Mutates a disposable, seeded demo instance. Never point this at a real portfolio.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const base = process.env.BASE_URL ?? 'http://localhost:3311';
const output = process.env.QA_OUTPUT ?? '/tmp/portfolio-dependency-qa';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE, args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
page.setDefaultTimeout(15000);
const errors = [];
const completed = [];
page.on('pageerror', error => errors.push(error.message));
page.on('response', response => { if (response.status() >= 500) errors.push(`${response.status()} ${response.url()}`); });
const record = name => { completed.push(name); console.log(`PASS ${name}`); };
async function visit(path) {
  const response = await page.goto(`${base}${path}`, { waitUntil: 'networkidle' });
  assert.equal(response.status(), 200, path);
  assert.equal(await page.locator('.form-error, .field-error').count(), 0, path);
}
async function clickSubmit(locator) {
  await Promise.all([
    page.waitForResponse(response => response.url().startsWith(base) &&
      (response.request().method() === 'POST' || response.url().includes('.data'))),
    locator.click(),
  ]);
  await page.waitForLoadState('networkidle');
  assert.equal(await page.locator('.form-error, .field-error').count(), 0, await page.locator('body').innerText());
}
async function createAccount(name, kind) {
  await visit('/settings/accounts');
  await page.locator('#new-account-name').fill(name);
  await page.locator('#new-account-institution').fill('Dependency QA');
  await page.locator('#new-account-kind').selectOption(kind);
  await page.locator('#new-account-ownerId').selectOption({ label: 'Alex Rivera' });
  await page.locator('#new-account-taxTreatment').selectOption('taxable');
  await clickSubmit(page.getByRole('button', { name: 'Add account', exact: true }));
  const row = page.locator('tbody tr').filter({ hasText: name });
  await row.waitFor();
  const href = await row.locator('a[href*="/settings/accounts/"]').getAttribute('href');
  assert.ok(href);
  return href.split('/').pop();
}
try {
  for (const path of ['/', '/holdings', '/analysis', '/income', '/settings', '/settings/people', '/settings/accounts', '/settings/instruments', '/settings/tax', '/settings/prices', '/settings/display', '/settings/passkeys']) {
    await visit(path);
    assert.ok((await page.locator('main').innerText()).trim().length > 20, path);
    record(`desktop ${path}`);
  }
  await visit('/');
  await page.getByRole('button', { name: 'Show amounts', exact: true }).first().click();
  await page.getByRole('button', { name: 'Hide amounts', exact: true }).first().waitFor();
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Hide amounts', exact: true }).first().waitFor();
  await page.getByRole('button', { name: 'Hide amounts', exact: true }).first().click();
  await page.getByRole('button', { name: 'Show amounts', exact: true }).first().click();
  await page.waitForLoadState('networkidle');
  record('masking toggle and reload persistence');
  await visit('/');
  await page.locator('.owner-filter summary').click();
  await page.getByRole('checkbox', { name: 'Alex Rivera', exact: true }).check();
  await clickSubmit(page.getByRole('button', { name: 'Apply', exact: true }));
  await page.waitForURL(/owner=/);
  record('owner filter');

  const suffix = Date.now();
  const bankName = `QA Bank ${suffix}`;
  const bank = await createAccount(bankName, 'bank');
  await visit(`/settings/accounts/${bank}`);
  await page.locator(`#account-${bank}-name`).fill(`${bankName} updated`);
  await clickSubmit(page.getByRole('button', { name: 'Save changes', exact: true }));
  await page.getByText('Saved.', { exact: true }).waitFor();
  record('account create and edit');
  await visit(`/accounts/${bank}`);
  for (const value of ['1100.00', '1250.00']) {
    await page.locator('#set-balance-amount').fill(value);
    await clickSubmit(page.getByRole('button', { name: 'Record balance', exact: true }));
    await page.waitForURL(/recorded=/);
    const formatted = value === '1100.00' ? '$1,100.00' : '$1,250.00';
    await page.waitForFunction(amount => document.querySelector('#set-balance [role="status"]')?.textContent?.includes(amount), formatted);
  }
  assert.match(await page.locator('#set-balance [role="status"]').innerText(), /1,250/);
  record('manual balance recorded and corrected to 1250');

  const brokerName = `QA Brokerage ${suffix}`;
  const broker = await createAccount(brokerName, 'brokerage');
  await visit('/upload');
  await page.locator('select[name="accountId"]').selectOption(broker);
  const date = new Date().toISOString().slice(0, 10);
  await page.locator('input[type="file"]').setInputFiles({ name: 'dependency-qa.csv', mimeType: 'text/csv', buffer: Buffer.from(`Symbol,Description,Quantity,Average Cost Basis,As Of Date\nAAPL,Apple Inc.,2,170.66,${date}\nVTI,Vanguard Total Stock Market ETF,3,205.12,${date}\n`) });
  await page.getByRole('button', { name: 'Continue to columns' }).click();
  await page.waitForURL(/\/columns/);
  for (const [name, value] of Object.entries({ instrument: 'Symbol', name: 'Description', quantity: 'Quantity', costBasis: 'Average Cost Basis', asOf: 'As Of Date' })) {
    await page.locator(`select[name="${name}"]`).selectOption(value);
  }
  await page.locator('input[name="costBasisIs"][value="per_share"]').check();
  await page.getByRole('button', { name: 'Save mapping and continue' }).click();
  await page.waitForURL(/\/review/);
  assert.match(await page.locator('main').innerText(), /AAPL/);
  assert.match(await page.locator('main').innerText(), /VTI/);
  await page.screenshot({ path: `${output}/upload-review.png`, fullPage: true });
  await page.getByRole('button', { name: 'Record this statement' }).click();
  await page.waitForURL(new RegExp(`/accounts/${broker}`));
  assert.match(await page.locator('main').innerText(), /AAPL/);
  assert.match(await page.locator('main').innerText(), /VTI/);
  record('CSV upload, mapping, review, commit, and account receipt');

  await visit('/settings/display');
  await page.getByRole('radio', { name: /Showing amounts/ }).check();
  await clickSubmit(page.getByRole('button', { name: 'Save', exact: true }));
  await page.reload({ waitUntil: 'networkidle' });
  assert.ok(await page.getByRole('radio', { name: /Showing amounts/ }).isChecked());
  record('display setting save and reload');

  await page.setViewportSize({ width: 390, height: 844 });
  for (const path of ['/', '/holdings', '/analysis', '/income', `/accounts/${bank}`, '/upload']) {
    await visit(path);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `overflow: ${path}`);
    record(`mobile ${path}`);
  }
  await page.screenshot({ path: `${output}/mobile-upload.png`, fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });

  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  await visit('/settings/passkeys');
  const label = `QA browser ${suffix}`;
  await page.locator('#passkey-label').fill(label);
  await page.getByRole('checkbox').first().check();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: `Create the passkey named "${label}"`, exact: true }).click();
  await page.getByRole('button', { name: 'Lock now', exact: true }).first().waitFor();
  assert.match(await page.locator('main').innerText(), new RegExp(label));
  record('real WebAuthn enrollment with Chromium virtual authenticator');
  await page.getByRole('button', { name: 'Lock now', exact: true }).first().click();
  await page.getByRole('heading', { name: 'Locked', exact: true }).waitFor();
  await page.screenshot({ path: `${output}/locked.png` });
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await page.waitForURL(url => url.pathname !== '/unlock');
  await page.getByRole('button', { name: 'Lock now', exact: true }).first().waitFor();
  record('lock and real WebAuthn unlock');
  assert.deepEqual(errors, []);
  await page.screenshot({ path: `${output}/unlocked.png`, fullPage: true });
} catch (error) {
  await page.screenshot({ path: `${output}/failure.png`, fullPage: true }).catch(() => {});
  await writeFile(`${output}/failure.txt`, `${error.stack}\n\n${await page.locator('body').innerText()}`);
  throw error;
} finally {
  await writeFile(`${output}/browser-results.json`, JSON.stringify({ base, completed, errors }, null, 2));
  await browser.close();
}
