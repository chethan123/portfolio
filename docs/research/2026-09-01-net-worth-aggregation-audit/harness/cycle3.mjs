/** AUDIT — cycle 3: correct holdings through the Holdings row editor. */
import fs from "node:fs";
import path from "node:path";
import { DATA, open, shot } from "./lib.mjs";
import { editHolding } from "./flows.mjs";

const edits = JSON.parse(fs.readFileSync(path.join(DATA, "cycle3-edits.json"), "utf8"));
const { browser, page } = await open();
let n = 0;
for (const e of edits) {
  await editHolding(page, {
    accountId: e.accountId, instrumentId: e.instrumentId,
    quantity: e.newQuantity, costBasisPerShare: e.costBasisPerShare,
  });
  n += 1;
  if (n === 1) await shot(page, "50-cycle3-edit-saved");
}
console.log("edits applied:", n);
await browser.close();
