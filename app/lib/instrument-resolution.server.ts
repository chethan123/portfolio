/**
 * Resolving a statement's instrument strings against the alias table
 * (DESIGN.md §4.3, spec 0004 step 04): the question — which strings has
 * nobody resolved, with what context beside each — and the answer, the
 * writes that remember a resolution forever.
 *
 * Lookup is **byte-exact** (`raw_string`'s `collate "C"`): no trimming, no
 * case folding, no heuristics. A respelling is rightly a first sighting — a
 * heuristic merging near-identical strings would attach a holding to the
 * wrong fund silently; a miss prompts once and is remembered permanently.
 *
 * Writes happen at this step, not at commit: an alias is a fact about
 * vocabulary, not this statement, and re-uploading a corrected file must not
 * ask again. A draft abandoned after this step leaves the vocabulary behind —
 * correct: the next upload is quieter, and nothing was recorded as held.
 */
import { assetClassValues } from "./account-options.ts";
import { getDb, type Database } from "./db.server.ts";
import { ValidationError } from "./input.server.ts";
import { probeSymbol, type ProbeSymbol } from "./price-provider.server.ts";

import type { ParsedPosition } from "./statement.ts";
import type { AssetClass } from "./valuation.server.ts";
import type { Kysely } from "kysely";

/**
 * What the classification `<select>` posts when the reader types a new one —
 * a sentinel like the columns screen's `NOT_IN_FILE`, because "the new one
 * below" and "no classification chosen" are different answers. The route
 * reads it from loader data: this is a `.server` module and the option
 * renders client-side.
 */
export const NEW_CLASSIFICATION = "__new__";

/**
 * The distinct strings with no `instrument_alias` row behind them, in
 * first-appearance order — the order the file raised them and the screen asks.
 */
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

/**
 * Byte-exact, except line endings compare normalised (`\r\n?` → `\n`): HTML
 * form serialisation turns a lone LF/CR in a posted value into CRLF, so a
 * quoted multi-line cell echoed through a hidden field would fail a
 * byte-exact staleness check on every submit, forever. Nothing is given up —
 * two aliases differing only by CR/LF cannot exist meaningfully through a
 * browser. This compares only; what is *stored* is always the draft's own
 * parsed string, so no CRLF-mangled alias can land.
 */
export function sameRawStrings(a: string, b: string): boolean {
  const lineEndings = (value: string): string => value.replace(/\r\n?/g, "\n");
  return lineEndings(a) === lineEndings(b);
}

/** One first sighting, with enough context to recognise the holding. */
export type UnresolvedPosition = {
  /** The instrument cell exactly as the file wrote it — what will be stored. */
  raw: string;
  /** The mapped name column's value on that row, when one is mapped. */
  name: string | null;
  /** The row's quantity, a decimal string. */
  quantity: string;
};

/** Everything the unresolved screen renders, in one read. */
export type ResolutionScreen = {
  /** The first sightings, in the order the file raised them. */
  unresolved: UnresolvedPosition[];
  /** How many holdings the file states — the "of 5" in the intro sentence. */
  totalPositions: number;
  /** Every instrument, for the point-at-existing select. */
  instruments: Array<{ id: string; symbol: string | null; name: string }>;
  /** Every classification, for the create branch's select. */
  classifications: Array<{ id: string; name: string; assetClass: string }>;
};

/**
 * The unresolved screen's read: which positions are first sightings, each
 * with the context the brief asks for (mapped name, quantity), plus the two
 * select lists. `positions` come from `parseStatement`, already grouped by
 * the raw instrument cell — exactly one position per distinct string.
 */
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

/**
 * One string's answer as posted, every field optional — validating what is
 * missing is this module's job. Field names are these keys with the string's
 * index appended (`kind-0`); {@link resolutionFieldsAt} reads them back.
 */
export type ResolutionFields = {
  /** "existing" | "create" — the radio pair choosing the path. */
  kind?: string;
  /** The point-at-existing select's chosen instrument id. */
  instrumentId?: string;
  symbol?: string;
  name?: string;
  /** "feed" | "manual" — `fixed` is the seeded USD row's alone. */
  priceSource?: string;
  /** An existing classification id, or {@link NEW_CLASSIFICATION}. */
  classificationId?: string;
  newClassificationName?: string;
  newClassificationAssetClass?: string;
};

/** The field names one unresolved string owns, in the order the screen draws them. */
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

/**
 * One string's fields out of the posted form, by index. Beside the error keys
 * so the `${field}-${index}` scheme is stated once and read twice.
 */
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

/** What {@link resolveAll} is asked to resolve: the raw string and its answer. */
export type ResolutionInput = {
  /** The unresolved string, byte-exact as the file wrote it. */
  raw: string;
  fields: ResolutionFields;
};

/** What one string resolved to — the alias row as written, existing row and all. */
export type ResolvedAlias = {
  raw: string;
  /** The instrument the alias points at — the winner, when a concurrent draft got there first. */
  instrumentId: string;
};

/** The dependencies a test stubs. No test touches the network. */
export type ResolutionDeps = {
  /** The creation-time USD guard, defaulting to the live provider's probe. */
  probe?: ProbeSymbol;
};

/** A validated "create" resolution, ready to write. */
type CreatePlan = {
  kind: "create";
  symbol: string | null;
  name: string;
  priceSource: "feed" | "manual";
  /** Null when a new classification is being created instead. */
  classificationId: string | null;
  /** The trimmed new-classification name, key into the pending map. */
  newClassification: string | null;
};

type Plan = { kind: "existing"; instrumentId: string } | CreatePlan;

/**
 * Run `body` in a transaction unless one is already open — Kysely refuses
 * `.transaction()` on a transaction, and the test seam *is* one (the same
 * helper `prices.server.ts` carries).
 */
function inTransaction<T>(
  db: Kysely<Database>,
  body: (trx: Kysely<Database>) => Promise<T>,
): Promise<T> {
  return db.isTransaction ? body(db) : db.transaction().execute(body);
}

/**
 * Resolve every unresolved string in one submit, or refuse the whole
 * submission with a message per field. The rules (spec 0004 step 04):
 *
 * - every string must be resolved — no skip; a skipped row is a holding
 *   silently missing from the statement
 * - existing writes only the alias; create writes classification (when new),
 *   then instrument, then alias — a new classification typed twice in one
 *   submit is created once and shared, never refused against itself
 * - a new name colliding with a stored classification is a field refusal
 *   naming it (`classification.name` is unique and user-facing)
 * - `feed` requires a symbol; `manual` allows none (the trust case)
 * - creating a `feed` instrument probes its symbol once: non-USD refuses in
 *   the refresh guard's stem wording; a provider failure does not block —
 *   the next refresh marks it stale like any symbol that stops quoting
 * - concurrent drafts resolving the same string do not error: the alias
 *   insert tolerates the conflict and the existing row wins
 *
 * Refusals are keyed `${field}-${index}` over the screen's order, and nothing
 * is written unless everything passes — a refusal must re-render the same
 * list of questions it was asked about.
 *
 * @throws {ValidationError} with a message per bad field.
 */
export async function resolveAll(
  resolutions: ReadonlyArray<ResolutionInput>,
  deps: ResolutionDeps = {},
  db: Kysely<Database> = getDb(),
): Promise<ResolvedAlias[]> {
  const errors: Record<string, string> = {};
  const refuse = (index: number, field: string, message: string): void => {
    errors[`${field}-${index}`] ??= message;
  };

  // ---- validation, all before any probe or write: three faults come back
  // as three messages, not one per round trip (the columns form's precedent).

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

    // Feed and manual only: `fixed` belongs to the seeded USD row alone.
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
      if (!assetClassValues.includes(assetClass as AssetClass)) {
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

  // Referenced rows must exist: the options were rendered from the database,
  // so a miss is a forged or stale post — still a sentence, not an FK fault.
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

  // A new name colliding with a *stored* classification is a refusal naming
  // it; two strings typing the same new name share one pending creation,
  // checked against the database only.
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

  // ---- the USD probe, once per created feed symbol (cached, so two strings
  // creating one ticker cost one call), before any write: a non-USD refusal
  // must leave nothing behind.
  const probe = deps.probe ?? probeSymbol;
  const verdicts = new Map<string, Awaited<ReturnType<ProbeSymbol>>>();

  for (const [index, plan] of plans.entries()) {
    if (plan?.kind !== "create" || plan.priceSource !== "feed" || plan.symbol === null) {
      continue;
    }

    let verdict = verdicts.get(plan.symbol);
    if (verdict === undefined) {
      verdict = await probe(plan.symbol);
      verdicts.set(plan.symbol, verdict);
    }

    // `unavailable` does not block: created now, marked stale by the next
    // refresh — a network hiccup must not hold a statement hostage.
    if (verdict.status === "non-usd") {
      // The refresh guard's stem with the tail adapted — two spellings of one
      // refusal would be two rules (`CurrencyRefused`).
      refuse(
        index,
        "symbol",
        `${plan.symbol} is quoted in ${verdict.currency}. ` +
          "This instance holds USD only, so it was not created.",
      );
    }
  }

  if (Object.keys(errors).length > 0) throw new ValidationError(errors);

  /**
   * What the probe said this symbol is, read from the verdict cache — probing
   * again would be a second network call for something already known.
   */
  const quoteTypeOf = (plan: { symbol: string | null }): string | null => {
    const verdict = plan.symbol === null ? undefined : verdicts.get(plan.symbol);

    return verdict?.status === "ok" ? verdict.quoteType : null;
  };

  // ---- the writes: classification first when new, then instrument, then
  // alias — one transaction, so a fault leaves no half-remembered vocabulary.
  return inTransaction(db, async (trx) => {
    // Each new classification created once however many strings typed it.
    // `doNothing` plus a re-read covers the race validation cannot: a
    // concurrent submit landing the same name. Either way the stored id answers.
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
            // Whatever the probe was told; null when it was told nothing (an
            // unquoted symbol, a trust, a provider's bad day). The Analysis
            // split reads this column (§4.4); the probe is the one moment the
            // app both learns the answer and has a row to write it on, and a
            // refresh backfills the rest. Null stays null, never a guess: the
            // catch-all row is visible and counted, a misfiled equity is not.
            quote_type: quoteTypeOf(plan),
            price_source: plan.priceSource,
            classification_id: classificationId,
          })
          .returning("id")
          .executeTakeFirstOrThrow();
        instrumentId = row.id;
        createdInstrument = true;
      }

      // The alias tolerates a concurrent draft resolving the same string:
      // `doNothing`, and the existing row wins.
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

        // The instrument created for this string lost the race and nothing
        // points at it — deleted rather than left as a duplicate the select
        // would offer forever. A new classification stays: it may serve other
        // strings, and a label with no instruments is harmless vocabulary.
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
