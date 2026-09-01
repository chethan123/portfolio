#!/usr/bin/env python3
"""AUDIT — cycle 2 data: incremental accounts, plus a LOT-LEVEL statement
(the same ticker on several lines) which the app must fold into one position."""
import csv, json, os, random
from decimal import Decimal, ROUND_HALF_UP
import importlib.util

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
STMT = os.path.join(DATA, "statements")
random.seed(777)

spec = importlib.util.spec_from_file_location("gen", os.path.join(HERE, "gen_data.py"))
# gen_data writes files on import, so replicate only the price function here.
def price_for(symbol):
    h = 2166136261
    for ch in symbol:
        h = (h ^ ord(ch)) & 0xFFFFFFFF
        h = (h * 16777619) & 0xFFFFFFFF
    return (Decimal(5) + Decimal(h % 90000) / Decimal(100)).quantize(Decimal("0.0001"))

L = json.load(open(os.path.join(DATA, "ledger.json")))
AS_OF = "2026-08-31"
existing = [i["symbol"] for i in L["instruments"]]

NEW_ACCOUNTS = [
    {"key": "acct36", "name": "BROKERAGE 12 · Lots", "institution": "Fidelity",
     "kind": "brokerage", "owner": "Ana Whitfield", "taxTreatment": "taxable"},
    {"key": "acct37", "name": "BANK 9 · Extra", "institution": "Ally",
     "kind": "bank", "owner": "Ben Whitfield", "taxTreatment": "taxable"},
    {"key": "acct38", "name": "LIABILITY 5 · Extra", "institution": "Chase",
     "kind": "liability", "owner": "Cara Whitfield", "taxTreatment": "taxable"},
]

# Five brand-new symbols, five recycled ones.
NEW_SYMS = ["ZQXA", "ZQXB", "ZQXC", "ZQXD", "ZQXE"]
REUSED = random.sample(existing, 5)
CLASSES = [("US Large Cap", "equity"), ("Corporate Bond", "bond"), ("REIT", "other"),
           ("US Small Cap", "equity"), ("Government Bond", "bond")]

new_instruments = [{"symbol": s, "name": f"{s} {c[0]} Fund", "classification": c[0],
                    "assetClass": c[1], "price": str(price_for(s))}
                   for s, c in zip(NEW_SYMS, CLASSES)]

# Each symbol is split across 1..4 lots on the statement; the ledger records the sum.
lines, ledger_rows = [], []
for sym in NEW_SYMS + REUSED:
    lots = random.randint(1, 4)
    total_q = Decimal(0)
    weighted = Decimal(0)
    for _ in range(lots):
        q = Decimal(random.randint(1_00, 900_00)) / Decimal(100)
        b = (price_for(sym) * Decimal(random.uniform(0.5, 1.5))).quantize(Decimal("0.0001"))
        lines.append([sym, f"{sym} lot", str(q), str(b), AS_OF])
        total_q += q
        weighted += q * b
    avg = (weighted / total_q).quantize(Decimal("0.0001"), rounding=ROUND_HALF_UP)
    ledger_rows.append({"account": "acct36", "accountName": "BROKERAGE 12 · Lots",
                        "symbol": sym, "quantity": str(total_q.quantize(Decimal("0.00000001"))),
                        "costBasisPerShare": str(avg), "lots": lots})

random.shuffle(lines)   # lots of one symbol are NOT adjacent — the harder case
with open(os.path.join(STMT, "acct36.csv"), "w", newline="") as f:
    w = csv.writer(f)
    w.writerow(["Symbol", "Description", "Quantity", "Cost Basis Per Share", "As Of"])
    w.writerows(lines)

new_balances = [
    {"account": "acct37", "accountName": "BANK 9 · Extra", "kind": "bank", "amount": "47250.75"},
    {"account": "acct38", "accountName": "LIABILITY 5 · Extra", "kind": "liability", "amount": "312400.10"},
]

L2 = json.loads(json.dumps(L))
L2["accounts"] += NEW_ACCOUNTS
L2["instruments"] += new_instruments
L2["holdings"] += ledger_rows
L2["balances"] += new_balances
L2["counts"]["accounts"] = len(L2["accounts"])
L2["counts"]["holdingRows"] = len(L2["holdings"])
json.dump(L2, open(os.path.join(DATA, "ledger-cycle2.json"), "w"), indent=1)
json.dump({"accounts": NEW_ACCOUNTS, "instruments": new_instruments,
           "balances": new_balances, "statementLines": len(lines),
           "positions": len(ledger_rows)},
          open(os.path.join(DATA, "cycle2.json"), "w"), indent=1)
print(f"statement lines {len(lines)} -> {len(ledger_rows)} positions "
      f"({sum(r['lots'] for r in ledger_rows)} lots)")
