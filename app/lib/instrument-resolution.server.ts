/**
 * Resolving a statement's instrument strings against the alias table
 * (DESIGN.md §4.3, spec 0004 step 04). This module owns both halves of the
 * unresolved screen: the question — which strings has nobody ever resolved,
 * and what context does the screen show beside each — and the answer, the
 * writes that remember a resolution forever.
 *
 * Lookup is **byte-exact**, which is `instrument_alias.raw_string`'s
 * `collate "C"` doing its job: no trimming, no case folding, no heuristics. A
 * respelling is rightly a first sighting even when the instrument is old
 * news, because a heuristic that "helpfully" merged two near-identical
 * strings would attach a holding to the wrong fund silently — a miss prompts
 * once and is remembered permanently instead.
 *
 * The writes happen at this step rather than at commit, deliberately: an
 * alias is a fact about vocabulary, not about this statement, and
 * re-uploading a corrected file must not ask the same questions again. A
 * draft abandoned after this step leaves the vocabulary behind, which is
 * correct — the next upload is quieter, and nothing was recorded as held.
 */
import { getDb, type Database } from "./db.server.ts";
import { ValidationError } from "./input.server.ts";
import { probeSymbol, type ProbeSymbol } from "./price-provider.server.ts";

import type { ParsedPosition } from "./statement.ts";
import type { AssetClass } from "./valuation.server.ts";
import type { Kysely } from "kysely";

/**
 * What the classification `<select>` posts when the reader chooses to type a
 * new one rather than pick from the list. A sentinel, like the columns
 * screen's `NOT_IN_FILE`, because "the new one below" and "no classification
 * chosen" are different answers. The route reads it out of its loader data
 * rather than importing it, since this is a `.server` module and the option
 * is rendered client-side.
 */
export const NEW_CLASSIFICATION = "__new__";

/**
 * The distinct strings with no `instrument_alias` row behind them, in
 * first-appearance order — the order the unresolved screen asks its
 * questions in, which is the order the file raised them.
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
 * Do two raw instrument strings state the same cell?
 *
 * Byte-exact, except that line endings compare normalised (`\r\n?` → `\n`).
 * The exception exists because HTML form serialisation normalises a lone LF
 * or CR inside a posted value to CRLF: a quoted multi-line cell echoed back
 * through a hidden field would fail a byte-exact staleness check on every
 * submit, forever. Nothing is given up by tolerating it — two aliases
 * genuinely differing only by CR-versus-LF cannot exist meaningfully through
 * a browser, since every post would collapse them to one spelling anyway.
 *
 * This compares only; what gets *stored* is always the draft's own parsed
 * string, never a posted copy, so no CRLF-mangled alias can land.
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
 * The unresolved screen's read: which of a draft's positions are first
 * sightings, each with the context the brief asks for beside the raw string
 * — the mapped name column's value and the quantity — plus the two lists the
 * form's selects are built from.
 *
 * `positions` come from `parseStatement`, which already grouped the file's
 * rows by the instrument cell as written, so there is exactly one position
 * per distinct raw string.
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
 * One string's answer as the form posted it, every field optional because
 * validating what is missing is this module's job. The screen's field names
 * are these keys with the string's index appended — `kind-0`, `symbol-0` —
 * and {@link resolutionFieldsAt} reads them back out of a posted form.
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
 * One string's fields out of the posted form, by its index in the screen's
 * order. Owned here beside the error keys so the naming scheme —
 * `${field}-${index}` — is stated once and read twice.
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

const ASSET_CLASSES: ReadonlyArray<AssetClass> = ["equity", "bond", "cash", "other"];

/**
 * Run `body` in a transaction, unless one is already open — the same helper
 * `prices.server.ts` carries, for the same reason: Kysely refuses
 * `.transaction()` on a handle that is already one, and the test seam *is* a
 * transaction.
 */
function inTransaction<T>(
  db: Kysely<Database>,
  body: (trx: Kysely<Database>) => Promise<T>,
): Promise<T> {
  return db.isTransaction ? body(db) : db.transaction().execute(body);
}

/**
 * Resolve every unresolved string in one call — the unresolved screen's one
 * submit — or refuse the whole submission with a message per field.
 *
 * The rules, all from spec 0004 step 04:
 *
 * - every string must be resolved; there is deliberately no skip, because a
 *   skipped row is a holding silently missing from the statement
 * - pointing at an existing instrument writes only the alias
 * - creating writes `classification` first when a new one was typed, then
 *   `instrument`, then the alias — and a new classification typed twice in
 *   one submit is created once and shared, never refused against itself
 * - a new classification name colliding with an existing one is a
 *   field-level refusal naming it, since `classification.name` is unique and
 *   it is the user-facing label
 * - `feed` requires a symbol — there is nothing to quote without one —
 *   and `manual` allows none, which is the collective-investment-trust case
 * - creating a `feed` instrument probes its symbol once. A non-USD quote
 *   refuses that string's creation in the refresh guard's stem wording;
 *   a provider failure does not block — the next refresh marks it stale
 *   exactly as it does any symbol that stops quoting
 * - two drafts resolving the same string concurrently do not error: the
 *   alias insert tolerates the conflict and the existing row wins
 *
 * Refusals are field-level, keyed `${field}-${index}` over the screen's
 * order, and nothing is written unless everything passes — a refusal must
 * re-render the same list of questions it was asked about.
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

  // ---- validation, all of it before any probe or write, so a submission
  // with three faults comes back with three messages rather than one per
  // round trip (the columns form's precedent).

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

    // Feed and manual only: `fixed` belongs to the seeded USD row alone, and
    // a second fixed-price instrument is not a thing this screen makes.
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
      if (!ASSET_CLASSES.includes(assetClass as AssetClass)) {
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

  // The referenced rows must exist. The options were rendered from the
  // database, so a miss is a forged or very stale post — but it still gets a
  // sentence rather than a foreign-key fault.
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
  // it. Two strings typing the same new name in one submit are not a
  // collision — they share one pending creation, checked here against the
  // database only.
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

  // ---- the USD probe, once per created feed instrument (cached by symbol,
  // so two strings creating the same ticker cost one call). Run before any
  // write: a non-USD refusal must leave nothing behind, and re-render the
  // same list of questions it was asked.
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

    // `unavailable` does not block: the instrument is created and the next
    // refresh marks it stale, exactly as it does any symbol that stops
    // quoting. A network hiccup must not hold a statement hostage.
    if (verdict.status === "non-usd") {
      // The refresh guard's stem with only its tail adapted — two spellings
      // of one refusal would be two rules (`CurrencyRefused`).
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
   * What the probe said this symbol is, for a plan that is about to become a
   * row. Read out of the verdict cache rather than probed again: the loop above
   * already asked once per symbol, and asking twice would be a second network
   * call to learn something already known.
   */
  const quoteTypeOf = (plan: { symbol: string | null }): string | null => {
    const verdict = plan.symbol === null ? undefined : verdicts.get(plan.symbol);

    return verdict?.status === "ok" ? verdict.quoteType : null;
  };

  // ---- the writes: classification first when new, then instrument, then
  // the alias — one transaction, so a fault leaves no half-remembered
  // vocabulary.
  return inTransaction(db, async (trx) => {
    // New classifications, each created once however many strings typed it.
    // `onConflict doNothing` plus a re-read covers the race the validation
    // above cannot: a concurrent submit landing the same name between the
    // check and this insert. Either way the stored row's id is the answer.
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
            // Whatever the probe was told, and null when it was told nothing —
            // an unquoted symbol, a manually priced trust, a provider having a
            // bad day. The Analysis screen splits stocks from funds on this
            // column (§4.4), and the probe above is the one moment the
            // application both learns the answer and has a row to write it on;
            // a refresh backfills the rest (`prices.server.ts`). Null stays
            // null rather than becoming a guess: the catch-all row that
            // receives it is visible and counted, and an instrument filed as an
            // equity because nobody said otherwise would not be.
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
      // `doNothing` on the conflict, and the existing row wins — the result
      // points at whatever the table now says the string means.
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

        // The instrument created for this string lost to the concurrent
        // draft's answer and nothing points at it — deleted rather than left
        // as a duplicate the point-at-existing select would offer forever.
        // A new classification stays: it may serve other strings, and a
        // label with no instruments is harmless vocabulary.
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
