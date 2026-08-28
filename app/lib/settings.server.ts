/**
 * The household's own settings — the capital gains rate (DESIGN.md §8.1, §8.4),
 * the masking policy (ADR-0002), and the refresh cadence (§6.2).
 *
 * Read and written like `people.server.ts`: the route above translates a form
 * into arguments and a refusal into a message, and every rule about what a rate
 * is lives here, so a second caller cannot get a different answer than the
 * Settings screen does.
 *
 * **Why a table rather than an environment variable.** Everything in
 * `.env.example` describes the deployment — where the database is, which
 * timezone a close is stamped in, whether a gate fronts the app — and changing
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
 *
 * The cost of that choice, written down rather than discovered: if the row is
 * ever deleted by hand, both the Analysis screen and the Settings page that
 * would repair it fail together. The repair is one statement —
 * `insert into app_setting default values;` — and it is here because the screen
 * that would have told you is the one that is down.
 *
 * Every exported query takes an optional `db` handle: it defaults to the
 * process-wide one, and tests pass a transaction they roll back.
 */
import { z } from "zod";

import { getDb, type Database } from "./db.server.ts";
import { parseInput, percentRate } from "./input.server.ts";
import { maskingPolicyValues, type MaskingPolicy } from "./masking.ts";

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
 * @param raw the submitted fields, unvalidated.
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

/**
 * What the Display form submits: which of the three answers the household gave.
 *
 * A `z.enum` over the one list of values rather than a second copy of them, so
 * that the schema's check constraint, the form's options and this validator
 * cannot disagree about what a policy is (`masking.ts`).
 */
export const maskingPolicyInput = z.object({
  maskingPolicy: z.enum(maskingPolicyValues, {
    message: "Choose a masking policy.",
  }),
});

export type MaskingPolicyInput = z.infer<typeof maskingPolicyInput>;

/**
 * What a browser that has not been toggled yet opens in (spec 0007, ADR-0002).
 *
 * Read from the same single row as the rate above and with the same
 * `executeTakeFirstOrThrow`, for the same reason: the migration seeds it, so a
 * default invented here would make a settings row that had gone missing
 * indistinguishable from a household that had chosen to open masked.
 *
 * This is only half of "is this screen masked" — it is the answer for a browser
 * with nothing to say. What that browser last did is a cookie, and the two are
 * combined by `resolveMasked` rather than here: this module reads a row, and
 * the precedence between a row and a cookie is a rule about a request.
 */
export async function readMaskingPolicy(
  db: Kysely<Database> = getDb(),
): Promise<MaskingPolicy> {
  const row = await db
    .selectFrom("app_setting")
    .select("masking_policy")
    .executeTakeFirstOrThrow();

  // The column is `text` with a check constraint, so it arrives typed as a
  // string. The constraint is what makes this cast true, and `0007` and
  // `masking.ts` are kept in step by hand — which is the same arrangement
  // `AccountKind` already has with `account_kind_valid`.
  return row.masking_policy as MaskingPolicy;
}

/**
 * Record a new policy.
 *
 * An update rather than an upsert, and of this column alone: the row is seeded
 * by the migration and shared with the capital gains rate, so a writer that set
 * the whole row would silently reset a figure the Analysis screen reads.
 *
 * Note what this does *not* do. Changing the policy has to clear the browser's
 * state cookie — otherwise the setting appears to do nothing on the browser that
 * changed it, and the stale cookie keeps the lifetime the old policy gave it
 * (ADR-0002). That is a header on a response, so it belongs to the route rather
 * than here; this module never sees a request.
 *
 * @param raw the submitted fields, unvalidated.
 * @throws {ValidationError} with a message per bad field.
 * @returns the stored policy, as the column now holds it.
 */
export async function saveMaskingPolicy(
  raw: unknown,
  db: Kysely<Database> = getDb(),
): Promise<MaskingPolicy> {
  const input = parseInput(maskingPolicyInput, raw);

  const row = await db
    .updateTable("app_setting")
    .set({ masking_policy: input.maskingPolicy })
    .returning("masking_policy")
    .executeTakeFirstOrThrow();

  return row.masking_policy as MaskingPolicy;
}

/** The bounds the schema's check constraint enforces, stated once and read by
 * the validator and the form's `min`/`max` alike. A day is the ceiling because
 * a cadence longer than one is a poller that has been turned off without
 * saying so. */
export const REFRESH_CADENCE_BOUNDS = { min: 1, max: 1440 } as const;

/**
 * What the Prices form submits: a whole number of minutes.
 *
 * `Number.parseInt` rather than the decimal-string discipline every money field
 * keeps, because a cadence is not money — the column is `integer`, the driver
 * hands it over as a JavaScript number, and nothing ever multiplies it into a
 * figure a person reads.
 */
export const refreshCadenceInput = z.object({
  refreshCadenceMinutes: z
    .string({ message: "A refresh cadence is required." })
    .trim()
    .superRefine((value, ctx) => {
      const refuse = (message: string) => ctx.addIssue({ code: "custom", message });

      if (value === "") {
        refuse("A refresh cadence is required.");
      } else if (!/^\d+$/.test(value)) {
        refuse("A refresh cadence must be a whole number of minutes, like 15.");
      } else {
        const minutes = Number.parseInt(value, 10);
        if (minutes < REFRESH_CADENCE_BOUNDS.min || minutes > REFRESH_CADENCE_BOUNDS.max) {
          refuse(
            `A refresh cadence must be between ${REFRESH_CADENCE_BOUNDS.min} and ` +
              `${REFRESH_CADENCE_BOUNDS.max} minutes.`,
          );
        }
      }
    })
    .transform((value) => Number.parseInt(value, 10)),
});

export type RefreshCadenceInput = z.infer<typeof refreshCadenceInput>;

/**
 * How many minutes the poller waits between quote refreshes while the market is
 * open (DESIGN.md §6.2).
 *
 * Read from the same single row with the same `executeTakeFirstOrThrow` as the
 * rate above, for the same reason: the migration seeds it, so a default
 * invented here would make a settings row that had gone missing
 * indistinguishable from a household that had chosen the default.
 *
 * The poller reads this before scheduling every tick rather than once at
 * start-up, which is the whole of how a save takes effect: there is no restart
 * to perform and no signal to send, in this process or any other holding the
 * advisory lock. The cost is one single-row read per cycle, and the honest
 * consequence — a change applies when the *next* refresh is scheduled, up to
 * one old cadence away — is printed on the form that edits it.
 */
export async function readRefreshCadence(db: Kysely<Database> = getDb()): Promise<number> {
  const row = await db
    .selectFrom("app_setting")
    .select("refresh_cadence_minutes")
    .executeTakeFirstOrThrow();

  return row.refresh_cadence_minutes;
}

/**
 * Record a new cadence.
 *
 * An update rather than an upsert, of this column alone, like the two writers
 * above: the row is seeded and shared, and a writer that set the whole row
 * would silently reset figures other screens read.
 *
 * @param raw the submitted fields, unvalidated.
 * @throws {ValidationError} with a message per bad field.
 * @returns the stored cadence, as the column now holds it.
 */
export async function saveRefreshCadence(
  raw: unknown,
  db: Kysely<Database> = getDb(),
): Promise<number> {
  const input = parseInput(refreshCadenceInput, raw);

  const row = await db
    .updateTable("app_setting")
    .set({ refresh_cadence_minutes: input.refreshCadenceMinutes })
    .returning("refresh_cadence_minutes")
    .executeTakeFirstOrThrow();

  return row.refresh_cadence_minutes;
}
