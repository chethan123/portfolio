/** AUDIT — cycle 2: add accounts, upload a lot-level statement, set balances. */
import fs from "node:fs";
import path from "node:path";
import { BASE, DATA, open, shot } from "./lib.mjs";
import { accountIds, createAccount, setBalance, uploadStatement } from "./flows.mjs";

const C = JSON.parse(fs.readFileSync(path.join(DATA, "cycle2.json"), "utf8"));
const L2 = JSON.parse(fs.readFileSync(path.join(DATA, "ledger-cycle2.json"), "utf8"));
const { browser, page } = await open();
const log = (...a) => console.log(...a);

for (const a of C.accounts) await createAccount(page, a);
log("accounts added:", C.accounts.length);

const ids = await accountIds(page);
const instruments = new Map(L2.instruments.map((i) => [i.symbol, i]));
const res = await uploadStatement(page, {
  accountName: "BROKERAGE 12 · Lots",
  file: path.join(DATA, "statements", "acct36.csv"),
  columns: { instrument: "Symbol", quantity: "Quantity", name: "Description",
             costBasis: "Cost Basis Per Share", asOf: "As Of", accountNumber: "__none__" },
  instruments,
});
log("lot statement:", res.diff, "|", res.url);
await shot(page, "40-cycle2-lots-receipt");

for (const b of C.balances) {
  await setBalance(page, { accountId: ids.get(b.accountName), amount: b.amount, asOf: L2.asOf });
}
log("balances set:", C.balances.length);
await browser.close();
