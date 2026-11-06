// Run with the server stopped. Store also performs this migration at startup.
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { Store } from "../server/store.js";
const path = resolve(process.env.DATA_DIR || "data", "cafe.sqlite");
function history(db) {
  const orders = db
    .prepare("SELECT id,day,number,data FROM orders ORDER BY id")
    .all();
  const ledger = db
    .prepare(
      "SELECT id,day,at,kind,method,amount,orderId,note FROM ledger ORDER BY id",
    )
    .all();
  return {
    orders: orders.length,
    ledger: ledger.length,
    digest: createHash("sha256")
      .update(JSON.stringify({ orders, ledger }))
      .digest("hex"),
  };
}
let before = null;
if (existsSync(path)) {
  const db = new DatabaseSync(path, { readOnly: true });
  before = history(db);
  db.close();
}
const store = new Store(path);
const after = history(store.db);
store.db.close();
if (before && before.digest !== after.digest)
  throw Error(
    "移行前後の履歴に差異があります。バックアップを確認してください。",
  );
console.log(
  JSON.stringify({
    schema: 2,
    orders: after.orders,
    ledger: after.ledger,
    historyUnchanged: before ? before.digest === after.digest : true,
  }),
);
