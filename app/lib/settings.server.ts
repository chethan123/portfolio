// Household settings: capital gains rate (DESIGN.md §8.1, §8.4), masking policy (ADR-0002),
// refresh cadence (§6.2). Single seeded row (0005_app_setting.sql) — reads use
// executeTakeFirstOrThrow, never a default, since a missing row is a bug, not a zero rate.
import { z } from "zod";

import { getDb, type Database } from "./db.server.ts";
import { parseInput, percentRate } from "./input.server.ts";
import { maskingPolicyValues, type MaskingPolicy } from "./masking.ts";

import type { Kysely } from "kysely";

// Percentage as typed, all the way down — converts to a multiplier only where it's applied.
export const capitalGainsRateInput = z.object({
  capitalGainsRate: percentRate("A capital gains rate"),
});

export type CapitalGainsRateInput = z.infer<typeof capitalGainsRateInput>;

// Decimal string percentage (e.g. "23.800000") — numeric crosses as digits (§4.1), never Number().
export async function readCapitalGainsRate(db: Kysely<Database> = getDb()): Promise<string> {
  const row = await db
    .selectFrom("app_setting")
    .select("capital_gains_rate")
    .executeTakeFirstOrThrow();

  return row.capital_gains_rate;
}

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

// z.enum over masking.ts's one list, so this can't disagree with the check constraint or the form.
export const maskingPolicyInput = z.object({
  maskingPolicy: z.enum(maskingPolicyValues, {
    message: "Choose a masking policy.",
  }),
});

export type MaskingPolicyInput = z.infer<typeof maskingPolicyInput>;

// Only half of "is this screen masked" — the browser's last toggle is a cookie; resolveMasked
// combines the two (that precedence is a request-level rule, not this module's).
export async function readMaskingPolicy(
  db: Kysely<Database> = getDb(),
): Promise<MaskingPolicy> {
  const row = await db
    .selectFrom("app_setting")
    .select("masking_policy")
    .executeTakeFirstOrThrow();

  // Check constraint makes this cast true; spec 0007 and masking.ts are kept in step by hand.
  return row.masking_policy as MaskingPolicy;
}

// Updates this column alone (row is shared with other settings). Doesn't clear the browser's
// state cookie — that's a response header the route sets (ADR-0002); this module sees no request.
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

// Ceiling is a day: longer cadence is a poller turned off without saying so.
export const REFRESH_CADENCE_BOUNDS = { min: 1, max: 1440 } as const;

// Number.parseInt, unlike money fields: this is an integer column, not a decimal to preserve.
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

// Poller reads this before scheduling every tick, not once at start-up — a saved change takes
// effect at the next scheduling (no restart/signal), up to one old cadence away.
export async function readRefreshCadence(db: Kysely<Database> = getDb()): Promise<number> {
  const row = await db
    .selectFrom("app_setting")
    .select("refresh_cadence_minutes")
    .executeTakeFirstOrThrow();

  return row.refresh_cadence_minutes;
}

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
