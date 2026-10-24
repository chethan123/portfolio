/**
 * Retained dirty DOM state is what #400 lost, and `renderToStaticMarkup` has none — so this drives a
 * real Chromium against the built app (`react-router-serve`, not Vite dev: its dependency optimizer
 * reloads a cold page and wipes the dirty state) on its own committed database. Rebuilds every run
 * into the gitignored `build/`: a stale build would test old code. Each page waits for hydration
 * (a native POST is not the fix's path) and carries a window marker, so a reload fails the test.
 * Never `bringToFront()` or hide a page: a return to visible past `REENTRY_GRACE_MS` revalidates,
 * which rebases A's baseline for a reason outside the fix.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";

import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabase, type Database } from "~/lib/db.server";
import { createPool } from "../../server/db.ts";
import { applyPendingMigrations } from "../../server/migrations.ts";
import { TEST_DATABASE_URL } from "../support/database.ts";
import { makeFixtures } from "../support/fixtures.ts";

import type { Kysely } from "kysely";

const SETTLE = { timeout: 10_000 } as const;

let databaseName: string | undefined;
let db: Kysely<Database> | undefined;
let server: ChildProcess | undefined;
let browser: Browser | undefined;
let pageA: Page;
let pageB: Page;
let accountId: string;

function urlFor(name: string): string {
  const url = new URL(TEST_DATABASE_URL);
  url.pathname = `/${name}`;
  return url.toString();
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  if (address === null || typeof address === "string") throw new Error("No port was assigned.");
  return address.port;
}

/** Resolves on exit 0; any other end carries the captured output. */
function run(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited with ${code}:\n${output}`));
    });
  });
}

async function untilHealthy(origin: string, child: ChildProcess, deadline: number): Promise<void> {
  let failure: Error | undefined;
  child.once("error", (error) => (failure = error));
  child.once("exit", (code) => (failure = new Error(`The server exited with code ${code} before it was ready.`)));
  while (Date.now() < deadline) {
    if (failure !== undefined) throw failure;
    try {
      if ((await fetch(`${origin}/healthz`)).status === 200) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`The server at ${origin} never answered /healthz.`);
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  process.kill(-child.pid, "SIGTERM");
  const forced = setTimeout(() => process.kill(-child.pid!, "SIGKILL"), 5_000);
  await exited;
  clearTimeout(forced);
}

async function storedAccount() {
  return db!
    .selectFrom("account")
    .select(["name", "institution", "tax_treatment", "external_account_number"])
    .where("id", "=", accountId)
    .executeTakeFirstOrThrow();
}

// A select's label name includes its options, so only the text inputs can match exactly.
const field = (page: Page, label: string) => page.getByLabel(label, { exact: label !== "Tax treatment" });
const baseline = (page: Page) => page.locator('input[name="fromExternalAccountNumber"]');
const heading = (page: Page) => page.getByRole("heading", { level: 1 });

const isMounted = (page: Page) => page.evaluate(() => Reflect.get(window, "__mounted") === true);

/** Waits for React to attach to the save form, then marks the document: a reload loses the mark. */
async function hydrated(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const form = document.querySelector("form.panel-form");
    return form !== null && Object.keys(form).some((key) => key.startsWith("__reactFiber"));
  }, undefined, SETTLE);
  await page.evaluate(() => Reflect.set(window, "__mounted", true));
}

async function openAccount(page: Page, origin: string): Promise<void> {
  await page.goto(`${origin}/settings/accounts/${accountId}`);
  await hydrated(page);
}

/** Saved once the revalidated page title shows the posted name, with no reload on the way. */
async function save(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect.poll(() => heading(page).textContent(), SETTLE).toBe(name);
  expect(await isMounted(page)).toBe(true);
}

beforeAll(async () => {
  databaseName = `portfolio_browser_${randomBytes(4).toString("hex")}`;
  const url = urlFor(databaseName);

  const admin = createPool(TEST_DATABASE_URL);
  try {
    await admin.query(`create database ${databaseName}`);
  } finally {
    await admin.end();
  }

  const pool = createPool(url);
  try {
    await applyPendingMigrations(pool);
  } finally {
    await pool.end();
  }

  db = createDatabase(url);
  const { seedAccount } = makeFixtures(db);
  accountId = (await seedAccount({ name: "Brokerage", institution: "First", kind: "brokerage" })).id;

  const port = await freePort();
  const origin = `http://localhost:${port}`;
  // NODE_ENV: vitest sets "test". The PUBLIC_ORIGIN override matters too, vitest sets another.
  const env = { ...process.env, NODE_ENV: "production", DATABASE_URL: url, PUBLIC_ORIGIN: origin };
  await run("node_modules/.bin/react-router", ["build"], env);
  server = spawn("node_modules/.bin/react-router-serve", ["./server/server-build.ts"], {
    detached: true,
    stdio: "ignore",
    env: { ...env, PORT: String(port) },
  });
  await untilHealthy(origin, server, Date.now() + 60_000);

  try {
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE });
  } catch (cause) {
    throw new Error(
      "Cannot launch Chromium. Run `npx playwright install chromium`, or set CHROMIUM_EXECUTABLE " +
        "(docs/developing.md, the Chromium paragraph under \"Retake screenshots\").",
      { cause },
    );
  }
  const context = await browser.newContext();
  pageA = await context.newPage();
  pageB = await context.newPage();
  for (const page of [pageA, pageB]) await openAccount(page, origin);
}, 300_000);

afterAll(async () => {
  await browser?.close();
  if (server !== undefined) await stop(server);
  await db?.destroy();
  if (databaseName !== undefined) {
    const admin = createPool(TEST_DATABASE_URL);
    try {
      await admin.query(`drop database if exists ${databaseName} with (force)`);
    } finally {
      await admin.end();
    }
  }
}, 60_000);

describe("saving Settings → account in a tab that stays open", () => {
  it("two unrelated saves keep a number stored from another tab", async () => {
    const number = field(pageA, "Account number");
    await number.pressSequentially("T-1");
    await number.fill("");

    await field(pageB, "Account number").fill("Z-999");
    await pageB.getByRole("button", { name: "Save changes" }).click();
    await expect.poll(async () => (await storedAccount()).external_account_number, SETTLE).toBe("Z-999");
    expect(await isMounted(pageB)).toBe(true);

    const saves = [
      { name: "Brokerage 2", institution: "Second", taxTreatment: "tax_deferred" },
      { name: "Brokerage 3", institution: "Third", taxTreatment: "tax_deferred" },
    ];
    for (const [index, posted] of saves.entries()) {
      await field(pageA, "Name").fill(posted.name);
      await field(pageA, "Institution").fill(posted.institution);
      // Only the first save changes tax treatment: the second proves the select survived the redraw.
      if (index === 0) await field(pageA, "Tax treatment").selectOption(posted.taxTreatment);
      await save(pageA, posted.name);

      await expect.poll(() => number.inputValue(), SETTLE).toBe("Z-999");
      expect(await baseline(pageA).inputValue()).toBe("Z-999");
      expect(await storedAccount()).toEqual({
        name: posted.name,
        institution: posted.institution,
        tax_treatment: posted.taxTreatment,
        external_account_number: "Z-999",
      });
      expect(await field(pageA, "Tax treatment").inputValue()).toBe(posted.taxTreatment);
    }
  }, 60_000);

  it("a deliberate clear after the redraw still clears", async () => {
    await field(pageA, "Account number").fill("");
    await field(pageA, "Name").fill("Brokerage 4");
    await save(pageA, "Brokerage 4");

    await expect.poll(async () => (await storedAccount()).external_account_number, SETTLE).toBeNull();
    expect(await field(pageA, "Account number").inputValue()).toBe("");
    expect(await baseline(pageA).inputValue()).toBe("");
  }, 60_000);

  it("a refusal keeps the typed edits and the baseline", async () => {
    // B is not A: its page predates A's clear. Storing R-5 makes the stored row differ from A's baseline.
    await pageB.reload();
    await hydrated(pageB);
    await field(pageB, "Account number").fill("R-5");
    await pageB.getByRole("button", { name: "Save changes" }).click();
    await expect.poll(async () => (await storedAccount()).external_account_number, SETTLE).toBe("R-5");
    const before = await storedAccount();

    await field(pageA, "Account number").fill("Q-1");
    await field(pageA, "Name").fill("");
    await pageA.getByRole("button", { name: "Save changes" }).click();
    // Blank Name is refused by the schema before any number comparison.
    await expect.poll(() => field(pageA, "Name").getAttribute("aria-invalid"), SETTLE).toBe("true");

    expect(await isMounted(pageA)).toBe(true);
    expect(await field(pageA, "Account number").inputValue()).toBe("Q-1");
    expect(await field(pageA, "Name").inputValue()).toBe("");
    expect(await baseline(pageA).inputValue()).toBe("");
    expect(await storedAccount()).toEqual(before);
  }, 60_000);
});
