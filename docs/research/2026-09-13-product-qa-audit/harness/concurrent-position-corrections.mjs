/**
 * Reproduces QA-22: two accepted corrections to different holdings in one account can lose data.
 *
 * Setup assumptions:
 * - DATABASE_URL names a new, disposable PostgreSQL database with every repository migration applied.
 * - A production build is running at AUDIT_BASE with AUTH_GATE=none and the same DATABASE_URL.
 * - Run from the repository root with Node 24+ after installing package dependencies.
 *
 * Example (credentials intentionally supplied by the operator, never embedded here):
 *   AUDIT_CONFIRM_ISOLATED_DB=YES \
 *   DATABASE_URL='postgresql://...' \
 *   AUDIT_BASE='http://127.0.0.1:3000' \
 *   node docs/research/2026-09-13-product-qa-audit/harness/concurrent-position-corrections.mjs
 *
 * The harness emits its JSON ledger to stdout. The race is timing-dependent; a clean implementation
 * should retain both desired quantities in every round. No trigger, delay, application import, or
 * server instrumentation is used.
 */
import pg from "pg";

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;
const baseInput = process.env.AUDIT_BASE;
const rounds = Number(process.env.AUDIT_ROUNDS ?? "25");

if (process.env.AUDIT_CONFIRM_ISOLATED_DB !== "YES") {
  throw new Error("Set AUDIT_CONFIRM_ISOLATED_DB=YES after verifying DATABASE_URL is disposable.");
}
if (!databaseUrl) throw new Error("DATABASE_URL is required.");
if (!baseInput) throw new Error("AUDIT_BASE is required.");
if (!Number.isSafeInteger(rounds) || rounds < 1 || rounds > 1_000) {
  throw new Error("AUDIT_ROUNDS must be an integer from 1 through 1000.");
}

const base = new URL(baseInput);
if (
  !/^https?:$/.test(base.protocol) ||
  base.username ||
  base.password ||
  base.pathname !== "/" ||
  base.search ||
  base.hash
) {
  throw new Error("AUDIT_BASE must be a bare HTTP(S) origin with no credentials or path.");
}

const pool = new Pool({ connectionString: databaseUrl });

async function seed() {
  const client = await pool.connect();
  try {
    await client.query("begin");

    const accountCount = Number(
      (await client.query("select count(*)::int as count from account")).rows[0].count,
    );
    if (accountCount !== 0) {
      throw new Error(`Refusing to seed: the target database already has ${accountCount} account(s).`);
    }

    const triggerCount = Number(
      (
        await client.query(`
          select count(*)::int as count
          from pg_trigger
          where tgrelid = 'position_set'::regclass
            and not tgisinternal
        `)
      ).rows[0].count,
    );
    if (triggerCount !== 0) {
      throw new Error("Refusing to run with a user-defined trigger on position_set.");
    }

    const owner = (
      await client.query("insert into person (name) values ($1) returning id::text", [
        "QA-22 race owner",
      ])
    ).rows[0];
    const classification = (
      await client.query(
        "insert into classification (name, asset_class) values ($1, 'equity') returning id::text",
        ["QA-22 race classification"],
      )
    ).rows[0];
    const instruments = (
      await client.query(
        `
          insert into instrument (symbol, name, quote_type, price_source, classification_id)
          values
            ('NATX', 'Natural race X', 'EQUITY', 'feed', $1),
            ('NATY', 'Natural race Y', 'EQUITY', 'feed', $1)
          returning id::text, symbol
        `,
        [classification.id],
      )
    ).rows;
    const instrumentBySymbol = Object.fromEntries(instruments.map((row) => [row.symbol, row.id]));
    const account = (
      await client.query(
        `
          insert into account
            (name, institution, kind, owner_id, tax_treatment, external_account_number, closed_at)
          values ($1, $2, 'brokerage', $3, 'taxable', null, null)
          returning id::text
        `,
        ["QA-22 race account", "QA harness", owner.id],
      )
    ).rows[0];
    const positionSet = (
      await client.query(
        `
          insert into position_set (account_id, as_of_date, source)
          values ($1, date '2000-01-01', 'upload')
          returning id::text
        `,
        [account.id],
      )
    ).rows[0];

    await client.query(
      `
        insert into holding
          (position_set_id, instrument_id, quantity, cost_basis_per_share)
        values ($1, $2, 1, null), ($1, $3, 1, null)
      `,
      [positionSet.id, instrumentBySymbol.NATX, instrumentBySymbol.NATY],
    );
    await client.query("commit");

    return {
      accountId: account.id,
      xId: instrumentBySymbol.NATX,
      yId: instrumentBySymbol.NATY,
    };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function postCorrection(accountId, instrumentId, quantity) {
  const target = `${accountId}.${instrumentId}`;
  const url = new URL(`/holdings?edit=${target}`, base);
  const response = await fetch(url, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: base.origin,
    },
    body: new URLSearchParams({ quantity: String(quantity), costBasisPerShare: "" }),
  });
  const location = response.headers.get("location");
  const saved = location === null ? null : new URL(location, base).searchParams.get("saved");

  return { status: response.status, accepted: response.status === 302 && saved === target };
}

async function currentQuantities(accountId) {
  const result = await pool.query(
    `
      select i.symbol, h.quantity::text as quantity
      from holding h
      join instrument i on i.id = h.instrument_id
      where h.position_set_id = (
        select ps.id
        from position_set ps
        where ps.account_id = $1
        order by ps.as_of_date desc, ps.created_at desc, ps.id desc
        limit 1
      )
      order by i.symbol
    `,
    [accountId],
  );

  return Object.fromEntries(result.rows.map((row) => [row.symbol, row.quantity]));
}

async function positionSetCount(accountId) {
  const result = await pool.query(
    "select count(*)::int as count from position_set where account_id = $1",
    [accountId],
  );
  return Number(result.rows[0].count);
}

try {
  const health = await fetch(base, { redirect: "manual" });
  if (health.status !== 200) throw new Error(`AUDIT_BASE health check returned HTTP ${health.status}.`);

  const { accountId, xId, yId } = await seed();
  const ledger = [];

  // Warm both editor paths before measuring only the overlapping POST actions.
  await Promise.all([
    fetch(new URL(`/holdings?edit=${accountId}.${xId}`, base)),
    fetch(new URL(`/holdings?edit=${accountId}.${yId}`, base)),
  ]);

  for (let round = 1; round <= rounds; round += 1) {
    const desiredX = 1_000 + round;
    const desiredY = 2_000 + round;
    const beforeCount = await positionSetCount(accountId);
    const responses = await Promise.all([
      postCorrection(accountId, xId, desiredX),
      postCorrection(accountId, yId, desiredY),
    ]);
    const afterCount = await positionSetCount(accountId);
    const actual = await currentQuantities(accountId);
    const expected = {
      NATX: `${desiredX}.00000000`,
      NATY: `${desiredY}.00000000`,
    };

    if (!responses.every((response) => response.accepted)) {
      throw new Error(`Round ${round}: a correction did not return its success redirect.`);
    }
    if (afterCount - beforeCount !== 2) {
      throw new Error(`Round ${round}: expected two appended position sets.`);
    }

    ledger.push({
      round,
      responses,
      positionSetsWritten: afterCount - beforeCount,
      expected,
      actual,
      lostUpdate: actual.NATX !== expected.NATX || actual.NATY !== expected.NATY,
    });
  }

  const lostUpdates = ledger.filter((entry) => entry.lostUpdate);
  process.stdout.write(
    `${JSON.stringify(
      {
        finding: "QA-22",
        method: "Concurrent production HTTP actions with no delay, trigger, or app instrumentation",
        rounds: ledger.length,
        acceptedResponses: ledger.length * 2,
        lostUpdateRounds: lostUpdates.length,
        firstLossRound: lostUpdates[0]?.round ?? null,
        ledger,
      },
      null,
      2,
    )}\n`,
  );

  if (lostUpdates.length === 0) process.exitCode = 2;
} finally {
  await pool.end();
}
