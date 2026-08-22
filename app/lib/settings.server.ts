/**
 * The household's own settings — today that is one figure, the capital gains
 * rate (DESIGN.md §8.1, §8.4).
 *
 * Read and written like `people.server.ts`: the route above translates a form
 * into arguments and a refusal into a message, and every rule about what a rate
 * is lives here, so a second caller cannot get a different answer than the
 * Settings screen does.
 *
 * **Why a table rather than an environment variable.** Everything in
 * `.env.example` describes the deployment — where the database is, which
 * timezone a close is stamped in, whether the login gate is on — and changing
 * one of those is a restart either way. A tax rate is not that: it is the
 * household's own number, it moves when their bracket or their state does, and
 * the person who wants it changed is the person reading the figure it produced.
 * `0005_app_setting.sql` carries the same argument beside the schema.
 *
 * **The row always exists.** The migration seeds it and the schema allows only
 * one, so a read is a `selectFrom(...).executeTakeFirstOrThrow()` rather than a
 * default invented here. A settings row that had gone missing and a rate of
 * zero look identical once a default is applied, and one of them is a bug worth
 * hearing about.
 */
import { z } from "zod";

import { getDb, type Database } from "./db.server.ts";
import { parseInput, percentRate } from "./input.server.ts";

import type { Kysely } from "kysely";

/**
 * What the Settings form submits: a percentage, as typed.
 *
 * A percentage rather than a fraction all the way down — see `percentRate` and
 * the migration for why the conversion to a multiplier is deferred to the one
 * place that multiplies.
 */
export const capitalGainsRateInput = z.object({
  capitalGainsRate: percentRate("A capital gains rate"),
});

export type CapitalGainsRateInput = z.infer<typeof capitalGainsRateInput>;

/**
 * The rate the Analysis screen applies to an unrealized gain in a taxable
 * account, as a decimal string percentage — `"23.800000"`.
 *
 * A string because it is a `numeric` column and the pool's type-parser override
 * hands those over as digits (§4.1). Nothing here calls `Number` on it, and
 * neither should anything downstream.
 *
 * @param db a handle to read through. Defaults to the process-wide one; tests
 *           pass a transaction they roll back.
 */
export async function readCapitalGainsRate(db: Kysely<Database> = getDb()): Promise<string> {
  const row = await db
    .selectFrom("app_setting")
    .select("capital_gains_rate")
    .executeTakeFirstOrThrow();

  return row.capital_gains_rate;
}

/**
 * Record a new rate.
 *
 * An update rather than an upsert: the row is seeded by the migration and the
 * schema permits exactly one, so there is no case where this should create.
 *
 * @param raw the submitted fields, unvalidated. Validating here rather than in
 *            the route is what keeps a second caller from skipping the rules.
 * @throws {ValidationError} with a message per bad field.
 * @returns the stored rate, as the column now holds it.
 */
export async function saveCapitalGainsRate(
  raw: unknown,
  db: Kysely<Database> = getDb(),
): Promise<string> {
  const input = parseInput(capitalGainsRateInput, raw);

  const row = await db
    .updateTable("app_setting")
    .set({ capital_gains_rate: input.capitalGainsRate })
    .returning("capital_gains_rate")
    .executeTakeFirstOrThrow();

  return row.capital_gains_rate;
}
