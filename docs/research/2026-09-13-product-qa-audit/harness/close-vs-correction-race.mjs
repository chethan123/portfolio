/**
 * Reproduces QA-25: a position correction can be accepted while its account is being closed.
 *
 * This is a timing-widened test, not a natural-frequency measurement. It installs a test-only
 * BEFORE INSERT trigger that sleeps for 750 ms on manual position_set inserts, starts the correction,
 * waits 150 ms, and then posts the close action. The trigger is removed before the script exits.
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
 *   node docs/research/2026-09-13-product-qa-audit/harness/close-vs-correction-race.mjs
 *
 * The harness emits a JSON transcript to stdout and exits 2 if the widened schedule does not expose
 * the bug. It intentionally mutates schema and data, which is why an empty database and explicit
 * acknowledgement are mandatory.
 */
import pg from "pg";

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;
const baseInput = process.env.AUDIT_BASE;
const insertDelayMs = 750;
const closeLaunchDelayMs = 150;
const triggerName = "qa25_delay_manual_position_set";
const functionName = "qa25_delay_manual_position_set";

if (process.env.AUDIT_CONFIRM_ISOLATED_DB !== "YES") {
  throw new Error("Set AUDIT_CONFIRM_ISOLATED_DB=YES after verifying DATABASE_URL is disposable.");
}
if (!databaseUrl) throw new Error("DATABASE_URL is required.");
if (!baseInput) throw new Error("AUDIT_BASE is required.");

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

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

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
      throw new Error("Refusing to run with a pre-existing user trigger on position_set.");
    }

    const functionExists = (
      await client.query("select to_regprocedure($1) is not null as exists", [`${functionName}()`])
    ).rows[0].exists;
    if (functionExists) throw new Error(`Refusing to replace pre-existing ${functionName}().`);

    const owner = (
      await client.query("insert into person (name) values ($1) returning id::text", [
        "QA-25 close-race owner",
      ])
    ).rows[0];
    const classification = (
      await client.query(
        "insert into classification (name, asset_class) values ($1, 'equity') returning id::text",
        ["QA-25 close-race classification"],
      )
    ).rows[0];
    const instrument = (
      await client.query(
        `
          insert into instrument (symbol, name, quote_type, price_source, classification_id)
          values ('CLOSERACE', 'Close race asset', 'EQUITY', 'feed', $1)
          returning id::text
        `,
        [classification.id],
      )
    ).rows[0];
    const account = (
      await client.query(
        `
          insert into account
            (name, institution, kind, owner_id, tax_treatment, external_account_number, closed_at)
          values ($1, $2, 'brokerage', $3, 'taxable', null, null)
          returning id::text
        `,
        ["QA-25 close-race account", "QA harness", owner.id],
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
        values ($1, $2, 100, 5)
      `,
      [positionSet.id, instrument.id],
    );
    await client.query("commit");

    return { accountId: account.id, instrumentId: instrument.id };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function installTimingTrigger() {
  await pool.query(`
    create function ${functionName}()
    returns trigger
    language plpgsql
    as $$
    begin
      if new.source = 'manual' then
        perform pg_sleep(${insertDelayMs / 1_000});
      end if;
      return new;
    end
    $$
  `);
  await pool.query(`
    create trigger ${triggerName}
    before insert on position_set
    for each row execute function ${functionName}()
  `);
}

async function removeTimingTrigger() {
  await pool.query(`drop trigger if exists ${triggerName} on position_set`);
  await pool.query(`drop function if exists ${functionName}()`);
}

async function post(path, form) {
  const response = await fetch(new URL(path, base), {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: base.origin,
    },
    body: new URLSearchParams(form),
  });

  return { status: response.status, location: response.headers.get("location") };
}

async function readResult(accountId) {
  const account = (
    await pool.query("select closed_at is not null as closed from account where id = $1", [accountId])
  ).rows[0];
  const positionSets = (
    await pool.query(
      `
        select source, as_of_date::text as "asOf"
        from position_set
        where account_id = $1
        order by id
      `,
      [accountId],
    )
  ).rows;
  const currentRows = Number(
    (
      await pool.query(
        "select count(*)::int as count from holding_valued where account_id = $1",
        [accountId],
      )
    ).rows[0].count,
  );
  const historical = (
    await pool.query(
      `
        select quantity::text as quantity, value::text as value
        from holding_valued_at(current_date)
        where account_id = $1
      `,
      [accountId],
    )
  ).rows;

  return {
    accountClosed: account.closed,
    positionSets,
    currentRows,
    closeDateHistorical: historical,
  };
}

try {
  const health = await fetch(base, { redirect: "manual" });
  if (health.status !== 200) throw new Error(`AUDIT_BASE health check returned HTTP ${health.status}.`);

  const { accountId, instrumentId } = await seed();

  // Warm both routes so module loading does not consume the 150 ms scheduling gap.
  await Promise.all([
    fetch(new URL(`/holdings?edit=${accountId}.${instrumentId}`, base)),
    fetch(new URL("/settings/accounts", base)),
  ]);
  await installTimingTrigger();

  const startedAt = Date.now();
  const correction = post(`/holdings?edit=${accountId}.${instrumentId}`, {
    quantity: "125",
    costBasisPerShare: "5",
  });
  const close = (async () => {
    await delay(closeLaunchDelayMs);
    return post(`/settings/accounts/${accountId}`, { intent: "close", confirmClose: "true" });
  })();
  const [correctionResponse, closeResponse] = await Promise.all([correction, close]);
  const state = await readResult(accountId);
  const reproduced =
    correctionResponse.status === 302 &&
    correctionResponse.location === `/holdings?saved=${accountId}.${instrumentId}` &&
    closeResponse.status === 302 &&
    closeResponse.location === "/settings/accounts" &&
    state.accountClosed === true &&
    state.positionSets.length === 2 &&
    state.currentRows === 0 &&
    state.closeDateHistorical.some((row) => row.quantity === "125.00000000");

  process.stdout.write(
    `${JSON.stringify(
      {
        finding: "QA-25",
        timingIntervention: {
          testOnlyTrigger: `BEFORE INSERT on position_set; manual writes sleep ${insertDelayMs} ms`,
          closeLaunchDelayMs,
        },
        elapsedMs: Date.now() - startedAt,
        responses: { correction: correctionResponse, close: closeResponse },
        state,
        reproduced,
      },
      null,
      2,
    )}\n`,
  );

  if (!reproduced) process.exitCode = 2;
} finally {
  await removeTimingTrigger().catch(() => {});
  await pool.end();
}
