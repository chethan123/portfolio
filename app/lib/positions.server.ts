// Corrects one position in place on Holdings (DESIGN.md §5.4) — balances.server.ts for
// accounts holding more than one thing. Same three rules: appends, never edits (an update would
// silently restate every plotted date back to the statement it landed in); carries the whole
// account forward (a set with only the corrected row would record everything else as sold, §5.2);
// changes numbers, never membership (adding an instrument is the upload flow's job, §4.3 — a
// sold-out position is stored as zero, never dropped). One statement (balances.server.ts's
// reason); the CTE also guards the instrument is still on the account.
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

export const positionInput = z.object({
  quantity: signedQuantity("A quantity"),
  costBasisPerShare: perShareAmount("A cost basis"),
});

export type PositionInput = z.infer<typeof positionInput>;

export type CurrentPosition = {
  accountId: string;
  instrumentId: string;
  instrumentName: string;
  // Signed, as stored: negative for something owed.
  quantity: string;
  // Null when no statement ever carried one (401k statements routinely don't).
  costBasisPerShare: string | null;
  asOf: IsoDate;
  // The other operand of a multiplication the view performs — revisePosition needs it to check
  // fitsTheMoneyColumn before storing.
  price: string | null;
  // Since migration 0006, the third operand holding_valued multiplies the quantity by.
  annualDividendPerShare: string | null;
  // 'fixed' = the seeded USD row only. Needed so revisePosition can tell a share count from a
  // sum of money — §2 stores a cash balance as a quantity of fixed-price currency.
  priceSource: Selectable<Database["instrument"]>["price_source"];
};

// Not CurrentPosition & …: a price is a market fact this write never set, and a caller handed
// one would reasonably read it as part of what got recorded.
export type RevisedPosition = {
  accountId: string;
  accountName: string;
  instrumentId: string;
  instrumentName: string;
  quantity: string;
  costBasisPerShare: string | null;
  // Date the new position set carries — not always today.
  asOf: IsoDate;
};

// Resolved via latest_position_set (§8.2). Read twice per correction (the write checks whether
// it may apply; the Holdings loader reads the date it'll carry) — not the source of the boxes'
// contents, which are the figures already on screen (120.5 opens as 120.5, not 120.50000000).
// Returns null for no such instrument, and for an account with no statement at all.
export async function currentPosition(
  accountId: string,
  instrumentId: string,
  db: Kysely<Database> = getDb(),
): Promise<CurrentPosition | null> {
  // Checked before cast: 'x'::bigint is a driver error, not an empty result.
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
    -- Left, as holding_valued joins it: an unquotable instrument is still held, still correctable.
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

// numeric(20, 4), the view's cast on its three products — not the columns' own precision:
// each operand can fit its column while the product doesn't (why this check exists at all).
const MONEY_PRECISION = 20;

// numeric(p, s) rounds under 10^(p-s); a figure at scale s is 10^s times itself, so exponents
// cancel and the limit is 10^p regardless of scale.
const MONEY_LIMIT = 10n ** BigInt(MONEY_PRECISION);

// Scale 8 x scale 4 = a scale-12 product; the view casts it down to scale 4.
const SCALE_GAP = 10n ** BigInt(QUANTITY_SCALE);

// quantity x perShare overflowing numeric(20,4) makes the view's cast raise on every future
// read (not just a refused form) — Holdings included, so only psql could recover it. Can't be
// prevented by bounding the fields alone (each can be in-column, only the product overflows),
// so this checks the product itself, exact in bigint, rounded the way the cast rounds (so a
// hair-under figure that rounds up to the limit is still caught). Called at every write:
// revisePosition (one row) and commitUpload (every parsed row).
export function fitsTheMoneyColumn(quantity: string, perShare: string | null): boolean {
  if (perShare === null) return true;

  const product = toUnits(quantity, QUANTITY_SCALE) * toUnits(perShare, MONEY_SCALE);
  const magnitude = product < 0n ? -product : product;
  const rounded = (magnitude + SCALE_GAP / 2n) / SCALE_GAP;

  return rounded < MONEY_LIMIT;
}

// Zero points nowhere and matches anything — lets a position close then reopen the other way
// across two deliberate edits, rather than one absent-minded one.
function sameDirection(before: string, after: string): boolean {
  const negative = (value: string) => /^-/.test(value) && !/^-0+(\.0+)?$/.test(value);
  const zero = (value: string) => /^-?0+(\.0+)?$/.test(value);

  return zero(before) || zero(after) || negative(before) === negative(after);
}

export async function revisePosition(
  accountId: string,
  instrumentId: string,
  raw: unknown,
  db: Kysely<Database> = getDb(),
): Promise<RevisedPosition> {
  const account = await getAccount(accountId, db);

  // Before field validation: a closed account isn't fixable by correcting the form.
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

  // On a cash row this box holds money (§2): a second door onto what setBalance writes, so it
  // must refuse the same things — signedQuantity alone allows 8 places, moneyMagnitude only 2.
  if (before.priceSource === "fixed" && (input.quantity.split(".")[1] ?? "").length > 2) {
    throw new ValidationError({
      quantity: "A balance is recorded to the cent, so it takes at most two decimal places.",
    });
  }

  // Flipping the sign (§2) asserts an asset became a debt, moving net worth by twice the figure
  // while reading as an ordinary correction. balances.server.ts refuses signs outright; this box
  // must show one (it opens containing the printed number), so it refuses the change instead.
  if (!sameDirection(before.quantity, input.quantity)) {
    throw new ValidationError({
      quantity:
        `${before.instrumentName} is currently held as ` +
        `${/^-/.test(before.quantity) ? "something owed" : "something held"}, and a correction ` +
        "changes how much rather than which way. Record it as zero first if the position really " +
        "did turn around.",
    });
  }

  // The three multiplications the view will perform, checked before storage. Price and
  // dividend rate aren't household-editable, so those refusals name the quantity instead.
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

  // One statement, every guard in it: `source` is empty unless the current set still carries
  // this instrument, and both writes select from it. `greatest` re-runs effectiveDate's logic
  // against the set the write actually locks (same set except in a race), so the correction
  // can't land behind the statement it corrects.
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
    // source was empty by the time the statement ran — the same race the before===null check
    // catches, lost after it ran. Reported, not retried.
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
    // Recomputed by the same function as the write: RETURNING on this INSERT…SELECT sees
    // holding's columns, and as_of_date isn't one of them.
    asOf,
  };
}

// today, unless asOf is ahead of it (recordedDate allows one day east of UTC) — a correction
// filed behind the sheet it corrects would appear to succeed and change nothing. Exported so
// the editor can name this date before the click; `greatest` in the write applies the same
// rule where the row is locked. Server clock, not current_date, so it agrees with
// latestRecordableDate.
export function effectiveDate(asOf: IsoDate): IsoDate {
  const today = new Date().toISOString().slice(0, 10);

  return today > asOf ? today : asOf;
}
