/**
 * Every committed screenshot, retaken in one command.
 *
 * The images under `docs/screenshots/` and `docs/guide/images/` are the real
 * application against the generated demo household — never a mock, never
 * hand-edited. That makes them the one thing in this repository that can go
 * stale silently: a screen changes, the picture of it does not, and nothing
 * fails. Until this script existed the only defence was a recipe a human
 * followed by hand, which is a defence that works until the day nobody has
 * twenty minutes.
 *
 * Run it from the repository root, against a throwaway database, with the
 * application already serving that database:
 *
 *   printf 'DATABASE_URL=postgres://portfolio:portfolio@127.0.0.1:55432/portfolio_demo\n' > .env.demo
 *   node --env-file=.env.demo ./server/migrate.ts
 *   node --env-file=.env.demo ./scripts/seed-demo.ts
 *   DATABASE_URL=postgres://portfolio:portfolio@127.0.0.1:55432/portfolio_demo npm run dev &
 *
 *   node --env-file=.env.demo ./scripts/capture-screenshots.ts
 *
 * The empty-instance shots the guide opens with cannot come from that database,
 * because it has data in it. They are taken against a second, *migrated but
 * unseeded* database, served the same way:
 *
 *   node --env-file=.env.fresh ./scripts/capture-screenshots.ts --first-run
 *
 * Three things here are deliberate and worth not undoing.
 *
 * **Nothing is hardcoded that the seed regenerates.** `account.id` is an
 * identity column and `seed-demo.ts` wipes with a plain `delete`, so ids climb
 * every time it runs. Accounts are therefore looked up by *kind*, and the row
 * the Holdings editor opens on is looked up by "has a cost basis" — never by a
 * number read off a previous run.
 *
 * **The statement the upload walkthrough is driven with is generated here, not
 * committed.** It has to restate what the account currently holds so the review
 * step renders an unchanged majority alongside one added, one updated and one
 * removed position. But the demo calendar is built from the wall clock
 * (`seed-demo.ts`, `buildCalendar(new Date())`), so quantities drift with the
 * day it was seeded. A CSV committed today would quietly turn "unchanged" rows
 * into "updated" ones a week later, and the diff screenshot would stop showing
 * what it is captioned as showing.
 *
 * **The upload flow is walked, never committed.** The mapping and review shots
 * need a live draft, and the draft dies with the commit — so the walk stops at
 * the review screen and the drafts are left to the 24-hour sweep. Recording the
 * statement would also change the demo household, which every other shot is of.
 */
import { chromium, type Browser, type Page } from "playwright";

import { loadConfig } from "../server/config.ts";
import { createPool } from "../server/db.ts";
import type { Pool } from "pg";

/** Where the application under capture is serving. */
const BASE_URL = process.env.BASE_URL ?? "http://127.0.0.1:5173";

/**
 * Playwright resolves its own bundled Chromium by default, which is what a
 * contributor running `npx playwright install chromium` gets. Sandboxes and CI
 * images that already carry a browser set this instead of downloading a second.
 */
const EXECUTABLE = process.env.CHROMIUM_EXECUTABLE;

/**
 * The README's shots.
 *
 * 1440 until Holdings gained a ninth column. The rail takes 280 and the canvas
 * margins 64, so at 1440 the panel offers a table wanting 1214 about 1096 — it
 * scrolls inside `.data-table-scroll`, and a full-page capture cuts the last
 * column off. A shot that shows a reader less than the screen holds is worse
 * than a wider shot: this is the narrowest round width at which the widest
 * table the application draws is whole.
 */
const DESKTOP = { width: 1600, height: 1000 } as const;
/** A phone, and not full-page: the bottom navigation is `position: fixed`. */
const MOBILE = { width: 390, height: 900 } as const;

/** The symbol every upload walk resolves on the new-instruments step. */
const FIRST_SIGHTING = "SCHD";

type Theme = "light" | "dark";

async function open(browser: Browser, theme: Theme, mobile = false): Promise<Page> {
  const page = await browser.newPage({
    viewport: mobile ? MOBILE : DESKTOP,
    deviceScaleFactor: 2,
    isMobile: mobile,
    hasTouch: mobile,
    colorScheme: theme,
  });
  return page;
}

/**
 * Navigate and wait for the page to settle. The application renders on the
 * server and the charts are inline SVG, so there is nothing to wait for beyond
 * the document itself — but fonts land late enough to change a table's height,
 * and a screenshot taken mid-swap has the wrong metrics.
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
 * Every refusal here says the same thing — that the database being captured is
 * not the demo household — so it says it once, naming what it went looking for.
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
 * A statement for the brokerage account, shaped like a Fidelity export: a
 * preamble row before the header, dollar signs, thousands separators, and a
 * cost basis the file calls "Average Cost Basis".
 *
 * The diff it produces is the point. Every position is restated unchanged
 * except one, whose quantity moves; one instrument the household has never held
 * is added, which is also what puts a row on the new-instruments step; and one
 * position is left out, which a statement means as "sold" and the review screen
 * lists in full. One removal out of seven stays well under the majority-removal
 * confirmation, which is a different screenshot and a different lesson.
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

  // The one instrument the household has never held. Its row is what the
  // new-instruments step exists to resolve.
  lines.push(
    [accountNumber, "Individual", FIRST_SIGHTING, '"SCHWAB US DIVIDEND EQUITY ETF"', "60", '"$1,629.00"', "$25.4000"].join(","),
  );

  return `${lines.join("\n")}\n`;
}

/**
 * Undo the one write the walk makes.
 *
 * Resolving an instrument is the upload flow's only early write — it lands
 * before the statement is recorded, precisely so that the alias survives an
 * abandoned draft. That is right for the application and wrong for a capture
 * run: the first walk teaches the household what `SCHD` is, and every later
 * walk then skips the step the screenshot is of. Nothing references the row,
 * because the walk never commits a statement, so removing it puts the database
 * back where the shot needs it.
 */
async function forgetFirstSighting(pool: Pool): Promise<void> {
  await pool.query(`delete from instrument where symbol = $1`, [FIRST_SIGHTING]);
}

/**
 * Walk the four-step upload as far as a given step and shoot it. Stops short of
 * recording: see the header.
 */
async function walkUpload(
  page: Page,
  csv: string,
  accountId: number,
  shots: { columnsBlank?: string; columnsMapped?: string; instruments?: string; review?: string },
): Promise<void> {
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
 * Everything both passes need looked up once: which account is which, the
 * statement to drive the upload with, the row the Holdings editor opens on, and
 * whose name the owner filter uses. All of it is read from the database rather
 * than written down, because the seed renumbers on every run.
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

/** The README's shots: both themes, plus the two phone ones. */
async function captureReadme(browser: Browser, pool: Pool, fixture: Fixture): Promise<void> {
  console.log("\nREADME — docs/screenshots/");
  const { accounts, editRow, csv } = fixture;
  const brokerage = accounts.brokerage;

  for (const theme of ["light", "dark"] as const) {
    const page = await open(browser, theme);
    await visit(page, "/");
    await shoot(page, `docs/screenshots/overview-${theme}.png`);
    await visit(page, "/holdings");
    await shoot(page, `docs/screenshots/holdings-${theme}.png`);

    // The editor open on one row. Cropped to the table rather than the page:
    // at this width a full-page shot renders the two boxes too small to read.
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

    await walkUpload(page, csv, brokerage, {
      columnsBlank: `docs/screenshots/upload-mapping-${theme}.png`,
      review: `docs/screenshots/upload-review-${theme}.png`,
    });
    await forgetFirstSighting(pool);
    await page.close();

    const phone = await open(browser, theme, true);
    await visit(phone, "/");
    await shoot(phone, `docs/screenshots/overview-mobile-${theme}.png`, false);
    await visit(phone, "/analysis");
    await shoot(phone, `docs/screenshots/analysis-mobile-${theme}.png`, false);
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

  await visit(page, "/holdings");
  await shoot(page, "docs/guide/images/holdings.png");
  await visit(page, `/holdings?owner=${ownerId}&group=assetClass`);
  await shoot(page, "docs/guide/images/holdings-grouped.png");
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

  await visit(page, "/upload");
  await shoot(page, "docs/guide/images/upload-1-account-and-file.png");
  await walkUpload(page, csv, brokerage, {
    columnsBlank: "docs/guide/images/upload-2-columns-blank.png",
    columnsMapped: "docs/guide/images/upload-2-columns-mapped.png",
    instruments: "docs/guide/images/upload-3-instruments.png",
    review: "docs/guide/images/upload-4-review.png",
  });
  await forgetFirstSighting(pool);
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
