#!/usr/bin/env python3
"""
AUDIT HARNESS — generates the test dataset and the independent ground-truth ledger.

Writes into audit/data/:
  accounts.csv          one row per account to create through the UI
  holdings.csv          one row per (account, symbol) position
  balances.csv          one row per bank/liability account balance
  statements/<n>.csv    one brokerage-style statement per securities account
  ledger.json           THE GROUND TRUTH — the app never reads or writes this

Prices are the deterministic figures audit/fake-refresh.ts feeds the application's
own price writer; they are replicated here only to *size* the quantities so account
totals land in a realistic range. Verification re-reads prices from the app.
"""
import csv, json, os, random
from decimal import Decimal, ROUND_HALF_UP

random.seed(20260901)
HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
STMT = os.path.join(DATA, "statements")
os.makedirs(STMT, exist_ok=True)

AS_OF = "2026-08-31"


def price_for(symbol: str) -> Decimal:
    """Mirror of priceFor() in audit/fake-refresh.ts (FNV-1a, 32-bit)."""
    h = 2166136261
    for ch in symbol:
        h = (h ^ ord(ch)) & 0xFFFFFFFF
        h = (h * 16777619) & 0xFFFFFFFF
    return (Decimal(5) + Decimal(h % 90000) / Decimal(100)).quantize(Decimal("0.0001"))


PEOPLE = ["Ana Whitfield", "Ben Whitfield", "Cara Whitfield"]

INSTITUTIONS = ["Fidelity", "Vanguard", "Schwab", "Merrill", "E*Trade",
                "Chase", "Ally", "Citizens", "Wells Fargo", "SoFi"]

CLASSES = [
    ("US Large Cap", "equity"), ("US Small Cap", "equity"),
    ("International Equity", "equity"), ("Emerging Markets", "equity"),
    ("Government Bond", "bond"), ("Corporate Bond", "bond"),
    ("Municipal Bond", "bond"), ("REIT", "other"),
]

# ---------------------------------------------------------------- instruments
LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
symbols, seen = [], set()
while len(symbols) < 220:
    n = random.choice([3, 4, 4, 5])
    s = "".join(random.choice(LETTERS) for _ in range(n))
    if s in seen or s == "USD":
        continue
    seen.add(s)
    symbols.append(s)

instruments = []
for s in symbols:
    cls, asset = random.choice(CLASSES)
    instruments.append({"symbol": s, "name": f"{s} {cls} Fund", "classification": cls,
                        "assetClass": asset, "price": str(price_for(s))})

# ------------------------------------------------------------------- accounts
# (kind, count, tax_treatment choices)
LAYOUT = [("brokerage", 11, ["taxable"]),
          ("401k", 6, ["tax_deferred"]),
          ("ira", 6, ["tax_deferred", "tax_free"]),
          ("bank", 8, ["taxable"]),
          ("liability", 4, ["taxable"])]

accounts, n = [], 0
for kind, count, taxes in LAYOUT:
    for i in range(count):
        n += 1
        accounts.append({
            "key": f"acct{n:02d}",
            "name": f"{kind.upper()} {i + 1} · {random.choice(['Core','Growth','Legacy','Joint','Rollover','Reserve','Everyday','Bridge'])}",
            "institution": random.choice(INSTITUTIONS),
            "kind": kind,
            "owner": PEOPLE[n % len(PEOPLE)],
            "taxTreatment": random.choice(taxes),
        })

SECURITIES = [a for a in accounts if a["kind"] in ("brokerage", "401k", "ira")]
CASHLIKE = [a for a in accounts if a["kind"] in ("bank", "liability")]

# Deliberate shapes. The last brokerage is left empty (no statement at all).
EMPTY = SECURITIES[10]
SINGLE = SECURITIES[0]
MANY = SECURITIES[1]
BIG1, BIG2 = SECURITIES[2], SECURITIES[3]
EMPTY["empty"] = True
seeded = [a for a in SECURITIES if a is not EMPTY]

targets = {}
for a in seeded:
    if a is BIG1:
        targets[a["key"]] = Decimal(random.randint(1_500_000, 1_900_000))
    elif a is BIG2:
        targets[a["key"]] = Decimal(random.randint(1_050_000, 1_400_000))
    else:
        targets[a["key"]] = Decimal(random.randint(11_000, 480_000))

counts = {}
for a in seeded:
    if a is SINGLE:
        counts[a["key"]] = 1
    elif a is MANY:
        counts[a["key"]] = 40
    else:
        counts[a["key"]] = random.randint(6, 28)

# ------------------------------------------------------------------- holdings
# Every one of the 220 symbols is dealt out at least once before any repeats, so
# the pool is genuinely 220 distinct instruments; the rest of each account's slots
# are drawn at random, which is what makes tickers recur across accounts.
pool = symbols[:]
random.shuffle(pool)
deal = iter(pool)

holdings = []          # {account, symbol, quantity, costBasisPerShare}
for a in seeded:
    k = counts[a["key"]]
    picks: list[str] = []
    while len(picks) < k:
        nxt = next(deal, None)
        if nxt is None:
            break
        if nxt not in picks:
            picks.append(nxt)
    while len(picks) < k:
        cand = random.choice(symbols)
        if cand not in picks:
            picks.append(cand)
    # Split the account's target across its positions with uneven weights.
    weights = [random.uniform(0.4, 3.0) for _ in picks]
    tw = sum(weights)
    for sym, w in zip(picks, weights):
        price = price_for(sym)
        slice_value = targets[a["key"]] * Decimal(w) / Decimal(tw)
        qty = (slice_value / price).quantize(Decimal("0.00000001"), rounding=ROUND_HALF_UP)
        if qty <= 0:
            qty = Decimal("0.00000001")
        basis = (price * Decimal(random.uniform(0.45, 1.55))).quantize(
            Decimal("0.0001"), rounding=ROUND_HALF_UP)
        holdings.append({"account": a["key"], "accountName": a["name"], "symbol": sym,
                         "quantity": str(qty), "costBasisPerShare": str(basis)})

# ------------------------------------------------------------------- balances
balances = []
for a in CASHLIKE:
    if a["kind"] == "bank":
        amt = Decimal(random.randint(2_000, 85_000)) + Decimal(random.randint(0, 99)) / 100
    else:
        amt = Decimal(random.randint(5_000, 410_000)) + Decimal(random.randint(0, 99)) / 100
    balances.append({"account": a["key"], "accountName": a["name"], "kind": a["kind"],
                     "amount": str(amt.quantize(Decimal("0.01")))})

# --------------------------------------------------------------------- output
with open(os.path.join(DATA, "accounts.csv"), "w", newline="") as f:
    w = csv.DictWriter(f, fieldnames=["key", "name", "institution", "kind", "owner",
                                      "taxTreatment", "empty"])
    w.writeheader()
    for a in accounts:
        w.writerow({**{k: a.get(k, "") for k in
                       ["key", "name", "institution", "kind", "owner", "taxTreatment"]},
                    "empty": "yes" if a.get("empty") else ""})

with open(os.path.join(DATA, "holdings.csv"), "w", newline="") as f:
    w = csv.DictWriter(f, fieldnames=["account", "accountName", "symbol", "quantity",
                                      "costBasisPerShare"])
    w.writeheader()
    w.writerows(holdings)

with open(os.path.join(DATA, "balances.csv"), "w", newline="") as f:
    w = csv.DictWriter(f, fieldnames=["account", "accountName", "kind", "amount"])
    w.writeheader()
    w.writerows(balances)

# One statement per securities account, in a plausible brokerage shape.
for a in seeded:
    rows = [h for h in holdings if h["account"] == a["key"]]
    path = os.path.join(STMT, f"{a['key']}.csv")
    with open(path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["Symbol", "Description", "Quantity", "Cost Basis Per Share", "As Of"])
        for h in rows:
            inst = next(i for i in instruments if i["symbol"] == h["symbol"])
            w.writerow([h["symbol"], inst["name"], h["quantity"], h["costBasisPerShare"], AS_OF])

ledger = {
    "asOf": AS_OF,
    "people": PEOPLE,
    "instruments": instruments,
    "accounts": accounts,
    "holdings": holdings,
    "balances": balances,
    "counts": {
        "people": len(PEOPLE),
        "accounts": len(accounts),
        "securitiesAccountsSeeded": len(seeded),
        "emptyAccounts": 1,
        "distinctInstruments": len(symbols),
        "holdingRows": len(holdings),
        "balanceRows": len(balances),
    },
    "shapes": {"single": SINGLE["key"], "many": MANY["key"], "empty": EMPTY["key"],
               "big": [BIG1["key"], BIG2["key"]]},
}
with open(os.path.join(DATA, "ledger.json"), "w") as f:
    json.dump(ledger, f, indent=1)

print(json.dumps(ledger["counts"], indent=2))
print("distinct symbols used:", len({h["symbol"] for h in holdings}))
print("symbols in >1 account:",
      sum(1 for s in symbols if len({h["account"] for h in holdings if h["symbol"] == s}) > 1))
