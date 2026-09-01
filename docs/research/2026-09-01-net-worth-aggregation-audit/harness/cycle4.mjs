/** AUDIT — cycle 4: re-upload statements over accounts that already hold one. */
import fs from "node:fs";
import path from "node:path";
import { DATA, open, shot } from "./lib.mjs";
import { uploadStatement } from "./flows.mjs";

const C = JSON.parse(fs.readFileSync(path.join(DATA, "cycle4.json"), "utf8"));
const L = JSON.parse(fs.readFileSync(path.join(DATA, "ledger-cycle4.json"), "utf8"));
const instruments = new Map(L.instruments.map((i) => [i.symbol, i]));
const { browser, page } = await open();
for (const [name, e] of Object.entries(C)) {
  const res = await uploadStatement(page, {
    accountName: name,
    file: path.join(DATA, "statements", `${e.key}.csv`),
    columns: { instrument: "Symbol", quantity: "Quantity", name: "Description",
               costBasis: "Cost Basis Per Share", asOf: "As Of", accountNumber: "__none__" },
    instruments,
  });
  console.log(`${e.tag} ${name}: ${res.diff} -> ${res.url}`);
  if (e.tag === "D") await shot(page, "60-cycle4-majority-removal-receipt");
  if (e.tag === "C") await shot(page, "61-cycle4-backdated-receipt");
}
await browser.close();
