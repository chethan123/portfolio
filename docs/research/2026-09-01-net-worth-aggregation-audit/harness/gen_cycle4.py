#!/usr/bin/env python3
"""AUDIT — cycle 4: re-uploads over accounts that already hold a statement.

Four shapes:
  A  same as-of date, quantities changed      -> replaces (tie-break by created_at)
  B  later as-of date, positions added+removed -> replaces
  C  EARLIER as-of date                        -> must NOT become the account's
                                                  current statement
  D  majority removal                          -> replaces, needs confirmation
"""
import csv, json, os, random
from decimal import Decimal
random.seed(9090)
HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data"); STMT = os.path.join(DATA, "statements")
L = json.load(open(os.path.join(DATA, "ledger-cycle3.json")))

byacct = {}
for h in L["holdings"]:
    byacct.setdefault(h["accountName"], []).append(h)
inst = {i["symbol"]: i for i in L["instruments"]}

PLAN = [
    ("A", "BROKERAGE 2 · Legacy", "acct02b", "2026-08-31", "requantify"),
    ("B", "BROKERAGE 5 · Legacy", "acct05b", "2026-09-01", "churn"),
    ("C", "BROKERAGE 7 · Reserve", "acct07b", "2026-06-30", "earlier"),
    ("D", "BROKERAGE 9 · Growth", "acct09b", "2026-08-31", "gut"),
]

expected = {}
for tag, name, key, as_of, mode in PLAN:
    rows = byacct[name]
    out = []
    if mode == "requantify":
        for h in rows:
            q = (Decimal(h["quantity"]) * Decimal("1.1")).quantize(Decimal("0.00000001"))
            out.append({**h, "quantity": str(q)})
    elif mode == "churn":
        keep = rows[: max(1, len(rows) - 2)]
        for h in keep:
            q = (Decimal(h["quantity"]) * Decimal("0.9")).quantize(Decimal("0.00000001"))
            out.append({**h, "quantity": str(q)})
        for sym in random.sample([s for s in inst if s not in {r["symbol"] for r in rows}], 3):
            out.append({"account": key, "accountName": name, "symbol": sym,
                        "quantity": str(Decimal(random.randint(100, 90000)) / 100),
                        "costBasisPerShare": inst[sym]["price"]})
    elif mode == "earlier":
        for h in rows:
            q = (Decimal(h["quantity"]) * Decimal("0.3")).quantize(Decimal("0.00000001"))
            out.append({**h, "quantity": str(q)})
    elif mode == "gut":
        for h in rows[:2]:
            out.append({**h})
    with open(os.path.join(STMT, f"{key}.csv"), "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["Symbol", "Description", "Quantity", "Cost Basis Per Share", "As Of"])
        for r in out:
            w.writerow([r["symbol"], inst[r["symbol"]]["name"], r["quantity"],
                        r["costBasisPerShare"], as_of])
    expected[name] = {"tag": tag, "key": key, "asOf": as_of, "mode": mode,
                      "rows": out, "replaces": mode != "earlier"}

# The ledger after cycle 4: three accounts replaced, the earlier-dated one untouched.
L4 = json.loads(json.dumps(L))
L4["holdings"] = [h for h in L4["holdings"]
                  if not (h["accountName"] in expected and expected[h["accountName"]]["replaces"])]
for name, e in expected.items():
    if e["replaces"]:
        for r in e["rows"]:
            L4["holdings"].append({"account": e["key"], "accountName": name,
                                   "symbol": r["symbol"], "quantity": r["quantity"],
                                   "costBasisPerShare": r["costBasisPerShare"]})
L4["counts"]["holdingRows"] = len(L4["holdings"])
json.dump(L4, open(os.path.join(DATA, "ledger-cycle4.json"), "w"), indent=1)
json.dump({n: {k: v for k, v in e.items() if k != "rows"} | {"positions": len(e["rows"])}
           for n, e in expected.items()},
          open(os.path.join(DATA, "cycle4.json"), "w"), indent=1)
for n, e in expected.items():
    print(f"{e['tag']}  {n:<24} {e['mode']:<11} as-of {e['asOf']}  "
          f"{len(byacct[n])} -> {len(e['rows'])} positions  replaces={e['replaces']}")
