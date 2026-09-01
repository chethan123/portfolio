#!/usr/bin/env python3
"""
AUDIT — an independent implementation of the valuation rule, over the raw stored
rows, with no reference to the app's SQL. Answers: does `holding_valued` agree
with quantity x price summed by hand?
"""
import os, subprocess
from decimal import Decimal, ROUND_HALF_UP
DSN = ["psql", "-h", "127.0.0.1", "-U", "portfolio", "-d", "portfolio", "-At", "-F", "\t", "-c"]
ENV = {**os.environ, "PGPASSWORD": "portfolio"}
def sql(q):
    out = subprocess.run(DSN + [q], capture_output=True, text=True, env=ENV, check=True).stdout
    return [l.split("\t") for l in out.strip().split("\n") if l.strip()]

# Raw rows: open accounts, their latest position set, quantity, and the quote.
rows = sql("""
  select a.id, a.name, h.instrument_id, h.quantity,
         coalesce(cast(q.price as text), ''), coalesce(cast(q.annual_dividend_per_share as text),''),
         coalesce(cast(h.cost_basis_per_share as text),'')
  from account a
  join holding h on h.position_set_id = latest_position_set(a.id)
  left join quote q on q.instrument_id = h.instrument_id
  where a.closed_at is null
""")
q4 = lambda d: Decimal(d).quantize(Decimal("0.0001"), rounding=ROUND_HALF_UP)
total = Decimal(0); div = Decimal(0); basis = Decimal(0)
per_account = {}
priced = 0
for _id, name, _inst, qty, price, rate, cb in rows:
    if price:
        v = q4(Decimal(qty) * Decimal(price)); total += v; priced += 1
        per_account[name] = per_account.get(name, Decimal(0)) + v
    else:
        per_account.setdefault(name, Decimal(0))
    div += q4(Decimal(qty) * Decimal(rate or 0))
    if cb: basis += q4(Decimal(qty) * Decimal(cb))

db = sql("select cast(coalesce(sum(value),0) as numeric(20,4)), "
         "cast(coalesce(sum(annual_dividend),0) as numeric(20,4)), "
         "cast(coalesce(sum(cost_basis),0) as numeric(20,4)), count(*), "
         "count(*) filter (where is_priced) from holding_valued")[0]
print(f"rows read        : {len(rows):>6}   view rows      : {db[3]}")
print(f"priced by hand   : {priced:>6}   view is_priced : {db[4]}")
print(f"value   by hand  : {total:>18,.4f}   view: {Decimal(db[0]):>18,.4f}   diff {total-Decimal(db[0]):+.4f}")
print(f"dividend by hand : {div:>18,.4f}   view: {Decimal(db[1]):>18,.4f}   diff {div-Decimal(db[1]):+.4f}")
print(f"basis    by hand : {basis:>18,.4f}   view: {Decimal(db[2]):>18,.4f}   diff {basis-Decimal(db[2]):+.4f}")

bad = 0
for name, amount in sql("""
  select a.name, cast(coalesce(sum(hv.value),0) as numeric(20,4))
  from account a left join holding_valued hv on hv.account_id=a.id
  where a.closed_at is null group by a.name"""):
    mine = per_account.get(name, Decimal(0))
    if mine != Decimal(amount):
        bad += 1
        print(f"  ACCOUNT MISMATCH {name}: by hand {mine} vs view {amount}")
print(f"per-account rows compared: {len(per_account)}   mismatches: {bad}")
