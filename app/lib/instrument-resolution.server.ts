// Resolves a statement's instrument strings against the alias table (DESIGN.md §4.3, spec
// 0004 step 04). Lookup is byte-exact (raw_string collate "C") — no trimming/folding/heuristics,
// since a fuzzy merge could silently attach a holding to the wrong fund; a miss just prompts
// once and is remembered forever. Writes happen here, not at commit: an alias is a vocabulary
// fact, not this statement's, so a re-upload of a corrected file shouldn't ask again, and an
// abandoned draft correctly leaves the vocabulary behind with nothing recorded as held.
import { isAssetClass } from "./account-options.ts";
import { getDb, type Database } from "./db.server.ts";
import { ValidationError } from "./input.server.ts";

import type { ProbeSymbols } from "./price-provider.server.ts";
import type { ParsedPosition } from "./statement.ts";
import type { AssetClass } from "./valuation.server.ts";
import type { Kysely } from "kysely";

// Sentinel like NOT_IN_FILE (column-mapping.server.ts): "new classification" and "none chosen"
// are different answers.
export const NEW_CLASSIFICATION = "__new__";

// Distinct strings with no instrument_alias row, in first-appearance order.
export async function unresolvedStrings(
  strings: readonly string[],
  db: Kysely<Database> = getDb(),
): Promise<string[]> {
  const distinct: string[] = [];
  const seen = new Set<string>();
  for (const value of strings) {
    if (!seen.has(value)) {
      seen.add(value);
      distinct.push(value);
    }
  }

  if (distinct.length === 0) return [];

  const rows = await db
    .selectFrom("instrument_alias")
    .select("raw_string")
    .where("raw_string", "in", distinct)
    .execute();

  const resolved = new Set(rows.map((row) => row.raw_string));
  return distinct.filter((value) => !resolved.has(value));
}

// Byte-exact except line endings, normalised (\r\n? -> \n): HTML form serialisation turns a
// lone LF/CR into CRLF, so a quoted multi-line cell echoed through a hidden field would
// otherwise fail this staleness check on every submit. Comparison only — storage always uses
// the draft's own parsed string, so no CRLF-mangled alias can land.
export function sameRawStrings(a: string, b: string): boolean {
  const lineEndings = (value: string): string => value.replace(/\r\n?/g, "\n");
  return lineEndings(a) === lineEndings(b);
}

export type UnresolvedPosition = {
  // Instrument cell exactly as the file wrote it — what gets stored.
  raw: string;
  name: string | null;
  quantity: string;
};

export type ResolutionScreen = {
  unresolved: UnresolvedPosition[];
  // How many holdings the file states — the "of 5" in the intro sentence.
  totalPositions: number;
  instruments: Array<{ id: string; symbol: string | null; name: string }>;
  classifications: Array<{ id: string; name: string; assetClass: string }>;
};

// positions come from parseStatement, already grouped by raw instrument cell — one position
// per distinct string.
export async function resolutionScreen(
  positions: ReadonlyArray<ParsedPosition>,
  db: Kysely<Database> = getDb(),
): Promise<ResolutionScreen> {
  const misses = await unresolvedStrings(
    positions.map((position) => position.instrument),
    db,
  );

  const byRaw = new Map(positions.map((position) => [position.instrument, position]));
  const unresolved = misses.map((raw) => {
    const position = byRaw.get(raw);
    return {
      raw,
      name: position?.name ?? null,
      quantity: position?.quantity ?? "0",
    };
  });

  const instruments = await db
    .selectFrom("instrument")
    .select(["id", "symbol", "name"])
    .orderBy("symbol")
    .orderBy("name")
    .execute();

  const classifications = await db
    .selectFrom("classification")
    .select(["id", "name", "asset_class"])
    .orderBy("name")
    .execute();

  return {
    unresolved,
    totalPositions: positions.length,
    instruments,
    classifications: classifications.map((row) => ({
      id: row.id,
      name: row.name,
      assetClass: row.asset_class,
    })),
  };
}

// Every field optional — validating what's missing is this module's job. Field names are these
// keys with the string's index appended (kind-0); resolutionFieldsAt reads them back.
export type ResolutionFields = {
  // "existing" | "create".
  kind?: string;
  instrumentId?: string;
  symbol?: string;
  name?: string;
  // "feed" | "manual" — "fixed" belongs to the seeded USD row alone.
  priceSource?: string;
  // An existing classification id, or NEW_CLASSIFICATION.
  classificationId?: string;
  newClassificationName?: string;
  newClassificationAssetClass?: string;
};

const RESOLUTION_FIELDS = [
  "kind",
  "instrumentId",
  "symbol",
  "name",
  "priceSource",
  "classificationId",
  "newClassificationName",
  "newClassificationAssetClass",
] as const;

export function resolutionFieldsAt(
  values: Record<string, string>,
  index: number,
): ResolutionFields {
  const fields: ResolutionFields = {};
  for (const field of RESOLUTION_FIELDS) {
    const value = values[`${field}-${index}`];
    if (value !== undefined) fields[field] = value;
  }
  return fields;
}

export type ResolutionInput = {
  raw: string;
  fields: ResolutionFields;
};

export type ResolvedAlias = {
  raw: string;
  // The instrument the alias points at — the winner, when a concurrent draft got there first.
  instrumentId: string;
};

// probe is required, not defaulted, so production (app/routes/upload/instruments.tsx) can't
// reach the network by omission; tests stub it instead.
export type ResolutionDeps = {
  probe: ProbeSymbols;
};

type CreatePlan = {
  kind: "create";
  symbol: string | null;
  name: string;
  priceSource: "feed" | "manual";
  // Null when a new classification is being created instead.
  classificationId: string | null;
  // Trimmed new-classification name, key into the pending map.
  newClassification: string | null;
};

type Plan = { kind: "existing"; instrumentId: string } | CreatePlan;

// Kysely refuses .transaction() on a transaction, and the test seam is one (prices.server.ts
// carries the same helper).
function inTransaction<T>(
  db: Kysely<Database>,
  body: (trx: Kysely<Database>) => Promise<T>,
): Promise<T> {
  return db.isTransaction ? body(db) : db.transaction().execute(body);
}

// Resolves every unresolved string in one submit, or refuses the whole with a message per
// field (keyed ${field}-${index}), nothing written unless everything passes. Rules (spec 0004
// step 04): no skip (a skipped row is a holding silently missing); create writes classification
// (if new) then instrument then alias, a name typed twice in one submit is created once and
// shared; a new name colliding with a stored classification is a field refusal; feed requires
// a symbol, manual allows none; creating a feed instrument probes its symbol once (non-USD
// refuses, a provider failure doesn't block — next refresh marks it stale); concurrent drafts
// resolving the same string don't error, the alias insert tolerates the conflict and the
// existing row wins.
export async function resolveAll(
  resolutions: ReadonlyArray<ResolutionInput>,
  deps: ResolutionDeps,
  db: Kysely<Database> = getDb(),
): Promise<ResolvedAlias[]> {
  const errors: Record<string, string> = {};
  const refuse = (index: number, field: string, message: string): void => {
    errors[`${field}-${index}`] ??= message;
  };

  // Validation, all before any probe or write: three faults come back as three messages.
  const plans: Array<Plan | null> = [];

  for (const [index, { fields }] of resolutions.entries()) {
    if (fields.kind !== "existing" && fields.kind !== "create") {
      refuse(
        index,
        "kind",
        "Choose whether this is an instrument already listed or a new one — " +
          "a skipped string would be a holding silently missing from the statement.",
      );
      plans.push(null);
      continue;
    }

    if (fields.kind === "existing") {
      const instrumentId = (fields.instrumentId ?? "").trim();
      if (!/^\d+$/.test(instrumentId)) {
        refuse(index, "instrumentId", "Choose the instrument this string means.");
        plans.push(null);
        continue;
      }
      plans.push({ kind: "existing", instrumentId });
      continue;
    }

    let faulted = false;

    const symbol = (fields.symbol ?? "").trim() || null;
    if (symbol !== null && symbol.length > 40) {
      refuse(index, "symbol", "The symbol must be 40 characters or fewer.");
      faulted = true;
    }

    const name = (fields.name ?? "").trim();
    if (name === "") {
      refuse(
        index,
        "name",
        "A name is required — an instrument without one is unfindable on every other screen.",
      );
      faulted = true;
    } else if (name.length > 200) {
      refuse(index, "name", "The name must be 200 characters or fewer.");
      faulted = true;
    }

    // Feed and manual only — fixed belongs to the seeded USD row alone.
    const priceSource = fields.priceSource;
    if (priceSource !== "feed" && priceSource !== "manual") {
      refuse(
        index,
        "priceSource",
        "Choose where the price comes from — a feed, or a manual price typed from the statement.",
      );
      faulted = true;
    } else if (priceSource === "feed" && symbol === null) {
      refuse(
        index,
        "symbol",
        "A feed needs a symbol — there is nothing to quote without one. " +
          "An instrument with no ticker takes a manual price.",
      );
      faulted = true;
    }

    const chosenClassification = (fields.classificationId ?? "").trim();
    let classificationId: string | null = null;
    let newClassification: string | null = null;

    if (chosenClassification === NEW_CLASSIFICATION) {
      const newName = (fields.newClassificationName ?? "").trim();
      if (newName === "") {
        refuse(index, "newClassificationName", "The new classification needs a name.");
        faulted = true;
      } else if (newName.length > 200) {
        refuse(
          index,
          "newClassificationName",
          "The classification name must be 200 characters or fewer.",
        );
        faulted = true;
      } else {
        newClassification = newName;
      }

      const assetClass = fields.newClassificationAssetClass;
      if (!isAssetClass(assetClass)) {
        refuse(
          index,
          "newClassificationAssetClass",
          "Choose which of the four asset classes this classification rolls up into.",
        );
        faulted = true;
      }
    } else if (/^\d+$/.test(chosenClassification)) {
      classificationId = chosenClassification;
    } else {
      refuse(
        index,
        "classificationId",
        'Choose a classification, or "New classification…" to add one.',
      );
      faulted = true;
    }

    if (faulted) {
      plans.push(null);
      continue;
    }

    plans.push({
      kind: "create",
      symbol,
      name,
      priceSource: priceSource as "feed" | "manual",
      classificationId,
      newClassification,
    });
  }

  // Options were rendered from the database, so a miss here is a forged/stale post — still a
  // sentence, not an FK fault.
  const instrumentIds = [
    ...new Set(
      plans.flatMap((plan) => (plan?.kind === "existing" ? [plan.instrumentId] : [])),
    ),
  ];
  if (instrumentIds.length > 0) {
    const found = new Set(
      (
        await db.selectFrom("instrument").select("id").where("id", "in", instrumentIds).execute()
      ).map((row) => row.id),
    );
    for (const [index, plan] of plans.entries()) {
      if (plan?.kind === "existing" && !found.has(plan.instrumentId)) {
        refuse(index, "instrumentId", "Choose the instrument this string means.");
        plans[index] = null;
      }
    }
  }

  const classificationIds = [
    ...new Set(
      plans.flatMap((plan) =>
        plan?.kind === "create" && plan.classificationId !== null
          ? [plan.classificationId]
          : [],
      ),
    ),
  ];
  if (classificationIds.length > 0) {
    const found = new Set(
      (
        await db
          .selectFrom("classification")
          .select("id")
          .where("id", "in", classificationIds)
          .execute()
      ).map((row) => row.id),
    );
    for (const [index, plan] of plans.entries()) {
      if (plan?.kind === "create" && plan.classificationId !== null) {
        if (!found.has(plan.classificationId)) {
          refuse(
            index,
            "classificationId",
            'Choose a classification, or "New classification…" to add one.',
          );
          plans[index] = null;
        }
      }
    }
  }

  // Colliding with a stored classification is a refusal; two strings typing the same new name
  // share one pending creation and are only checked against the database.
  const pendingNames = [
    ...new Set(
      plans.flatMap((plan) =>
        plan?.kind === "create" && plan.newClassification !== null
          ? [plan.newClassification]
          : [],
      ),
    ),
  ];
  if (pendingNames.length > 0) {
    const taken = new Set(
      (
        await db
          .selectFrom("classification")
          .select("name")
          .where("name", "in", pendingNames)
          .execute()
      ).map((row) => row.name),
    );
    for (const [index, plan] of plans.entries()) {
      if (
        plan?.kind === "create" &&
        plan.newClassification !== null &&
        taken.has(plan.newClassification)
      ) {
        refuse(
          index,
          "newClassificationName",
          `"${plan.newClassification}" is already a classification — ` +
            "choose it from the list instead of typing it again.",
        );
        plans[index] = null;
      }
    }
  }

  if (Object.keys(errors).length > 0) throw new ValidationError(errors);

  // One probe call per distinct feed symbol (two strings creating one ticker cost one call),
  // before any write, so a non-USD refusal leaves nothing behind.
  const feedSymbols = [
    ...new Set(
      plans.flatMap((plan) =>
        plan?.kind === "create" && plan.priceSource === "feed" && plan.symbol !== null
          ? [plan.symbol]
          : [],
      ),
    ),
  ];

  // A manual-only submission (the common case) makes no provider call at all, by construction.
  const verdicts: Awaited<ReturnType<ProbeSymbols>> =
    feedSymbols.length > 0 ? await deps.probe(feedSymbols) : new Map();

  for (const [index, plan] of plans.entries()) {
    if (plan?.kind !== "create" || plan.priceSource !== "feed" || plan.symbol === null) {
      continue;
    }

    // Defensive fallback — the batched probe never throws, so the map shouldn't lack an entry.
    const verdict = verdicts.get(plan.symbol) ?? { status: "unavailable" as const };

    // unavailable doesn't block: created now, marked stale by the next refresh — a network
    // hiccup must not hold a statement hostage.
    if (verdict.status === "non-usd") {
      refuse(
        index,
        "symbol",
        `${plan.symbol} is quoted in ${verdict.currency}. ` +
          "This instance holds USD only, so it was not created.",
      );
    }
  }

  if (Object.keys(errors).length > 0) throw new ValidationError(errors);

  // Read from the verdict cache — probing again would be a second network call.
  const quoteTypeOf = (plan: { symbol: string | null }): string | null => {
    const verdict = plan.symbol === null ? undefined : verdicts.get(plan.symbol);

    return verdict?.status === "ok" ? verdict.quoteType : null;
  };

  // Classification (if new), then instrument, then alias — one transaction, so a fault leaves
  // no half-remembered vocabulary.
  return inTransaction(db, async (trx) => {
    // doNothing + re-read covers the race validation can't: a concurrent submit landing the
    // same name. Either way the stored id answers.
    const created = new Map<string, string>();
    for (const [index, plan] of plans.entries()) {
      if (plan?.kind !== "create" || plan.newClassification === null) continue;
      if (created.has(plan.newClassification)) continue;

      const assetClass = resolutions[index]?.fields.newClassificationAssetClass as AssetClass;
      await trx
        .insertInto("classification")
        .values({ name: plan.newClassification, asset_class: assetClass })
        .onConflict((conflict) => conflict.column("name").doNothing())
        .execute();
      const row = await trx
        .selectFrom("classification")
        .select("id")
        .where("name", "=", plan.newClassification)
        .executeTakeFirstOrThrow();
      created.set(plan.newClassification, row.id);
    }

    const resolved: ResolvedAlias[] = [];

    for (const [index, plan] of plans.entries()) {
      const raw = resolutions[index]?.raw;
      if (plan === null || raw === undefined) continue; // unreachable: validated above

      let instrumentId: string;
      let createdInstrument = false;

      if (plan.kind === "existing") {
        instrumentId = plan.instrumentId;
      } else {
        const classificationId =
          plan.classificationId ??
          (plan.newClassification !== null ? created.get(plan.newClassification) : undefined);
        if (classificationId === undefined) continue; // unreachable: validated above

        const row = await trx
          .insertInto("instrument")
          .values({
            symbol: plan.symbol,
            name: plan.name,
            // Whatever the probe was told; null if it was told nothing (unquoted symbol, a
            // trust, a provider's bad day) — a refresh backfills the rest. Never guessed: the
            // Analysis split (§4.4) treats a null as a visible catch-all, not a misfiled equity.
            quote_type: quoteTypeOf(plan),
            price_source: plan.priceSource,
            classification_id: classificationId,
          })
          .returning("id")
          .executeTakeFirstOrThrow();
        instrumentId = row.id;
        createdInstrument = true;
      }

      // doNothing: a concurrent draft resolving the same string, and the existing row wins.
      const inserted = await trx
        .insertInto("instrument_alias")
        .values({ raw_string: raw, instrument_id: instrumentId })
        .onConflict((conflict) => conflict.column("raw_string").doNothing())
        .returning("instrument_id")
        .executeTakeFirst();

      if (inserted === undefined) {
        const winner = await trx
          .selectFrom("instrument_alias")
          .select("instrument_id")
          .where("raw_string", "=", raw)
          .executeTakeFirstOrThrow();

        // Lost the race, nothing points at it — deleted rather than left as a duplicate the
        // select would offer forever. A new classification stays: harmless even with no instruments.
        if (createdInstrument && winner.instrument_id !== instrumentId) {
          await trx.deleteFrom("instrument").where("id", "=", instrumentId).execute();
        }

        resolved.push({ raw, instrumentId: winner.instrument_id });
        continue;
      }

      resolved.push({ raw, instrumentId: inserted.instrument_id });
    }

    return resolved;
  });
}
