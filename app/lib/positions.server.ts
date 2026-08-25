/**
 * Correcting one position, in place on the Holdings table — DESIGN.md §5.4.
 *
 * A statement arrives quarterly and a position changes weekly. Between the two
 * there is a gap the ingest flow (§5.1) is too heavy to fill: a 401k
 * contribution added eleven units to one fund, and mapping columns over a
 * four-screen upload to say so is more ceremony than the fact deserves. This
 * module is the small write that fills it.
 *
 * It is `balances.server.ts` for accounts that hold more than one thing, and it
 * obeys the same three rules, because they are the rules and not conveniences:
 *
 * **It appends; it never edits.** `holding_valued_at` reads position sets for
 * every date the net worth chart plots, so an `update holding set quantity`
 * would not correct a number — it would silently restate every figure back to
 * the date of the statement it landed in. Your March net worth would move
 * because you fixed an August typo, with nothing on any screen saying so. A
 * revision is therefore a *new* position set carrying today's date, and the one
 * it corrects stays exactly where it was, still speaking for its own dates.
 *
 * **It carries the whole account forward.** §5.2's "a missing row means sold"
 * makes a position set a photograph of everything an account holds, so a set
 * containing only the corrected row would record every other security in the
 * account as sold. The new set is therefore the old set with one row changed
 * and the rest copied across verbatim — which is the read this application
 * already takes of the gap between two statements (§14.7), so copying them
 * forward asserts nothing that was not already being assumed.
 *
 * **It changes numbers, never membership.** Which instruments an account holds
 * is what a statement is for: adding one means resolving a name nobody has seen
 * before against the alias table, and that is the upload flow's job (§4.3). So
 * a revision can say "not 100 units but 120", and can say "zero", and cannot
 * say "and also some Apple". A quantity of zero is stored as zero rather than
 * dropping the row, because a dropped row is unreachable from a table that no
 * longer prints it — the position would be uneditable by the very screen that
 * removed it, and only a fresh statement could bring it back.
 *
 * The write is one statement for the reason `balances.server.ts` gives: a
 * `position_set` that lands without its holdings is not a failed write, it is a
 * successful one meaning "this account now holds nothing", and it would outrank
 * every earlier statement. Here the CTE does a second job as well — the guard
 * that the instrument is still in the account sits inside it, so an account
 * that changed underneath the form writes *nothing at all* rather than a
 * position set that quietly copied the account forward and applied no edit.
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
   * What the instrument is currently quoted at, or null if it never has been.
   *
   * Not a fact about the statement, and here anyway: it is the other operand of
   * a multiplication the *view* performs, and {@link revisePosition} has to
   * know whether the figure it is about to store is one the view can express
   * (see {@link fitsTheMoneyColumn}).
   */
  price: string | null;
  /**
   * The instrument's projected annual dividend per share, or null where no
   * refresh has ever supplied one.
   *
   * Here for {@link CurrentPosition.price}'s reason and no other: since
   * migration 0006 this is the third operand `holding_valued` multiplies the
   * stored quantity by, so {@link revisePosition} has to know whether the
   * figure it is about to store is one the view can express.
   */
  annualDividendPerShare: string | null;
  /**
   * Where the price comes from, of which `fixed` is the seeded USD row's alone
   * (`instrument-resolution.server.ts`).
   *
   * Here for the same reason {@link CurrentPosition.price} is — {@link
   * revisePosition} needs it, and this is the query that already knows it. It
   * is how the write tells a count of shares from a sum of money: §2 stores a
   * cash balance as a quantity of the fixed-price currency, so on those rows
   * the quantity box is money and is held to money's rule.
   */
  priceSource: Selectable<Database["instrument"]>["price_source"];
};

/**
 * A revision that has just been recorded, as it was stored.
 *
 * Deliberately not `CurrentPosition & …`: a price is a market fact this write
 * neither set nor changed, and a caller handed one here would reasonably read
 * it as part of what was recorded.
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
 * What an account's current statement says about one instrument.
 *
 * Resolved through `latest_position_set` rather than through a second
 * `order by as_of_date desc` written here, for §8.2's reason: the tie-break
 * exists in one place and every reader goes through it.
 *
 * Read twice per correction, and for neither of the obvious reasons. The write
 * below reads it to decide whether the correction may be made at all — is the
 * instrument still in the account, does the quantity still point the same way,
 * will the products fit. The Holdings loader reads it to learn the date the
 * correction will carry, so the note under the open row can name it before the
 * click. What it is *not* is the source of the boxes' contents: those are the
 * figures already on the screen, so that a row reading `120.5` opens on `120.5`
 * rather than on the `120.50000000` the column stores.
 *
 * @returns null when the account holds no such instrument, which is also the
 *          answer for an account with no statement at all.
 */
export async function currentPosition(
  accountId: string,
  instrumentId: string,
  db: Kysely<Database> = getDb(),
): Promise<CurrentPosition | null> {
  // Both ids reach here from a URL, so they are checked before they are cast
  // rather than after: `'x'::bigint` is a driver error, not an empty result.
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
    -- Left, exactly as the holding_valued view joins it: an instrument nobody
    -- can quote is still held, and is still correctable.
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
 * `numeric(20, 4)`, as the three products `holding_valued` derives are cast to.
 *
 * Not the columns' own precision — `quantity` is `numeric(20, 8)`, and
 * `cost_basis_per_share`, `quote.price` and `quote.annual_dividend_per_share`
 * are each `numeric(20, 4)`. A quantity inside its column and a per-share
 * figure inside its own can still have a *product* outside this, whichever of
 * the three that figure is. That gap is the whole reason
 * {@link fitsTheMoneyColumn} exists.
 */
const MONEY_PRECISION = 20;

/**
 * The cast's ceiling, as a scaled integer.
 *
 * `numeric(p, s)` must round to under `10^(p - s)`, and a figure held at scale
 * `s` is `10^s` times its own value — so the two exponents cancel and the limit
 * on the scaled integer is exactly `10^p`, whatever the scale happens to be.
 */
const MONEY_LIMIT = 10n ** BigInt(MONEY_PRECISION);

/**
 * What divides the product back down to a money figure.
 *
 * A quantity at scale 8 times a price at scale 4 is a product at scale 12, and
 * the cast the view performs lands it at scale 4.
 */
const SCALE_GAP = 10n ** BigInt(QUANTITY_SCALE);

/**
 * Whether `quantity × perShare` is a figure this application can hold.
 *
 * The view computes three products against the stored quantity —
 * `cast(h.quantity * q.price as numeric(20, 4))`,
 * `cast(h.quantity * h.cost_basis_per_share as numeric(20, 4))` and, since
 * migration 0006, `cast(h.quantity * coalesce(q.annual_dividend_per_share, 0)
 * as numeric(20, 4))` — and a product that will not round to under 10^16 makes
 * that cast raise. Which is a far worse outcome than a refused form: the write
 * succeeds, and every reader that goes through `holding_valued` — Holdings,
 * Analysis, Overview and Account detail — then throws on *every* request.
 * Holdings is the only screen the editor is reachable from, so the row that
 * broke it could not be corrected from the application at all; only `psql`
 * would recover it.
 *
 * Bounding the fields cannot prevent it. Each operand is individually well
 * inside its column — a twelve-digit quantity is legal, and so is a share
 * priced in the hundreds of thousands — and it is only the product that
 * overflows. So the check is on the product, with both operands in hand, at the
 * moment of the write.
 *
 * The price and the dividend rate are the two operands this application never
 * chose — both arrive from the provider, which bounds each to its own column in
 * `price-provider.server.ts`. Neither bound reaches the product: a rate inside
 * `numeric(20, 4)` and a quantity inside `numeric(20, 8)` multiply to as much
 * as 10^28. So the product is checked here, where the quantity is the figure
 * being chosen.
 *
 * Exact, in `bigint`, and rounded the way the cast rounds before it is
 * compared: half away from zero can carry a figure a hair under the limit up to
 * exactly the limit, which is the one case a check on the unrounded product
 * would wave through.
 *
 * Two callers, both at the moment of a write: {@link revisePosition} checks the
 * one row it is restating, and `commitUpload` (`uploads.server.ts`) checks every
 * parsed row of a statement — an upload writes many rows at once, so it is the
 * likelier way in, and one failing row refuses the whole commit there.
 */
export function fitsTheMoneyColumn(quantity: string, perShare: string | null): boolean {
  if (perShare === null) return true;

  const product = toUnits(quantity, QUANTITY_SCALE) * toUnits(perShare, MONEY_SCALE);
  const magnitude = product < 0n ? -product : product;
  const rounded = (magnitude + SCALE_GAP / 2n) / SCALE_GAP;

  return rounded < MONEY_LIMIT;
}

/**
 * Whether two quantities point the same way.
 *
 * Zero points nowhere and matches anything, which is what lets a position be
 * closed out and then reopened in the other direction across two deliberate
 * edits rather than one absent-minded one.
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

  // Before the field validation, deliberately, and for `setBalance`'s reason: a
  // person whose account is closed has a problem no amount of correcting the
  // boxes will fix, and leading with "that is not a number" would bury it.
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

  // Money is recorded to the cent, and on a cash row this box holds money: §2
  // stores a bank balance as a quantity of the fixed-price USD instrument, so
  // this editor is a second door onto the figure `setBalance` writes. The two
  // doors have to refuse the same things, and `signedQuantity` alone does not
  // — it allows the eight places a fractional share genuinely needs, which on a
  // balance is $100.1235, a figure no statement can produce and the Set Balance
  // form would have turned away. The wording is `moneyMagnitude`'s, so the
  // reader who meets both doors meets one rule.
  //
  // Only the quantity. A cost basis is a rate rather than a balance, and
  // `perShareAmount` holds all four places of the column it is prefilled from
  // — narrowing it here would make the box refuse what it had just printed.
  if (before.priceSource === "fixed" && (input.quantity.split(".")[1] ?? "").length > 2) {
    throw new ValidationError({
      quantity: "A balance is recorded to the cent, so it takes at most two decimal places.",
    });
  }

  // The one refusal that is about meaning rather than about form. §2 puts the
  // sign in the quantity, so flipping it does not restate a position — it
  // asserts that an asset has become a debt, which moves household net worth by
  // twice the figure and reads on every screen as though it were an ordinary
  // correction. `balances.server.ts` avoids the same failure by refusing to
  // accept a sign at all; this box has to show one, because it opens containing
  // the number the table prints, so it refuses the change instead.
  if (!sameDirection(before.quantity, input.quantity)) {
    throw new ValidationError({
      quantity:
        `${before.instrumentName} is currently held as ` +
        `${/^-/.test(before.quantity) ? "something owed" : "something held"}, and a correction ` +
        "changes how much rather than which way. Record it as zero first if the position really " +
        "did turn around.",
    });
  }

  // The three multiplications `holding_valued` is about to perform, checked
  // before they are stored rather than discovered when a screen tries to render
  // them. Two of the operands are facts the household cannot influence — the
  // instrument's price and its dividend rate, both from the provider — so those
  // two refusals name the quantity that *was* typed.
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

  // One statement, and every guard is in it.
  //
  // `source` is empty unless the account's current set still carries this
  // instrument, and both writes select from `source` — so an account that
  // changed underneath the form produces no position set rather than one that
  // copied it forward and applied nothing.
  //
  // `greatest` again, having already applied {@link effectiveDate} above: the
  // date was chosen against the set the *guard* read, and this one is evaluated
  // against the set the write actually locks. They are the same set in every
  // case but a race, and in that case this is what keeps the correction from
  // landing behind the statement it corrects.
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
    // `source` was empty by the time the statement ran, so nothing was written
    // — the same race `before === null` catches, lost after the check instead
    // of before it. Reported rather than retried: what the account holds now is
    // not what this form was filled in against.
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
    // The same date the statement applied, computed by the same function rather
    // than read back out of it: `RETURNING` on an `INSERT … SELECT` sees the
    // target table's columns, and `position_set.as_of_date` is not one of
    // `holding`'s.
    asOf,
  };
}

/**
 * The date a correction against a statement of `asOf` will carry.
 *
 * Today, except where the statement being corrected is dated ahead of today —
 * `recordedDate` allows exactly one day of slack, for a household east of UTC —
 * because a correction filed behind the sheet it corrects is a write that
 * appears to succeed and changes no figure anywhere. ISO dates compare as text
 * exactly as they compare as dates, which is the property the whole codebase
 * already stores them for.
 *
 * Exported because the editor says this date to the reader *before* the click,
 * and a note naming a different day than the write carries would be the screen
 * misreporting its own effect. The `greatest` in the statement is this same
 * rule, applied where the row is locked rather than where it is described.
 *
 * Today is read from the server rather than from `current_date` so that one
 * clock answers the question — `latestRecordableDate` reads the same one, and a
 * database in a different timezone would otherwise let a correction be dated a
 * day the validator would have refused.
 */
export function effectiveDate(asOf: IsoDate): IsoDate {
  const today = new Date().toISOString().slice(0, 10);

  return today > asOf ? today : asOf;
}
