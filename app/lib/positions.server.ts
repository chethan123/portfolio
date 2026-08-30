/**
 * Correcting one position, in place on the Holdings table (DESIGN.md §5.4) —
 * the small write for the gap between quarterly statements and weekly
 * changes, where the four-screen upload is more ceremony than the fact
 * deserves. It is `balances.server.ts` for accounts holding more than one
 * thing, under the same three rules:
 *
 * **It appends; it never edits.** `holding_valued_at` reads position sets for
 * every plotted date, so an `update holding` would silently restate every
 * figure back to the statement it landed in — March net worth moving because
 * an August typo was fixed. A revision is a *new* set carrying today's date;
 * the corrected one keeps speaking for its own dates.
 *
 * **It carries the whole account forward.** §5.2's "a missing row means sold"
 * makes a set a photograph, so a set with only the corrected row would record
 * everything else as sold. The new set is the old with one row changed — the
 * reading §14.7 already takes of the gap between two statements.
 *
 * **It changes numbers, never membership.** Adding an instrument means
 * resolving a name against the alias table — the upload flow's job (§4.3).
 * Zero is stored as zero rather than dropping the row: a dropped row is
 * unreachable from the table that no longer prints it, uneditable by the very
 * screen that removed it.
 *
 * The write is one statement (`balances.server.ts`'s reason: a set landing
 * without its holdings is a *successful* write meaning "holds nothing"). The
 * CTE also guards that the instrument is still in the account, so an account
 * that changed underneath the form writes nothing at all.
 */
import { sql } from "kysely";
import { z } from "zod";

import { getDb, type Database } from "./db.server.ts";
import {
  NotFoundError,
  ValidationError,
  parseInput,
  perShareAmount,
  signedQuantity,
} from "./input.server.ts";
import { getAccount } from "./accounts.server.ts";
import { MONEY_SCALE, QUANTITY_SCALE, toUnits } from "./money.ts";

import type { IsoDate } from "./valuation.server.ts";
import type { Kysely, Selectable } from "kysely";

/** What the row's two editable boxes carry. */
export const positionInput = z.object({
  quantity: signedQuantity("A quantity"),
  costBasisPerShare: perShareAmount("A cost basis"),
});

export type PositionInput = z.infer<typeof positionInput>;

/** A position as it stands on the account's current statement. */
export type CurrentPosition = {
  accountId: string;
  instrumentId: string;
  instrumentName: string;
  /** Signed, exactly as stored: negative for something owed. */
  quantity: string;
  /** Null when no statement ever carried one, as 401k statements routinely do. */
  costBasisPerShare: string | null;
  /** The date of the position set this reading comes from. */
  asOf: IsoDate;
  /**
   * The current quote, or null. Not a fact about the statement, here anyway:
   * the other operand of a multiplication the *view* performs, and
   * {@link revisePosition} must know whether the figure it is about to store
   * is one the view can express ({@link fitsTheMoneyColumn}).
   */
  price: string | null;
  /**
   * Here for {@link CurrentPosition.price}'s reason and no other: since
   * migration 0006 this is the third operand `holding_valued` multiplies the
   * stored quantity by.
   */
  annualDividendPerShare: string | null;
  /**
   * `fixed` is the seeded USD row's alone. Here because {@link revisePosition}
   * must tell a count of shares from a sum of money: §2 stores a cash balance
   * as a quantity of the fixed-price currency, so on those rows the quantity
   * box is money and is held to money's rule.
   */
  priceSource: Selectable<Database["instrument"]>["price_source"];
};

/**
 * A revision as stored. Deliberately not `CurrentPosition & …`: a price is a
 * market fact this write neither set nor changed, and a caller handed one
 * would reasonably read it as part of what was recorded.
 */
export type RevisedPosition = {
  accountId: string;
  accountName: string;
  instrumentId: string;
  instrumentName: string;
  /** Signed, exactly as the quantity was written: negative for something owed. */
  quantity: string;
  costBasisPerShare: string | null;
  /** The date the new position set carries, which is not always today. */
  asOf: IsoDate;
};

/**
 * What an account's current statement says about one instrument, resolved
 * through `latest_position_set` — never a second `order by` here (§8.2).
 *
 * Read twice per correction, for neither obvious reason: the write reads it
 * to decide whether the correction may be made at all; the Holdings loader
 * reads it for the date the correction will carry. It is *not* the source of
 * the boxes' contents — those are the figures already on screen, so `120.5`
 * opens as `120.5`, not the stored `120.50000000`.
 *
 * @returns null when the account holds no such instrument — also the answer
 *          for an account with no statement at all.
 */
export async function currentPosition(
  accountId: string,
  instrumentId: string,
  db: Kysely<Database> = getDb(),
): Promise<CurrentPosition | null> {
  // Both ids reach here from a URL, checked before they are cast:
  // `'x'::bigint` is a driver error, not an empty result.
  if (!/^\d+$/.test(accountId) || !/^\d+$/.test(instrumentId)) return null;

  const result = await sql<{
    instrument_name: string;
    quantity: string;
    cost_basis_per_share: string | null;
    as_of_date: string;
    price: string | null;
    annual_dividend_per_share: string | null;
    price_source: string;
  }>`
    select
      i.name                        as instrument_name,
      h.quantity                    as quantity,
      h.cost_basis_per_share        as cost_basis_per_share,
      ps.as_of_date                 as as_of_date,
      q.price                       as price,
      q.annual_dividend_per_share   as annual_dividend_per_share,
      i.price_source                as price_source
    from position_set ps
    join holding h    on h.position_set_id = ps.id
    join instrument i on i.id = h.instrument_id
    -- Left, as holding_valued joins it: an unquotable instrument is still
    -- held, and still correctable.
    left join quote q on q.instrument_id = i.id
    where ps.id = latest_position_set(${accountId}::bigint)
      and h.instrument_id = ${instrumentId}::bigint
  `.execute(db);

  const row = result.rows[0];
  if (row === undefined) return null;

  return {
    accountId,
    instrumentId,
    instrumentName: row.instrument_name,
    quantity: row.quantity,
    costBasisPerShare: row.cost_basis_per_share,
    asOf: row.as_of_date,
    price: row.price,
    annualDividendPerShare: row.annual_dividend_per_share,
    priceSource: row.price_source,
  };
}

/**
 * `numeric(20, 4)`, as the view casts its three products. Not the columns'
 * own precision: each operand can sit inside its column while the *product*
 * lands outside this — the whole reason {@link fitsTheMoneyColumn} exists.
 */
const MONEY_PRECISION = 20;

/**
 * The cast's ceiling as a scaled integer: `numeric(p, s)` must round under
 * `10^(p-s)`, and a figure at scale `s` is `10^s` times itself, so the
 * exponents cancel — the limit is `10^p` whatever the scale.
 */
const MONEY_LIMIT = 10n ** BigInt(MONEY_PRECISION);

/** Scale 8 × scale 4 is a product at scale 12; the view's cast lands it at 4. */
const SCALE_GAP = 10n ** BigInt(QUANTITY_SCALE);

/**
 * Whether `quantity × perShare` is a figure this application can hold. The
 * view casts three products against the stored quantity to `numeric(20, 4)`,
 * and one that will not round under 10^16 makes the cast raise — far worse
 * than a refused form: the write succeeds, then every `holding_valued` reader
 * throws on every request, and Holdings — the only screen the editor is
 * reachable from — is among them, so only `psql` could recover it.
 *
 * Bounding the fields cannot prevent it: each operand can be well inside its
 * column (a twelve-digit quantity, a share priced in the hundred thousands)
 * with only the product overflowing — so the check is on the product, both
 * operands in hand, at the moment of the write. Exact, in `bigint`, rounded
 * the way the cast rounds before comparing: half away from zero can carry a
 * hair-under figure to exactly the limit, the one case an unrounded check
 * would wave through.
 *
 * Two callers, both at a write: {@link revisePosition} (the one restated
 * row) and `commitUpload` (every parsed row — the likelier way in).
 */
export function fitsTheMoneyColumn(quantity: string, perShare: string | null): boolean {
  if (perShare === null) return true;

  const product = toUnits(quantity, QUANTITY_SCALE) * toUnits(perShare, MONEY_SCALE);
  const magnitude = product < 0n ? -product : product;
  const rounded = (magnitude + SCALE_GAP / 2n) / SCALE_GAP;

  return rounded < MONEY_LIMIT;
}

/**
 * Whether two quantities point the same way. Zero points nowhere and matches
 * anything — what lets a position be closed and reopened the other way across
 * two deliberate edits rather than one absent-minded one.
 */
function sameDirection(before: string, after: string): boolean {
  const negative = (value: string) => /^-/.test(value) && !/^-0+(\.0+)?$/.test(value);
  const zero = (value: string) => /^-?0+(\.0+)?$/.test(value);

  return zero(before) || zero(after) || negative(before) === negative(after);
}

/**
 * Restate one position on an account's current statement.
 *
 * @param raw the submitted fields, unvalidated.
 * @throws {NotFoundError} when no such account exists.
 * @throws {ValidationError} with a message per bad field, and a form-level one
 *         where the submission cannot apply at all.
 */
export async function revisePosition(
  accountId: string,
  instrumentId: string,
  raw: unknown,
  db: Kysely<Database> = getDb(),
): Promise<RevisedPosition> {
  const account = await getAccount(accountId, db);

  // Before field validation, for `setBalance`'s reason: a closed account is a
  // problem no correcting of boxes will fix, and "not a number" would bury it.
  if (account.isClosed) {
    throw ValidationError.form(
      `${account.name} is closed, and a closed account's history does not change. ` +
        "Reopen it from Settings if this position is still real.",
    );
  }

  const before = await currentPosition(accountId, instrumentId, db);
  if (before === null) {
    throw ValidationError.form(
      `${account.name}'s current statement no longer carries this position — it may have been ` +
        "replaced while this form was open. Reload the page to see what the account holds now.",
    );
  }

  const input = parseInput(positionInput, raw);

  // On a cash row this box holds money: §2 stores a bank balance as a
  // quantity of fixed-price USD, so this editor is a second door onto the
  // figure `setBalance` writes and must refuse the same things —
  // `signedQuantity` alone allows the eight places a share needs, which on a
  // balance is $100.1235. Wording is `moneyMagnitude`'s: one rule, two doors.
  // Only the quantity: a cost basis is a rate, and `perShareAmount` holds all
  // four places the box was prefilled from.
  if (before.priceSource === "fixed" && (input.quantity.split(".")[1] ?? "").length > 2) {
    throw new ValidationError({
      quantity: "A balance is recorded to the cent, so it takes at most two decimal places.",
    });
  }

  // The one refusal about meaning rather than form. §2 puts the sign in the
  // quantity, so flipping it asserts an asset became a debt — moving net
  // worth by twice the figure while reading as an ordinary correction.
  // `balances.server.ts` refuses signs entirely; this box must show one (it
  // opens containing the printed number), so it refuses the change instead.
  if (!sameDirection(before.quantity, input.quantity)) {
    throw new ValidationError({
      quantity:
        `${before.instrumentName} is currently held as ` +
        `${/^-/.test(before.quantity) ? "something owed" : "something held"}, and a correction ` +
        "changes how much rather than which way. Record it as zero first if the position really " +
        "did turn around.",
    });
  }

  // The three multiplications the view is about to perform, checked before
  // storage rather than discovered at render. The price and dividend rate are
  // facts the household cannot influence, so those refusals name the quantity
  // that *was* typed.
  if (!fitsTheMoneyColumn(input.quantity, input.costBasisPerShare)) {
    throw new ValidationError({
      costBasisPerShare:
        "That cost basis multiplied by this quantity is a larger figure than this application " +
        "can hold. Check both boxes — a cost basis is what one share cost, not what the whole " +
        "position did.",
    });
  }

  if (!fitsTheMoneyColumn(input.quantity, before.price)) {
    throw new ValidationError({
      quantity:
        `That quantity valued at ${before.instrumentName}'s price is a larger figure than this ` +
        "application can hold.",
    });
  }

  if (!fitsTheMoneyColumn(input.quantity, before.annualDividendPerShare)) {
    throw new ValidationError({
      quantity:
        `That quantity at ${before.instrumentName}'s dividend rate projects a larger annual ` +
        "dividend than this application can hold.",
    });
  }

  const asOf = effectiveDate(before.asOf);

  // One statement, every guard in it. `source` is empty unless the current
  // set still carries this instrument, and both writes select from it — an
  // account that changed underneath the form produces no position set at all.
  // `greatest` again, though `effectiveDate` already ran: that date was
  // chosen against the set the guard read, this one against the set the write
  // locks — the same set except in a race, where this keeps the correction
  // from landing behind the statement it corrects.
  const written = await sql<{ position_set_id: string }>`
    with source as (
      select ps.id, ps.as_of_date
      from position_set ps
      where ps.id = latest_position_set(${accountId}::bigint)
        and exists (
          select 1
          from holding h
          where h.position_set_id = ps.id
            and h.instrument_id = ${instrumentId}::bigint
        )
    ),
    new_set as (
      insert into position_set (account_id, as_of_date, source)
      select ${accountId}::bigint, greatest(${asOf}::date, source.as_of_date), 'manual'
      from source
      returning id
    )
    insert into holding (position_set_id, instrument_id, quantity, cost_basis_per_share)
    select
      new_set.id,
      h.instrument_id,
      case when h.instrument_id = ${instrumentId}::bigint
           then ${input.quantity}::numeric else h.quantity end,
      case when h.instrument_id = ${instrumentId}::bigint
           then ${input.costBasisPerShare}::numeric else h.cost_basis_per_share end
    from new_set
    cross join holding h
    where h.position_set_id = (select id from source)
    returning holding.position_set_id
  `.execute(db);

  const landed = written.rows[0];
  if (landed === undefined) {
    // `source` was empty by the time the statement ran — the race
    // `before === null` catches, lost after the check. Reported, not retried:
    // what the account holds now is not what this form was filled in against.
    throw ValidationError.form(
      `${account.name} changed while this form was open, so nothing was recorded. ` +
        "Reload the page and make the correction against what it holds now.",
    );
  }

  return {
    accountId: account.id,
    accountName: account.name,
    instrumentId,
    instrumentName: before.instrumentName,
    quantity: input.quantity,
    costBasisPerShare: input.costBasisPerShare,
    // The same date the statement applied, computed by the same function:
    // `RETURNING` on an INSERT…SELECT sees the target table's columns, and
    // `as_of_date` is not one of `holding`'s.
    asOf,
  };
}

/**
 * The date a correction against a statement of `asOf` will carry: today,
 * except where the statement is dated ahead (`recordedDate` allows one day of
 * slack east of UTC) — a correction filed behind the sheet it corrects
 * appears to succeed and changes no figure anywhere. ISO dates compare as
 * text exactly as they compare as dates.
 *
 * Exported because the editor names this date *before* the click; the
 * `greatest` in the statement is the same rule applied where the row is
 * locked. Today comes from the server clock, not `current_date`, so one clock
 * answers — `latestRecordableDate` reads the same one.
 */
export function effectiveDate(asOf: IsoDate): IsoDate {
  const today = new Date().toISOString().slice(0, 10);

  return today > asOf ? today : asOf;
}
