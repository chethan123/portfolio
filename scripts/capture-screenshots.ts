/**
 * Retakes every committed screenshot (docs/screenshots/, docs/guide/images/) against the real
 * app + demo household — never a mock, so a screen can drift from its picture unnoticed. Run recipe: docs/developing.md.
 */
import { randomBytes } from "node:crypto";

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

import { loadConfig } from "../server/config.ts";
import { createPool } from "../server/db.ts";
import type { Pool, PoolClient } from "pg";

const BASE_URL = process.env.BASE_URL ?? "http://127.0.0.1:5173";

/** Playwright's own Chromium unless CI/a sandbox sets this to an existing one. */
const EXECUTABLE = process.env.CHROMIUM_EXECUTABLE;

/** README shots. 1600 wide: narrowest width the widest table fits without `.data-table-scroll` cutting a column. */
const DESKTOP = { width: 1600, height: 1000 } as const;
/** Phone viewport; not full-page since the bottom nav is `position: fixed`. */
const MOBILE = { width: 390, height: 900 } as const;

/** Symbol the upload walk resolves on the new-instruments step. */
const FIRST_SIGHTING = "SCHD";

type Theme = "light" | "dark";

// Module state, not a parameter — `open`'s call sites take none; undefined only on --first-run.
let captureGrant: { id: string; expiresAt: Date } | undefined;

async function open(browser: Browser, theme: Theme, mobile = false, masked = false): Promise<Page> {
  const context = await browser.newContext({
    viewport: mobile ? MOBILE : DESKTOP,
    deviceScaleFactor: 2,
    isMobile: mobile,
    hasTouch: mobile,
    colorScheme: theme,
  });

  // Fresh context seeds *masked* by policy (spec 0007) — un-masks every shot except when `masked` flips it back.
  await context.addCookies([{ ...(masked ? MASKED_COOKIE : UNMASKED_COOKIE), url: BASE_URL }]);

  const page = await context.newPage();
  if (captureGrant !== undefined) await setGrantCookie(context, page, captureGrant);
  return page;
}

/** Spelled out, not imported from app/lib/masking.ts — script talks over HTTP, sharing no module.
 * No `path`: Playwright refuses a cookie carrying both `url` and `path`. */
const UNMASKED_COOKIE = { name: "masked", value: "0" } as const;

/** Masked variant, for the one pair of shots meant to show dots (finding 2). */
const MASKED_COOKIE = { name: "masked", value: "1" } as const;

/** Lock's own cookie name, spelled out like UNMASKED_COOKIE. Needs raw CDP `Network.setCookie`
 * ({@link setGrantCookie}) — Playwright's `addCookies` refuses a `Secure` cookie on `http://`, Chromium allows it on loopback. */
const GRANT_COOKIE = "__Host-unlock_grant";

/** Comfortably past any run's real duration (30+ navigations, two themes) — not measured, just obviously safe. */
const CAPTURE_GRANT_LIFETIME_MS = 6 * 60 * 60 * 1000;

/**
 * Placeholder passkey (migration 0012) so the lock's chrome has an enrolled row. seed-demo.ts
 * won't plant it (would lock out real checkouts); safe here since capture never does a real WebAuthn response.
 * Idempotent by this id; refuses if any *other* passkey exists, so a dev's own never leaks into screenshots.
 */
export const CAPTURE_PLACEHOLDER_CREDENTIAL_ID = "demo-placeholder-credential-id";

/** Exported for tests/scripts/capture-screenshots.test.ts (finding 1's coexistence case). */
export async function ensureCapturePasskey(pool: Pool | PoolClient): Promise<string> {
  // Reads + classifies the whole table before writing — scoping to just the placeholder id
  // would miss a coexisting real passkey (finding 1).
  const { rows } = await pool.query<{ credential_id: string }>(`select credential_id from passkey`);

  const other = rows.find((row) => row.credential_id !== CAPTURE_PLACEHOLDER_CREDENTIAL_ID);
  if (other !== undefined) {
    throw new Error(
      "This database already holds a passkey that is not the capture placeholder — probably " +
        "enrolled by hand while testing against the seeded demo. Re-seed before capturing, so " +
        "the shots show only the placeholder, never a real passkey's own label:\n" +
        "  node --env-file=<file> ./scripts/seed-demo.ts",
    );
  }

  const existing = rows.find((row) => row.credential_id === CAPTURE_PLACEHOLDER_CREDENTIAL_ID);
  if (existing !== undefined) return existing.credential_id;

  const { rows: inserted } = await pool.query<{ credential_id: string }>(
    `insert into passkey (credential_id, public_key, backup_eligible, label, bootstrap)
     values ($1, $2, $3, $4, true)
     returning credential_id`,
    [
      CAPTURE_PLACEHOLDER_CREDENTIAL_ID,
      Buffer.from("demo placeholder public key — never verified"),
      true,
      "Alex's Phone",
    ],
  );
  const planted = inserted[0];
  if (planted === undefined) throw new Error("Failed to plant the capture passkey.");
  return planted.credential_id;
}

/**
 * One grant for the whole run, reused by every {@link open} call. Writes straight to unlock_grant
 * (same licence ARCHITECTURE.md grants seed-demo.ts) since a real unlock ceremony needs a credential Chromium can't produce.
 */
async function mintCaptureGrant(pool: Pool | PoolClient): Promise<void> {
  const credentialId = await ensureCapturePasskey(pool);

  const id = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + CAPTURE_GRANT_LIFETIME_MS);
  await pool.query(`insert into unlock_grant (id, passkey_id, expires_at) values ($1, $2, $3)`, [
    id,
    credentialId,
    expiresAt,
  ]);
  captureGrant = { id, expiresAt };
}

/** Raw CDP session, not `addCookies` (see {@link GRANT_COOKIE}) — Chromium is permissive on loopback, Playwright isn't.
 * `url` not `domain`: a `__Host-` cookie rejects any `Domain` attribute outright. */
async function setGrantCookie(
  context: BrowserContext,
  page: Page,
  grant: { id: string; expiresAt: Date },
): Promise<void> {
  const session = await context.newCDPSession(page);
  try {
    await session.send("Network.setCookie", {
      url: BASE_URL,
      name: GRANT_COOKIE,
      value: grant.id,
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
      expires: grant.expiresAt.getTime() / 1000,
    });
  } finally {
    await session.detach();
  }
}

/** Navigate and settle: fonts land late enough to change a table's height, so wait for them before a shot. */
async function visit(page: Page, path: string): Promise<void> {
  await page.goto(`${BASE_URL}${path}`, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
}

async function shoot(page: Page, file: string, fullPage = true): Promise<void> {
  await page.screenshot({ path: file, fullPage });
  console.log(`  ${file}`);
}

/** The kinds of account the shot list needs one of. */
const NEEDED = ["brokerage", "bank", "liability"] as const;
type Kind = (typeof NEEDED)[number];
type Accounts = Record<Kind, number>;

/** One refusal shape: not the demo household, naming what's missing. */
function refuse(what: string): never {
  throw new Error(
    `Expected ${what}, and found none.\n` +
      "This script captures the demo household. Seed it first:\n" +
      "  node --env-file=<file> ./scripts/seed-demo.ts",
  );
}

/**
 * Must run before any write (finding 1): demo_seed is seed-demo.ts's marker for a real demo
 * household. Skipping it would plant an unrecoverable passkey wherever DATABASE_URL points.
 */
async function requireDemoSeed(pool: Pool | PoolClient): Promise<void> {
  const { rows } = await pool.query<{ present: boolean }>(
    `select to_regclass('public.demo_seed') is not null as present`,
  );
  if (rows[0]?.present !== true) refuse("the `demo_seed` marker table");
}

/** Account ids, by kind, as this run of the seed happens to have numbered them. */
async function accountsByKind(pool: Pool | PoolClient): Promise<Accounts> {
  const { rows } = await pool.query<{ id: string; kind: string }>(
    `select id, kind from account where closed_at is null order by id`,
  );
  const found = new Map<string, number>();
  for (const row of rows) if (!found.has(row.kind)) found.set(row.kind, Number(row.id));

  const pick = (kind: Kind): number => found.get(kind) ?? refuse(`an open ${kind} account`);
  return { brokerage: pick("brokerage"), bank: pick("bank"), liability: pick("liability") };
}

type Position = {
  symbol: string | null;
  name: string;
  quantity: string;
  costBasis: string | null;
};

/** What an account holds on its newest statement. */
async function currentPositions(pool: Pool | PoolClient, accountId: number): Promise<Position[]> {
  const { rows } = await pool.query<Position>(
    `select i.symbol, i.name, h.quantity, h.cost_basis_per_share as "costBasis"
       from holding h
       join instrument i on i.id = h.instrument_id
      where h.position_set_id = (
              select id from position_set
               where account_id = $1
               order by as_of_date desc, created_at desc, id desc
               limit 1)
      order by i.symbol`,
    [accountId],
  );
  return rows;
}

/**
 * Fidelity-shaped statement CSV. The diff is the point: one bumped quantity, one added
 * (new-instruments step), one dropped ("sold") — a single removal stays under the majority-removal confirmation.
 */
function authorStatement(positions: Position[], accountNumber: string): string {
  const priced = positions.filter((p) => p.symbol !== null);
  if (priced.length < 3) {
    throw new Error(
      `Need at least three symbol-bearing positions to author a diff; found ${priced.length}.`,
    );
  }

  const dropped = priced.at(-1)!; // left out of the file → "removed"
  const bumped = priced.find((p) => p !== dropped && p.costBasis !== null)!;
  const kept = positions.filter((p) => p !== dropped);

  const money = (n: string) =>
    `"$${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}"`;

  const lines = [
    "Account positions as of statement date",
    "",
    "Account Number,Account Name,Symbol,Description,Quantity,Current Value,Average Cost Basis",
  ];

  for (const p of kept) {
    const quantity = p === bumped ? String(Math.round(Number(p.quantity) + 12)) : p.quantity;
    const basis = p.costBasis === null ? "n/a" : `$${p.costBasis}`;
    const value = money(String(Number(quantity) * Number(p.costBasis ?? "1")));
    lines.push(
      [
        accountNumber,
        "Individual",
        p.symbol ?? p.name,
        `"${p.name.toUpperCase()}"`,
        quantity,
        value,
        basis,
      ].join(","),
    );
  }

  // The never-held instrument — what the new-instruments step exists to resolve.
  lines.push(
    [accountNumber, "Individual", FIRST_SIGHTING, '"SCHWAB US DIVIDEND EQUITY ETF"', "60", '"$1,629.00"', "$25.4000"].join(","),
  );

  return `${lines.join("\n")}\n`;
}

/**
 * Undoes the walk's two writes so the household stays untaught — else later walks would skip
 * the new-instruments step or prefill the mapping shot. Deletes above a watermark, never truncates.
 */
async function mappingWatermark(pool: Pool): Promise<string> {
  const { rows } = await pool.query<{ max: string }>(
    `select coalesce(max(id), 0)::text as max from column_mapping`,
  );
  return rows[0]?.max ?? "0";
}

async function forgetWalkWrites(pool: Pool, watermark: string): Promise<void> {
  await pool.query(`delete from instrument where symbol = $1`, [FIRST_SIGHTING]);
  await pool.query(`delete from column_mapping where id > $1`, [watermark]);
}

/** Walks the four-step upload as far as a given step, stopping short of recording; cleans up its own writes. */
async function walkUpload(
  page: Page,
  pool: Pool,
  csv: string,
  accountId: number,
  shots: { columnsBlank?: string; columnsMapped?: string; instruments?: string; review?: string },
): Promise<void> {
  const watermark = await mappingWatermark(pool);

  await visit(page, "/upload");
  await page.selectOption('select[name="accountId"]', String(accountId));
  await page.setInputFiles('input[type="file"]', {
    name: "statement.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(csv, "utf8"),
  });
  await page.getByRole("button", { name: /continue to columns/i }).click();
  await page.waitForURL(/\/columns/);
  await page.evaluate(() => document.fonts.ready);

  if (shots.columnsBlank) await shoot(page, shots.columnsBlank);

  for (const [name, value] of [
    ["instrument", "Symbol"],
    ["quantity", "Quantity"],
    ["name", "Description"],
    ["costBasis", "Average Cost Basis"],
    ["accountNumber", "Account Number"],
  ] as const) {
    await page.selectOption(`select[name="${name}"]`, value);
  }
  if (shots.columnsMapped) await shoot(page, shots.columnsMapped);

  await page.getByRole("button", { name: /save mapping and continue/i }).click();
  await page.waitForURL(/\/(instruments|review)/);
  await page.evaluate(() => document.fonts.ready);

  if (page.url().includes("/instruments")) {
    await page.check('input[name="kind-0"][value="create"]');
    await page.fill('input[name="symbol-0"]', FIRST_SIGHTING);
    await page.fill('input[name="name-0"]', "Schwab US Dividend Equity ETF");
    await page.check('input[name="priceSource-0"][value="feed"]');
    const classification = await page
      .locator('select[name="classificationId-0"] option')
      .nth(1)
      .getAttribute("value");
    await page.selectOption('select[name="classificationId-0"]', classification!);
    if (shots.instruments) await shoot(page, shots.instruments);
    await page.getByRole("button", { name: /save and continue/i }).click();
    await page.waitForURL(/\/review/);
    await page.evaluate(() => document.fonts.ready);
  }

  if (shots.review) await shoot(page, shots.review);

  await forgetWalkWrites(pool, watermark);
}

/** The empty-instance shots, against a migrated but unseeded database. */
async function captureFirstRun(browser: Browser): Promise<void> {
  console.log("\nFirst run — docs/guide/images/");
  const page = await open(browser, "light");
  await visit(page, "/");
  await shoot(page, "docs/guide/images/first-run-overview.png");
  await visit(page, "/settings/people");
  await shoot(page, "docs/guide/images/first-run-people.png");
  await visit(page, "/settings/accounts");
  await shoot(page, "docs/guide/images/first-run-accounts.png");
  await page.close();
}

/** Everything both passes need — read fresh, since the seed renumbers on every run. */
type Fixture = {
  accounts: Accounts;
  /** `?edit=` takes `<account>.<instrument>`. */
  editRow: string;
  ownerId: string;
  csv: string;
};

async function prepare(pool: Pool | PoolClient): Promise<Fixture> {
  const accounts = await accountsByKind(pool);
  const positions = await currentPositions(pool, accounts.brokerage);

  const { rows: accountRows } = await pool.query<{ number: string | null }>(
    `select external_account_number as number from account where id = $1`,
    [accounts.brokerage],
  );
  const account = accountRows[0] ?? refuse("the brokerage account");

  // A row with a cost basis, so both boxes carry a figure when it opens.
  const editable =
    positions.find((p) => p.costBasis !== null && p.symbol !== null) ??
    refuse("a brokerage position with a cost basis");

  const { rows: instrumentRows } = await pool.query<{ id: string }>(
    `select id from instrument where symbol = $1 limit 1`,
    [editable.symbol],
  );
  const instrument = instrumentRows[0] ?? refuse(`the instrument ${editable.symbol}`);

  const { rows: ownerRows } = await pool.query<{ id: string }>(
    `select id from person order by id limit 1`,
  );
  const owner = ownerRows[0] ?? refuse("a person in the household");

  return {
    accounts,
    editRow: `${accounts.brokerage}.${instrument.id}`,
    ownerId: owner.id,
    csv: authorStatement(positions, account.number ?? ""),
  };
}

/**
 * Validate → read fixture → only then plant passkey+grant — exported so this order can't drift
 * and the test can pin it (tests/scripts/capture-screenshots.test.ts).
 */
export async function prepareCapture(pool: Pool | PoolClient): Promise<Fixture> {
  await requireDemoSeed(pool);
  const fixture = await prepare(pool);
  await mintCaptureGrant(pool);
  return fixture;
}

/** Opens the owner-filter `<details>` before shooting — it loads closed; clicks the summary so a markup change fails loudly. */
async function openOwnerFilter(page: Page): Promise<void> {
  const summary = page.locator(".owner-filter > summary");
  await summary.click();
  await page.locator(".owner-filter[open]").waitFor({ state: "visible" });
}

/** The README's shots: both themes, plus the two phone ones. */
async function captureReadme(browser: Browser, pool: Pool, fixture: Fixture): Promise<void> {
  console.log("\nREADME — docs/screenshots/");
  const { accounts, editRow, ownerId, csv } = fixture;
  const brokerage = accounts.brokerage;

  for (const theme of ["light", "dark"] as const) {
    const page = await open(browser, theme);
    await visit(page, "/");
    await shoot(page, `docs/screenshots/overview-${theme}.png`);

    // Masked variant (finding 2) — separate context so this loop's `page` stays unmasked throughout.
    const maskedPage = await open(browser, theme, false, true);
    await visit(maskedPage, "/");
    await shoot(maskedPage, `docs/screenshots/overview-masked-${theme}.png`);
    await maskedPage.close();

    // Paired with the shot above (spec 0013); range=all is the only range showing the withheld-history note.
    await visit(page, `/?owner=${ownerId}&range=all`);
    await openOwnerFilter(page);
    await shoot(page, `docs/screenshots/overview-owner-${theme}.png`);

    // Only non-day-span preset (ADR-0006): time axis, time-of-day and cadence granularity show only here.
    await visit(page, "/?range=1d");
    await shoot(page, `docs/screenshots/overview-1d-${theme}.png`);
    await visit(page, "/holdings");
    await shoot(page, `docs/screenshots/holdings-${theme}.png`);

    // Cropped to the table: full-page at this width renders the boxes too small to read.
    await visit(page, `/holdings?account=${brokerage}&edit=${editRow}`);
    await page.locator("table").first().screenshot({
      path: `docs/screenshots/holdings-edit-${theme}.png`,
    });
    console.log(`  docs/screenshots/holdings-edit-${theme}.png`);

    await visit(page, "/analysis");
    await shoot(page, `docs/screenshots/analysis-${theme}.png`);
    await visit(page, "/income");
    await shoot(page, `docs/screenshots/income-${theme}.png`);
    await visit(page, `/accounts/${brokerage}`);
    await shoot(page, `docs/screenshots/account-detail-${theme}.png`);
    await visit(page, `/accounts/${accounts.liability}`);
    await shoot(page, `docs/screenshots/account-balance-${theme}.png`);
    await visit(page, "/settings/accounts");
    await shoot(page, `docs/screenshots/settings-${theme}.png`);
    // Enrolled row, not the empty list a never-locked household would show — this script plants its own passkey.
    await visit(page, "/settings/passkeys");
    await shoot(page, `docs/screenshots/settings-passkeys-${theme}.png`);
    await visit(page, "/upload");
    await shoot(page, `docs/screenshots/upload-${theme}.png`);

    await walkUpload(page, pool, csv, brokerage, {
      columnsBlank: `docs/screenshots/upload-mapping-${theme}.png`,
      review: `docs/screenshots/upload-review-${theme}.png`,
    });
    await page.close();

    const phone = await open(browser, theme, true);
    await visit(phone, "/");
    await shoot(phone, `docs/screenshots/overview-mobile-${theme}.png`, false);
    await visit(phone, "/analysis");
    await shoot(phone, `docs/screenshots/analysis-mobile-${theme}.png`, false);
    // Only screen reflowing to a card stack below 768px — group heading, subtotal strip, grand total must reflow right.
    await visit(phone, "/holdings?group=assetClass");
    // Cards start below the fold on a phone viewport — scroll to the subtotal before shooting.
    await phone.evaluate(() => {
      document.querySelector(".row-subtotal")?.scrollIntoView({ block: "center" });
    });
    await phone.evaluate(() => document.fonts.ready);
    await shoot(phone, `docs/screenshots/holdings-mobile-${theme}.png`, false);
    await phone.close();
  }
}

/** The guide's shots: light only, and task-shaped rather than screen-shaped. */
async function captureGuide(browser: Browser, pool: Pool, fixture: Fixture): Promise<void> {
  console.log("\nGuide — docs/guide/images/");
  const { accounts, editRow, ownerId, csv } = fixture;
  const brokerage = accounts.brokerage;

  const page = await open(browser, "light");

  await visit(page, "/");
  await shoot(page, "docs/guide/images/overview.png");
  await visit(page, "/?range=all");
  await shoot(page, "docs/guide/images/overview-range-all.png");
  await visit(page, "/?range=1d");
  await shoot(page, "docs/guide/images/overview-range-1d.png");

  await visit(page, "/holdings");
  await shoot(page, "docs/guide/images/holdings.png");
  // Grouped, unfiltered: guide describes grouping here; a filter would blur which control did what.
  await visit(page, "/holdings?group=assetClass");
  await shoot(page, "docs/guide/images/holdings-grouped.png");
  await visit(page, `/holdings?owner=${ownerId}`);
  await openOwnerFilter(page);
  await shoot(page, "docs/guide/images/holdings-owner.png");
  await visit(page, `/holdings?account=${brokerage}&edit=${editRow}`);
  await page.locator("table").first().screenshot({
    path: "docs/guide/images/holdings-edit.png",
  });
  console.log("  docs/guide/images/holdings-edit.png");

  await visit(page, "/analysis");
  await shoot(page, "docs/guide/images/analysis.png");
  await visit(page, "/income");
  await shoot(page, "docs/guide/images/income.png");

  await visit(page, `/accounts/${brokerage}`);
  await shoot(page, "docs/guide/images/account-detail.png");
  await visit(page, `/accounts/${accounts.bank}`);
  await shoot(page, "docs/guide/images/set-balance.png");

  await visit(page, "/settings/people");
  await shoot(page, "docs/guide/images/settings-people.png");
  await visit(page, "/settings/accounts");
  await shoot(page, "docs/guide/images/settings-accounts.png");
  await visit(page, `/settings/accounts/${accounts.bank}`);
  await shoot(page, "docs/guide/images/settings-account-edit.png");
  await visit(page, "/settings/tax");
  await shoot(page, "docs/guide/images/settings-tax.png");
  await visit(page, "/settings/prices");
  await shoot(page, "docs/guide/images/settings-prices.png");
  await visit(page, "/settings/passkeys");
  await shoot(page, "docs/guide/images/settings-passkeys.png");

  await visit(page, "/upload");
  await shoot(page, "docs/guide/images/upload-1-account-and-file.png");
  await walkUpload(page, pool, csv, brokerage, {
    columnsBlank: "docs/guide/images/upload-2-columns-blank.png",
    columnsMapped: "docs/guide/images/upload-2-columns-mapped.png",
    instruments: "docs/guide/images/upload-3-instruments.png",
    review: "docs/guide/images/upload-4-review.png",
  });
  await page.close();

  const phone = await open(browser, "light", true);
  await visit(phone, "/");
  await shoot(phone, "docs/guide/images/overview-mobile.png", false);
  await phone.close();
}

async function main(): Promise<void> {
  const firstRun = process.argv.includes("--first-run");
  const browser = await chromium.launch({
    executablePath: EXECUTABLE,
    args: ["--no-sandbox"],
  });

  try {
    if (firstRun) {
      await captureFirstRun(browser);
      return;
    }
    const { DATABASE_URL } = loadConfig(process.env);
    const pool = createPool(DATABASE_URL);
    try {
      // Validate before writing (finding 1) — prepareCapture pins the order.
      const fixture = await prepareCapture(pool);
      await captureReadme(browser, pool, fixture);
      await captureGuide(browser, pool, fixture);
    } finally {
      await pool.end();
    }
  } finally {
    await browser.close();
  }
  console.log("\nDone.");
}

// Guarded: tests import ensureCapturePasskey from this module; an unguarded call would launch a browser on every test run.
if (import.meta.main) {
  await main();
}
