#!/usr/bin/env python3
"""
AUDIT HARNESS — the three-way reconciliation: ledger -> database -> UI.

  python3 audit/verify.py audit/data/ui-cycle1.json
"""
import json, os, subprocess, sys
from decimal import Decimal, ROUND_HALF_UP

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
DSN = ["psql", "-h", "127.0.0.1", "-U", "portfolio", "-d", "portfolio", "-At", "-F", "\t", "-c"]
ENV = {**os.environ, "PGPASSWORD": "portfolio"}


def sql(q):
    out = subprocess.run(DSN + [q], capture_output=True, text=True, env=ENV, check=True).stdout
    return [line.split("\t") for line in out.strip().split("\n") if line.strip()]


def q4(d):
    return Decimal(d).quantize(Decimal("0.0001"), rounding=ROUND_HALF_UP)


LEDGER = os.environ.get("LEDGER", os.path.join(DATA, "ledger.json"))
L = json.load(open(LEDGER))
UI = json.load(open(sys.argv[1])) if len(sys.argv) > 1 and sys.argv[1] != "-" else None
print("ledger:", os.path.basename(LEDGER))

# ---------------------------------------------------------------- 1. prices
prices = {sym: Decimal(p) for sym, p in
          sql("select i.symbol, q.price from instrument i join quote q on q.instrument_id=i.id "
              "where i.symbol is not null")}

# ------------------------------------------------- 2. expected, from ledger
expected_by_account = {}
for h in L["holdings"]:
    if h.get("unpriced"):
        expected_by_account.setdefault(h["accountName"], Decimal(0))
        continue
    price = prices.get(h["symbol"])
    if price is None:
        print(f"!! no price for {h['symbol']}")
        continue
    v = q4(Decimal(h["quantity"]) * price)
    expected_by_account[h["accountName"]] = expected_by_account.get(h["accountName"], Decimal(0)) + v
for b in L["balances"]:
    amt = Decimal(b["amount"])
    if b["kind"] == "liability":
        amt = -amt
    expected_by_account[b["accountName"]] = expected_by_account.get(b["accountName"], Decimal(0)) + q4(amt)

expected_total = sum(expected_by_account.values(), Decimal(0))

# ------------------------------------------------ 3. database: stored rows
db_rows = sql("""
  select a.name, count(*), cast(coalesce(sum(hv.value),0) as numeric(20,4))
  from account a left join holding_valued hv on hv.account_id = a.id
  where a.closed_at is null
  group by a.name order by a.name
""")
db_by_account = {r[0]: Decimal(r[2]) for r in db_rows}
db_counts = {r[0]: int(r[1]) for r in db_rows}
db_total = Decimal(sql("select cast(coalesce(sum(value),0) as numeric(20,4)) from holding_valued")[0][0])

# raw stored quantities vs ledger (write-layer check)
stored = {}
for name, sym, qty in sql("""
  select a.name, i.symbol, h.quantity
  from account a
  join holding h on h.position_set_id = latest_position_set(a.id)
  join instrument i on i.id = h.instrument_id
  where a.closed_at is null
"""):
    stored[(name, sym)] = Decimal(qty)

print("=" * 78)
print("LAYER 1 — write: ledger quantities vs stored rows")
missing, wrong = [], []
for h in L["holdings"]:
    k = (h["accountName"], h["symbol"])
    if k not in stored:
        missing.append(k)
    elif stored[k] != Decimal(h["quantity"]):
        wrong.append((k, h["quantity"], str(stored[k])))
ledger_keys = {(h["accountName"], h["symbol"]) for h in L["holdings"]}
extra = [k for k in stored if k not in ledger_keys and k[1] != "USD"]
print(f"  ledger rows {len(L['holdings'])}  stored securities rows "
      f"{len([k for k in stored if k[1] != 'USD'])}")
print(f"  missing {len(missing)}  quantity mismatches {len(wrong)}  unexpected {len(extra)}")
for k in missing[:5]:
    print("   MISSING", k)
for w in wrong[:5]:
    print("   WRONG", w)

print()
print("LAYER 2 — storage/computation: expected (ledger x captured price) vs SQL aggregate")
worst = []
for name, exp in sorted(expected_by_account.items()):
    got = db_by_account.get(name)
    if got is None:
        print(f"   ACCOUNT ABSENT FROM DB AGGREGATE: {name}")
        continue
    if abs(exp - got) > Decimal("0.01"):
        worst.append((name, exp, got, got - exp))
print(f"  accounts compared: {len(expected_by_account)}   deviating: {len(worst)}")
for w in sorted(worst, key=lambda x: abs(x[3]), reverse=True)[:15]:
    print(f"   {w[0]:<28} expected {w[1]:>16,.4f}  db {w[2]:>16,.4f}  diff {w[3]:>+14,.4f}")

print()
print(f"  EXPECTED GRAND TOTAL : {expected_total:>18,.4f}")
print(f"  DATABASE GRAND TOTAL : {db_total:>18,.4f}")
print(f"  difference           : {db_total - expected_total:>+18,.4f}")

if UI:
    print()
    print("LAYER 3 — rendering: SQL aggregate vs UI")
    ui_total = Decimal(UI["overview"]["headline"])
    print(f"  UI overview headline : {ui_total:>18,.2f}   (db rounds to {db_total.quantize(Decimal('0.01'), ROUND_HALF_UP):,.2f})")
    ui_accounts = {a["name"]: Decimal(a["amount"]) for a in UI["overview"]["accounts"] if a["amount"]}
    dev = []
    for name, amt in ui_accounts.items():
        d = db_by_account.get(name)
        if d is None:
            print(f"   UI ROW WITH NO DB ACCOUNT: {name}")
            continue
        if abs(d.quantize(Decimal("0.01"), ROUND_HALF_UP) - amt) > Decimal("0.005"):
            dev.append((name, d, amt))
    print(f"  UI account rows: {len(ui_accounts)}   deviating from db: {len(dev)}")
    for d in dev[:10]:
        print(f"   {d[0]:<28} db {d[1]:>16,.4f}  ui {d[2]:>16,.2f}")
    ht = UI["holdings"]["total"].get("Value")
    if ht:
        print(f"  Holdings footer Value: {ht}")
    for p in UI["analysis"]:
        if p.get("total"):
            print(f"  Analysis '{p['title']}' ring total: {p['total']}")

# ------------------------------------------------- 4. dividends and basis
divs = {sym: (Decimal(d) if d else Decimal(0)) for sym, d in
        sql("select i.symbol, coalesce(q.annual_dividend_per_share,0) from instrument i "
            "join quote q on q.instrument_id=i.id where i.symbol is not null")}
exp_div = sum((q4(Decimal(h["quantity"]) * divs.get(h["symbol"], Decimal(0)))
               for h in L["holdings"] if not h.get("unpriced")), Decimal(0))
db_div = Decimal(sql("select cast(coalesce(sum(annual_dividend),0) as numeric(20,4)) from holding_valued")[0][0])
print()
print("DIVIDENDS")
print(f"  expected {exp_div:>16,.4f}   db {db_div:>16,.4f}   diff {db_div - exp_div:>+12,.4f}")

exp_basis = sum((q4(Decimal(h["quantity"]) * Decimal(h["costBasisPerShare"]))
                 for h in L["holdings"]), Decimal(0))
# PLANTRUST has no symbol in the database, so key stored rows on name for it.
db_basis = Decimal(sql("select cast(coalesce(sum(cost_basis),0) as numeric(20,4)) from holding_valued "
                       "where price_source <> 'fixed'")[0][0])
print("COST BASIS (securities only)")
print(f"  expected {exp_basis:>16,.4f}   db {db_basis:>16,.4f}   diff {db_basis - exp_basis:>+12,.4f}")

print()
print("SANITY — coverage")
print("  db accounts in aggregate:", len(db_by_account))
print("  db holding rows counted :", sum(db_counts.values()))
