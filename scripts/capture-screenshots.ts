/**
 * Every committed screenshot, retaken in one command. The images under
 * `docs/screenshots/` and `docs/guide/images/` are the real application
 * against the generated demo household — never a mock, never hand-edited —
 * which makes them the one thing here that can go stale silently: a screen
 * changes, its picture does not, nothing fails.
 *
 * Run from the repository root, against a throwaway database the application
 * is already serving:
 *
 *   printf 'DATABASE_URL=postgres://portfolio:portfolio@127.0.0.1:55432/portfolio_demo\n' > .env.demo
 *   node --env-file=.env.demo ./server/migrate.ts
 *   node --env-file=.env.demo ./scripts/seed-demo.ts
 *   DATABASE_URL=postgres://portfolio:portfolio@127.0.0.1:55432/portfolio_demo npm run dev &
 *
 *   node --env-file=.env.demo ./scripts/capture-screenshots.ts
 *
 * The guide's empty-instance shots need a second, *migrated but unseeded*
 * database, served the same way:
 *
 *   node --env-file=.env.fresh ./scripts/capture-screenshots.ts --first-run
 *
 * Three deliberate choices worth not undoing:
 *
 * **Nothing hardcoded that the seed regenerates.** Ids climb on every re-seed
 * (identity columns, plain-`delete` wipe), so accounts are looked up by
 * *kind* and the Holdings editor row by "has a cost basis" — never a number
 * read off a previous run.
 *
 * **The walkthrough statement is generated, not committed.** It must restate
 * current holdings so the review shows an unchanged majority beside one
 * added, one updated, one removed — but the demo calendar tracks the wall
 * clock, so a committed CSV would quietly turn "unchanged" rows into
 * "updated" a week later.
 *
 * **The upload flow is walked, never committed.** The mapping and review
 * shots need a live draft, which dies at commit — so the walk stops at review
 * and the drafts go to the 24-hour sweep. Committing would also change the
 * household every other shot is of.
 */
import { chromium, type Browser, type Page } from "playwright";

import { loadConfig } from "../server/config.ts";
import { createPool } from "../server/db.ts";
import type { Pool } from "pg";

/** Where the application under capture is serving. */
const BASE_URL = process.env.BASE_URL ?? "http://127.0.0.1:5173";

/**
 * Default is Playwright's own bundled Chromium (`npx playwright install
 * chromium`); sandboxes and CI images already carrying a browser set this
 * instead of downloading a second.
 */
const EXECUTABLE = process.env.CHROMIUM_EXECUTABLE;

/**
 * The README's shots. 1440 until Holdings gained a ninth column: rail (280) +
 * canvas margins (64) left the table scrolling inside `.data-table-scroll`,
 * and a full-page capture cut the last column off. This is the narrowest
 * round width at which the widest table the application draws is whole.
 */
const DESKTOP = { width: 1600, height: 1000 } as const;
/** A phone, and not full-page: the bottom navigation is `position: fixed`. */
const MOBILE = { width: 390, height: 900 } as const;

/** The symbol every upload walk resolves on the new-instruments step. */
const FIRST_SIGHTING = "SCHD";

type Theme = "light" | "dark";

async function open(browser: Browser, theme: Theme, mobile = false): Promise<Page> {
  const context = await browser.newContext({
    viewport: mobile ? MOBILE : DESKTOP,
    deviceScaleFactor: 2,
    isMobile: mobile,
    hasTouch: mobile,
    colorScheme: theme,
  });

  // Every shot is unmasked, and this line is what makes that true (spec
  // 0007): the policy seeds *masked*, and a fresh Playwright context has
  // never been toggled, so without it the whole shot list silently retakes
  // as pictures of dots — exactly the silent staleness this script exists to
  // prevent. The masking shots are the deliberate exception and set their
  // own cookie back.
  await context.addCookies([{ ...UNMASKED_COOKIE, url: BASE_URL }]);

  return context.newPage();
}

/**
 * What a browser toggled to show amounts carries. Spelled out, not imported
 * from `app/lib/masking.ts`: this script runs against a *served* app over
 * HTTP and shares no module with it — importing the client bundle for two
 * characters would be worse than a second copy. `masking.test.ts` pins the
 * vocabulary. No `path`: Playwright refuses a cookie carrying both `url` and
 * `path`, and `url` scopes it.
 */
const UNMASKED_COOKIE = { name: "masked", value: "0" } as const;

/**
 * Navigate and settle. Server-rendered with inline-SVG charts, so only the
 * document matters — but fonts land late enough to change a table's height,
 * and a mid-swap screenshot has the wrong metrics.
 */
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

/**
 * Every refusal says the same thing — this is not the demo household — so it
 * says it once, naming what it went looking for.
 */
function refuse(what: string): never {
  throw new Error(
    `Expected ${what}, and found none.\n` +
      "This script captures the demo household. Seed it first:\n" +
      "  node --env-file=<file> ./scripts/seed-demo.ts",
  );
}

/** Account ids, by kind, as this run of the seed happens to have numbered them. */
async function accountsByKind(pool: Pool): Promise<Accounts> {
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
async function currentPositions(pool: Pool, accountId: number): Promise<Position[]> {
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
 * A brokerage statement shaped like a Fidelity export: preamble row, dollar
 * signs, thousands separators, "Average Cost Basis". The diff it produces is
 * the point — every position restated unchanged except one bumped quantity;
 * one never-held instrument added (what puts a row on the new-instruments
 * step); one left out, which a statement means as "sold". One removal of
 * seven stays under the majority-removal confirmation — a different
 * screenshot, a different lesson.
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
 * Undo the walk's two writes — both right for the app to make, wrong for a
 * capture run to keep: each teaches the household something, and a taught
 * household is not the one these shots are of.
 *
 * **The resolved instrument.** Resolving is the flow's only early write (so
 * the alias survives an abandoned draft); the first walk teaches the
 * household `SCHD`, and every later walk then skips the step the screenshot
 * is of.
 *
 * **The saved column mapping.** Remembered against institution + header — the
 * feature — but a second run then arrives with all six selects prefilled, and
 * the guide's "before anything is mapped" caption sits under a fully mapped
 * form. Deleted by id above a pre-walk watermark, not truncated, so a mapping
 * the household legitimately has is never collateral.
 *
 * Neither row is referenced — the walk never commits — so removing both puts
 * the database back where the shots need it.
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

/**
 * Walk the four-step upload as far as a given step and shoot it; stops short
 * of recording (see header). Cleans up after itself: its two writes are
 * invisible from the call site, and a caller that forgot one would not fail —
 * it would quietly photograph the wrong screen on the next run.
 */
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

/**
 * Everything both passes need, looked up once and read from the database
 * rather than written down — the seed renumbers on every run.
 */
type Fixture = {
  accounts: Accounts;
  /** `?edit=` takes `<account>.<instrument>`. */
  editRow: string;
  ownerId: string;
  csv: string;
};

async function prepare(pool: Pool): Promise<Fixture> {
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
 * Open the owner filter's disclosure before shooting: it is a `<details>`,
 * loads closed, and a capture would photograph a pill reading "Alex Rivera" —
 * true, and not what these shots are of. Opening is the reader's own first
 * action; nothing hand-edited. The click targets the summary so a markup
 * change fails this rather than silently shooting the closed state.
 */
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

    // One owner, as a pair with the shot above (spec 0013): the filter is
    // only legible as a difference — smaller headline, owners named, pre-app
    // line withheld. At **All** deliberately: the withheld-history note only
    // appears on a range that would have shown the hand-typed points, and the
    // demo's are years old. A control invisible in the README is a feature
    // nobody knows exists.
    await visit(page, `/?owner=${ownerId}&range=all`);
    await openOwnerFilter(page);
    await shoot(page, `docs/screenshots/overview-owner-${theme}.png`);

    // The one range that is not a span of days (ADR-0006): the time axis,
    // time-of-day readout and cadence granularity are invisible on any other
    // preset.
    await visit(page, "/?range=1d");
    await shoot(page, `docs/screenshots/overview-1d-${theme}.png`);
    await visit(page, "/holdings");
    await shoot(page, `docs/screenshots/holdings-${theme}.png`);

    // The editor open on one row, cropped to the table: full-page at this
    // width renders the two boxes too small to read.
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
    // Holdings is the one screen that reflows from table to card stack below
    // 768px — with no committed image, the one case "retake on change" cannot
    // catch. Grouped, because the group heading, subtotal strip and grand
    // total are what the reflow must get right, and only visible grouped.
    await visit(phone, "/holdings?group=assetClass");
    // Scrolled to a subtotal: a phone shot is one viewport and the cards
    // start below the fold — unscrolled photographs everything except the
    // thing it is captioned as showing.
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
  // Grouped and unnarrowed: the guide describes grouping here, and adding a
  // filter would leave the reader working out which control did which.
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
      const fixture = await prepare(pool);
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

await main();
