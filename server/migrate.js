// Historical order JSON and ledger amounts remain unchanged.
export function migrate(db) {
  if (db.prepare("PRAGMA user_version").get().user_version >= 2) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    const has = (t, c) =>
      db
        .prepare(`PRAGMA table_info(${t})`)
        .all()
        .some((x) => x.name === c);
    if (!has("catalog", "category"))
      db.exec(
        "ALTER TABLE catalog ADD COLUMN category TEXT NOT NULL DEFAULT 'legacy'",
      );
    if (!has("ledger", "discount"))
      db.exec(
        "ALTER TABLE ledger ADD COLUMN discount INTEGER NOT NULL DEFAULT 0",
      );
    if (!has("ledger", "couponUses"))
      db.exec(
        "ALTER TABLE ledger ADD COLUMN couponUses INTEGER NOT NULL DEFAULT 0",
      );
    const rows = [
      ["plain", "トッピングパンケーキ", "product", 300, 100, "standard"],
      ["special", "スペシャル", "product", 400, 0, "special"],
      ["choco", "チョコ", "topping", 0, 100, "syrup"],
      ["maple", "メープル", "topping", 0, 0, "syrup"],
      ["berry", "いちご", "topping", 0, 60, "syrup"],
      ["sprinkles", "チョコスプレー", "topping", 50, 0, "normal"],
      ["oreo", "オレオ", "topping", 50, 0, "normal"],
      ["cream", "ホイップ", "topping", 50, 80, "normal"],
      ["ice", "アイス", "topping", 100, 0, "ice"],
    ];
    const put = db.prepare(
      `INSERT INTO catalog(id,name,kind,price,stock,active,category) VALUES(?,?,?,?,?,1,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,price=excluded.price,category=excluded.category`,
    );
    for (const row of rows) put.run(...row);
    db.exec(
      "UPDATE catalog SET active=0 WHERE category='legacy' OR name LIKE '%粉砂糖%'",
    );
    db.exec(`CREATE TABLE IF NOT EXISTS customer_orders(tokenHash TEXT PRIMARY KEY,orderId TEXT UNIQUE NOT NULL REFERENCES orders(id));
   CREATE TABLE IF NOT EXISTS devices(tokenHash TEXT PRIMARY KEY,role TEXT NOT NULL,name TEXT NOT NULL,expires INTEGER NOT NULL,createdAt TEXT NOT NULL); PRAGMA user_version=2;`);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
