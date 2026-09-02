/**
 * The household's own settings — capital gains rate (DESIGN.md §8.1, §8.4),
 * masking policy (ADR-0002), refresh cadence (§6.2). Every rule about what a
 * rate is lives here, so a second caller cannot get a different answer than
 * the Settings screen.
 *
 * **A table, not an environment variable**: `.env.example` describes the
 * deployment, changed by a restart; a tax rate is the household's own number,
 * moving when their bracket does, changed by the person reading the figure
 * (`0005_app_setting.sql` carries the argument).
 *
 * **The row always exists** — the migration seeds it, the schema allows one —
 * so a read is `executeTakeFirstOrThrow`, never an invented default: a
 * missing row and a rate of zero look identical once a default is applied,
 * and one is a bug worth hearing about. The cost, written down: a hand-deleted
 * row takes the Analysis screen and the Settings page that would repair it
 * down together; the repair is `insert into app_setting default values;`,
 * recorded here because the screen that would have told you is down.
 *
 * Every exported query takes an optional `db`; tests pass a rolled-back
 * transaction.
 */
import { z } from "zod";

import { getDb, type Database } from "./db.server.ts";
import { parseInput, percentRate } from "./input.server.ts";
import { maskingPolicyValues, type MaskingPolicy } from "./masking.ts";

import type { Kysely } from "kysely";

/**
 * A percentage as typed, all the way down — `percentRate` and the migration
 * have why the conversion to a multiplier waits for the place that multiplies.
 */
export const capitalGainsRateInput = z.object({
  capitalGainsRate: percentRate("A capital gains rate"),
});

export type CapitalGainsRateInput = z.infer<typeof capitalGainsRateInput>;

/**
 * The rate Analysis applies to a taxable unrealized gain, as a decimal string
 * percentage (`"23.800000"`) — a string because `numeric` crosses as digits
 * (§4.1), and nothing downstream should `Number` it either.
 */
export async function readCapitalGainsRate(db: Kysely<Database> = getDb()): Promise<string> {
  const row = await db
    .selectFrom("app_setting")
    .select("capital_gains_rate")
    .executeTakeFirstOrThrow();

  return row.capital_gains_rate;
}

/**
 * Record a new rate. An update, not an upsert: the row is seeded and the
 * schema permits one, so there is no case where this should create.
 *
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
 * A `z.enum` over the one list of values, not a second copy, so the check
 * constraint, the form's options and this validator cannot disagree about
 * what a policy is (`masking.ts`).
 */
export const maskingPolicyInput = z.object({
  maskingPolicy: z.enum(maskingPolicyValues, {
    message: "Choose a masking policy.",
  }),
});

export type MaskingPolicyInput = z.infer<typeof maskingPolicyInput>;

/**
 * What an untoggled browser opens in (spec 0007, ADR-0002), read with the
 * same `executeTakeFirstOrThrow` for the header's reason. Only half of "is
 * this screen masked": what the browser last did is a cookie, and the two
 * combine in `resolveMasked` — this module reads a row, and the precedence
 * between a row and a cookie is a rule about a request.
 */
export async function readMaskingPolicy(
  db: Kysely<Database> = getDb(),
): Promise<MaskingPolicy> {
  const row = await db
    .selectFrom("app_setting")
    .select("masking_policy")
    .executeTakeFirstOrThrow();

  // The check constraint is what makes this cast true; `0007` and
  // `masking.ts` are kept in step by hand (`AccountKind`'s arrangement).
  return row.masking_policy as MaskingPolicy;
}

/**
 * Record a new policy — an update of this column alone: the row is shared,
 * and a writer setting the whole row would silently reset a figure Analysis
 * reads. What this does *not* do: clear the browser's state cookie — that is
 * a response header and belongs to the route (ADR-0002); this module never
 * sees a request.
 *
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

/** The check constraint's bounds, stated once for validator and form alike.
 * A day is the ceiling: a longer cadence is a poller turned off without
 * saying so. */
export const REFRESH_CADENCE_BOUNDS = { min: 1, max: 1440 } as const;

/**
 * A whole number of minutes. `Number.parseInt`, unlike every money field: a
 * cadence is not money — the column is `integer`, the driver hands it over as
 * a number, and nothing multiplies it into a figure a person reads.
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
 * Minutes the poller waits between refreshes (DESIGN.md §6.2) — every tick,
 * not only the in-session ones: quotes are asked for while the market is open
 * and the backfill batch rides a tick at any hour (ADR-0011). Read with the
 * same `executeTakeFirstOrThrow` for the
 * header's reason. The poller reads this before scheduling every tick rather
 * than once at start-up — the whole of how a save takes effect: no restart,
 * no signal. The cost is one single-row read per cycle; the honest
 * consequence — a change applies at the *next* scheduling, up to one old
 * cadence away — is printed on the form that edits it.
 */
export async function readRefreshCadence(db: Kysely<Database> = getDb()): Promise<number> {
  const row = await db
    .selectFrom("app_setting")
    .select("refresh_cadence_minutes")
    .executeTakeFirstOrThrow();

  return row.refresh_cadence_minutes;
}

/**
 * Record a new cadence — an update of this column alone, like the two
 * writers above: the row is seeded and shared.
 *
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
