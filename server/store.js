import { DatabaseSync } from "node:sqlite";
import { randomUUID, createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { migrate } from "./migrate.js";
export const day = () =>
  new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(
    new Date(),
  );
export const hash = (v) => createHash("sha256").update(v).digest("hex");
export const paid = (o) =>
  o.paidAt !== null && !["unpaid", "expired"].includes(o.status);
const permissions = {
  customer: ["submit"],
  register: ["pay", "coupon", "correct", "cancel", "refund", "status"],
  kitchen: ["status", "ack"],
  admin: [
    "pay",
    "coupon",
    "correct",
    "cancel",
    "refund",
    "status",
    "ack",
    "catalog",
    "expense",
    "close",
    "reopen",
  ],
};
export class Store {
  constructor(file, { ttlMs = 900000, now = () => Date.now() } = {}) {
    this.now = now;
    this.ttlMs = ttlMs;
    this.db = new DatabaseSync(file);
    this.db
      .exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
   CREATE TABLE IF NOT EXISTS catalog(id TEXT PRIMARY KEY,name TEXT NOT NULL,kind TEXT NOT NULL,price INTEGER NOT NULL,stock INTEGER NOT NULL,active INTEGER NOT NULL DEFAULT 1);
   CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY,day TEXT NOT NULL,number INTEGER NOT NULL,data TEXT NOT NULL,UNIQUE(day,number));
   CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY,body TEXT NOT NULL,result TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS ledger(id TEXT PRIMARY KEY,day TEXT NOT NULL,at TEXT NOT NULL,kind TEXT NOT NULL,method TEXT NOT NULL,amount INTEGER NOT NULL,orderId TEXT,note TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS audit(id TEXT PRIMARY KEY,at TEXT NOT NULL,role TEXT NOT NULL,action TEXT NOT NULL,data TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS closings(id TEXT PRIMARY KEY,day TEXT UNIQUE NOT NULL,data TEXT NOT NULL);`);
    if (
      file !== ":memory:" &&
      this.db.prepare("PRAGMA user_version").get().user_version < 2
    ) {
      const backup = file + ".before-self-pos.sqlite";
      if (!existsSync(backup))
        this.db.exec("VACUUM INTO '" + backup.replaceAll("'", "''") + "'");
    }
    migrate(this.db);
  }
  all(sql, ...p) {
    return this.db.prepare(sql).all(...p);
  }
  run(sql, ...p) {
    return this.db.prepare(sql).run(...p);
  }
  order(id) {
    const r = this.db.prepare("SELECT data FROM orders WHERE id=?").get(id);
    if (!r) throw Error("注文が見つかりません");
    return JSON.parse(r.data);
  }
  save(o) {
    this.run("UPDATE orders SET data=? WHERE id=?", JSON.stringify(o), o.id);
  }
  log(role, action, data) {
    this.run(
      "INSERT INTO audit VALUES(?,?,?,?,?)",
      randomUUID(),
      new Date(this.now()).toISOString(),
      role,
      action,
      JSON.stringify(data),
    );
  }
  ledger(kind, method, amount, orderId, note, discount = 0, couponUses = 0) {
    this.run(
      "INSERT INTO ledger(id,day,at,kind,method,amount,orderId,note,discount,couponUses) VALUES(?,?,?,?,?,?,?,?,?,?)",
      randomUUID(),
      day(),
      new Date(this.now()).toISOString(),
      kind,
      method,
      amount,
      orderId,
      note,
      discount,
      couponUses,
    );
  }
  snapshot(role = "admin") {
    const orders = this.all(
      "SELECT data FROM orders ORDER BY day DESC,number DESC",
    ).map((r) => JSON.parse(r.data));
    return {
      catalog: this.all("SELECT * FROM catalog"),
      orders:
        role === "kitchen"
          ? orders.filter(paid).map((o) => ({
              id: o.id,
              day: o.day,
              number: o.number,
              status: o.status,
              items: o.items,
              pending: o.pending,
              version: o.version,
            }))
          : orders,
      today: day(),
    };
  }
  publicMenu() {
    return {
      catalog: this.all(
        "SELECT * FROM catalog WHERE active=1 AND category<>'legacy'",
      ),
      ttlMinutes: this.ttlMs / 60000,
    };
  }
  customerToken(t) {
    if (typeof t !== "string" || !/^[a-f0-9]{64}$/.test(t))
      throw Error("受付確認キーが不正です");
    return hash(t);
  }
  customerOrder(token) {
    const r = this.db
      .prepare("SELECT orderId FROM customer_orders WHERE tokenHash=?")
      .get(this.customerToken(token));
    if (!r) throw Error("受付情報がありません");
    return this.publicOrder(this.order(r.orderId));
  }
  publicOrder(o) {
    return {
      id: o.id,
      day: o.day,
      number: o.number,
      status: o.status,
      items: o.items,
      subtotal: o.subtotal ?? o.total,
      discount: o.discount || 0,
      coupon: !!o.coupon,
      total: o.total,
      paid: paid(o),
      expiresAt: o.expiresAt,
      version: o.version,
    };
  }
  transact(id, body, fn) {
    if (typeof id !== "string" || id.length < 12 || id.length > 100)
      throw Error("送信IDが不正です");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const prior = this.db
          .prepare("SELECT * FROM requests WHERE id=?")
          .get(id),
        encoded = JSON.stringify(body);
      if (prior) {
        if (prior.body !== encoded)
          throw Error("同じ送信IDで異なる内容は送れません");
        this.db.exec("COMMIT");
        return JSON.parse(prior.result);
      }
      const result = fn();
      this.run(
        "INSERT INTO requests VALUES(?,?,?)",
        id,
        encoded,
        JSON.stringify(result),
      );
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  resolveRequest(id, scope) {
    if (typeof id !== "string" || id.length < 12 || id.length > 100)
      throw Error("送信IDが不正です");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const r = this.db.prepare("SELECT * FROM requests WHERE id=?").get(id);
      if (r) {
        const b = JSON.parse(r.body);
        if (b.scope !== scope)
          throw Error("この送信結果にはアクセスできません");
        const result = JSON.parse(r.result);
        this.db.exec("COMMIT");
        return result.abandoned ? { found: false } : { found: true, result };
      }
      this.run(
        "INSERT INTO requests VALUES(?,?,?)",
        id,
        JSON.stringify({ scope, abandoned: true }),
        JSON.stringify({ abandoned: true }),
      );
      this.db.exec("COMMIT");
      return { found: false };
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  integer(n, min = 0, max = 1000000) {
    if (!Number.isSafeInteger(n) || n < min || n > max)
      throw Error("数値の範囲が不正です");
    return n;
  }
  text(s) {
    if (typeof s !== "string" || !s.trim() || s.length > 200)
      throw Error("名称・理由を入力してください（200文字まで）");
    return s.trim();
  }
  priceItems(lines) {
    if (!Array.isArray(lines) || !lines.length || lines.length > 30)
      throw Error("商品を選んでください（最大30行）");
    const get = (id, categories) => {
      const p = this.db.prepare("SELECT * FROM catalog WHERE id=?").get(id);
      if (!p || !p.active || !categories.includes(p.category))
        throw Error("販売停止中、または選択できない商品です");
      return p;
    };
    return lines.map((l) => {
      const p = get(l.productId, ["standard", "special"]),
        quantity = this.integer(l.quantity, 1, 30),
        syrup = get(l.syrupId, ["syrup"]),
        base = get(l.includedId, ["normal"]);
      const toppings = new Map();
      const add = (x, n, free) => {
        const prev = toppings.get(x.id) || {
          id: x.id,
          name: x.name,
          price: x.price,
          category: x.category,
          quantity: 0,
          included: 0,
        };
        prev.quantity += n;
        prev.included += free;
        toppings.set(x.id, prev);
      };
      add(syrup, 1, 1);
      add(base, 1, 1);
      if (p.category === "special") {
        add(get("sprinkles", ["normal"]), 1, 1);
        add(get("ice", ["ice"]), 1, 1);
      }
      if (!Array.isArray(l.extras) || l.extras.length > 20)
        throw Error("追加トッピングが不正です");
      const seen = new Set();
      for (const t of l.extras) {
        if (seen.has(t.id)) throw Error("追加トッピングが重複しています");
        seen.add(t.id);
        add(get(t.id, ["normal", "ice"]), this.integer(t.quantity, 1, 20), 0);
      }
      const ts = [...toppings.values()],
        unitPrice =
          p.price +
          ts.reduce((s, t) => s + t.price * (t.quantity - t.included), 0);
      return {
        productId: p.id,
        recipeVersion: 2,
        name: p.name,
        price: p.price,
        quantity,
        syrupId: syrup.id,
        includedId: base.id,
        extras: l.extras.map((t) => ({ id: t.id, quantity: t.quantity })),
        toppings: ts,
        subtotal: unitPrice * quantity,
      };
    });
  }
  quote(b) {
    if (typeof b.coupon !== "boolean") throw Error("クーポンの選択が不正です");
    const items = this.priceItems(b.items),
      subtotal = items.reduce((s, l) => s + l.subtotal, 0),
      discount = b.coupon ? Math.min(30, subtotal) : 0;
    return {
      items,
      subtotal,
      discount,
      coupon: b.coupon,
      total: subtotal - discount,
    };
  }
  usage(items) {
    const map = Object.create(null);
    for (const l of items) {
      map[l.productId] = (map[l.productId] || 0) + l.quantity;
      for (const t of l.toppings)
        map[t.id] = (map[t.id] || 0) + l.quantity * t.quantity;
    }
    return map;
  }
  stock(items, sign) {
    for (const [id, n] of Object.entries(this.usage(items)))
      if (
        !this.run(
          "UPDATE catalog SET stock=stock+? WHERE id=? AND stock+?>=0",
          n * sign,
          id,
          n * sign,
        ).changes
      )
        throw Error("在庫不足です。内容を変更してください");
  }
  version(o, b) {
    if (o.version !== b.version)
      throw Error("別の操作で更新されました。最新の注文を確認してください");
  }
  openDay() {
    if (this.db.prepare("SELECT 1 FROM closings WHERE day=?").get(day()))
      throw Error("本日は締め済みです");
  }
  expire() {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const expired = [];
      for (const { data } of this.all(
        "SELECT data FROM orders WHERE json_extract(data,'$.status')='unpaid'",
      )) {
        const o = JSON.parse(data);
        if (Date.parse(o.expiresAt) > this.now()) continue;
        this.stock(o.items, 1);
        o.status = "expired";
        o.version++;
        this.save(o);
        this.log("system", "expire", { id: o.id });
        expired.push(o.id);
      }
      this.db.exec("COMMIT");
      return expired;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  mutate(role, action, b) {
    if (!permissions[role]?.includes(action))
      throw Error("この操作の権限がありません");
    this.expire();
    const scope =
        role === "customer"
          ? "customer:" + this.customerToken(b.customerToken)
          : role,
      safe = { ...b };
    delete safe.customerToken;
    return this.transact(b.requestId, { scope, action, body: safe }, () => {
      let result = { ok: true };
      if (action === "submit") {
        this.openDay();
        const q = this.quote(b);
        if (b.expectedTotal !== q.total)
          throw Error("金額が変更されました。再確認してください");
        const tokenHash = this.customerToken(b.customerToken);
        if (
          this.db
            .prepare("SELECT 1 FROM customer_orders WHERE tokenHash=?")
            .get(tokenHash)
        )
          throw Error("この受付キーは使用済みです");
        this.stock(q.items, -1);
        const number = this.db
          .prepare("SELECT COALESCE(MAX(number),0)+1 n FROM orders WHERE day=?")
          .get(day()).n;
        const o = {
          id: randomUUID(),
          day: day(),
          number,
          ...q,
          method: "cash",
          received: null,
          paidAt: null,
          status: "unpaid",
          version: 1,
          refunded: 0,
          pending: null,
          createdAt: new Date(this.now()).toISOString(),
          expiresAt: new Date(this.now() + this.ttlMs).toISOString(),
        };
        this.run(
          "INSERT INTO orders VALUES(?,?,?,?)",
          o.id,
          o.day,
          number,
          JSON.stringify(o),
        );
        this.run("INSERT INTO customer_orders VALUES(?,?)", tokenHash, o.id);
        result = o;
      } else if (
        [
          "pay",
          "coupon",
          "correct",
          "cancel",
          "refund",
          "status",
          "ack",
        ].includes(action)
      ) {
        const o = this.order(b.id);
        this.version(o, b);
        if (action === "pay") {
          this.openDay();
          if (
            o.status !== "unpaid" ||
            paid(o) ||
            Date.parse(o.expiresAt) <= this.now()
          )
            throw Error("入金待ちではありません");
          if (b.method && b.method !== "cash")
            throw Error("現金のみ対応しています");
          if (b.expectedTotal !== o.total) throw Error("金額が変更されました");
          if (o.coupon && b.couponConfirmed !== true)
            throw Error("クーポンの提示を確認してください");
          this.integer(b.received);
          if (b.received < o.total) throw Error("お預かり金額が不足しています");
          o.status = "waiting";
          o.paidAt = new Date(this.now()).toISOString();
          o.received = b.received;
          this.ledger(
            "sale",
            "cash",
            o.total,
            o.id,
            "入金確認",
            o.discount,
            Number(o.coupon),
          );
        } else if (action === "coupon") {
          if (o.status !== "unpaid" || typeof b.coupon !== "boolean")
            throw Error("入金前だけ変更できます");
          o.coupon = b.coupon;
          o.discount = b.coupon ? Math.min(30, o.subtotal) : 0;
          o.total = o.subtotal - o.discount;
        } else if (action === "status") {
          if (!paid(o) || o.pending)
            throw Error("入金または訂正確認が必要です");
          const next = {
            waiting: "cooking",
            cooking: "ready",
            ready: "handed",
          }[o.status];
          if (!next || next !== b.status) throw Error("状態を変更できません");
          if (
            role !== "admin" &&
            !(role === "kitchen" && ["cooking", "ready"].includes(next)) &&
            !(role === "register" && next === "handed")
          )
            throw Error("この操作の権限がありません");
          o.status = next;
        } else if (action === "ack") {
          if (!paid(o) || !o.pending) throw Error("確認待ちではありません");
          o.pending = null;
        } else if (action === "correct") {
          this.openDay();
          if (
            ["cancelled", "expired", "handed"].includes(o.status) ||
            o.pending ||
            o.refunded
          )
            throw Error("この注文は訂正できません");
          const q = this.quote(b),
            reason = this.text(b.reason);
          if (b.expectedTotal !== q.total) throw Error("金額が変更されました");
          if (paid(o) && b.settlementConfirmed !== true)
            throw Error("差額の受領・返金を確認してください");
          if (paid(o) && q.coupon && !o.coupon && b.couponConfirmed !== true)
            throw Error("クーポンの提示を確認してください");
          if (
            !["waiting", "unpaid"].includes(o.status) &&
            typeof b.restore !== "boolean"
          )
            throw Error("在庫を戻すか選択してください");
          const old = this.usage(o.items),
            fresh = this.usage(q.items);
          for (const id of new Set([
            ...Object.keys(old),
            ...Object.keys(fresh),
          ])) {
            const d = (fresh[id] || 0) - (old[id] || 0);
            if (d > 0) {
              if (
                !this.run(
                  "UPDATE catalog SET stock=stock-? WHERE id=? AND stock>=?",
                  d,
                  id,
                  d,
                ).changes
              )
                throw Error("在庫不足です");
            } else if (
              d < 0 &&
              (["waiting", "unpaid"].includes(o.status) || b.restore)
            )
              this.run("UPDATE catalog SET stock=stock+? WHERE id=?", -d, id);
          }
          if (paid(o)) {
            o.pending = { kind: "correction", previous: o.items, reason };
            this.ledger(
              "correction",
              o.method,
              q.total - o.total,
              o.id,
              reason,
              q.discount - (o.discount || 0),
              Number(q.coupon) - Number(!!o.coupon),
            );
          }
          Object.assign(o, q);
        } else {
          if (["cancelled", "expired"].includes(o.status))
            throw Error("取消・失効済みです");
          const reason = this.text(b.reason);
          if (!paid(o)) {
            if (action !== "cancel") throw Error("未払い注文は返金できません");
            this.stock(o.items, 1);
            o.status = "cancelled";
          } else {
            this.openDay();
            if (b.settlementConfirmed !== true)
              throw Error("返金の実施を確認してください");
            const amount =
              action === "cancel"
                ? o.total - o.refunded
                : this.integer(b.amount, 1, o.total - o.refunded);
            if (action === "cancel") {
              if (typeof b.restore !== "boolean")
                throw Error("在庫を戻すか選択してください");
              if (b.restore) this.stock(o.items, 1);
              o.pending = { kind: "cancel", previous: o.items, reason };
              o.status = "cancelled";
            }
            o.refunded += amount;
            const reverse = o.refunded === o.total && !o.couponReversed;
            o.couponReversed = !!o.couponReversed || reverse;
            this.ledger(
              action,
              o.method,
              -amount,
              o.id,
              reason,
              reverse ? -(o.discount || 0) : 0,
              reverse ? -Number(!!o.coupon) : 0,
            );
          }
        }
        o.version++;
        this.save(o);
        result = o;
      } else if (action === "catalog") {
        const old = this.db
          .prepare("SELECT * FROM catalog WHERE id=?")
          .get(b.id);
        if (!old) throw Error("商品が見つかりません");
        if (old.category === "legacy" && b.active)
          throw Error("旧メニューは販売再開できません");
        if (JSON.stringify(old) !== JSON.stringify(b.previous))
          throw Error("在庫・価格が更新されました。再読込してください");
        const name = this.text(b.name);
        if (name.includes("粉砂糖")) throw Error("粉砂糖は販売できません");
        this.run(
          "UPDATE catalog SET name=?,price=?,stock=?,active=? WHERE id=?",
          name,
          this.integer(b.price),
          this.integer(b.stock),
          b.active ? 1 : 0,
          b.id,
        );
      } else if (action === "expense") {
        this.openDay();
        if (!["cash", "external"].includes(b.method))
          throw Error("支払方法が不正です");
        this.ledger(
          "expense",
          b.method,
          -this.integer(b.amount, 1),
          null,
          this.text(b.note),
        );
      } else if (action === "close") {
        this.openDay();
        if (this.snapshot().orders.some((o) => o.status === "unpaid"))
          throw Error("会計待ち注文を先に入金確認または取消してください");
        const opening = this.integer(b.opening),
          counted = this.integer(b.counted),
          cash = this.db
            .prepare(
              "SELECT COALESCE(SUM(amount),0) n FROM ledger WHERE day=? AND method='cash'",
            )
            .get(day()).n;
        result = {
          id: randomUUID(),
          day: day(),
          opening,
          counted,
          expected: opening + cash,
          difference: counted - opening - cash,
          at: new Date(this.now()).toISOString(),
        };
        this.run(
          "INSERT INTO closings VALUES(?,?,?)",
          result.id,
          day(),
          JSON.stringify(result),
        );
      } else if (action === "reopen") {
        this.text(b.reason);
        this.run("DELETE FROM closings WHERE day=?", day());
      }
      this.log(role, action, { request: safe, result });
      return result;
    });
  }
  report(date) {
    if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date))
      throw Error("日付が不正です");
    const ledger = this.all(
        "SELECT * FROM ledger WHERE day=? ORDER BY at",
        date,
      ),
      orders = this.snapshot().orders.filter(
        (o) =>
          (o.paidAt
            ? new Intl.DateTimeFormat("sv-SE", {
                timeZone: "Asia/Tokyo",
              }).format(new Date(o.paidAt))
            : o.day) === date,
      ),
      counts = new Map();
    const count = (id, name, kind, quantity) =>
      counts.set(id, {
        id,
        name,
        kind,
        quantity: (counts.get(id)?.quantity || 0) + quantity,
      });
    for (const o of orders.filter((o) => paid(o) && o.status !== "cancelled"))
      for (const l of o.items) {
        count(l.productId, l.name, "product", l.quantity);
        for (const t of l.toppings)
          count(t.id, t.name, "topping", t.quantity * l.quantity);
      }
    return {
      ledger,
      counts: [...counts.values()],
      closings: this.all("SELECT data FROM closings WHERE day=?", date).map(
        (x) => JSON.parse(x.data),
      ),
      sales: ledger
        .filter((l) => l.kind !== "expense")
        .reduce((s, l) => s + l.amount, 0),
      expenses: -ledger
        .filter((l) => l.kind === "expense")
        .reduce((s, l) => s + l.amount, 0),
      couponUses: ledger.reduce((s, l) => s + l.couponUses, 0),
      discount: ledger.reduce((s, l) => s + l.discount, 0),
      couponIssued: ledger
        .filter((l) => l.couponUses > 0)
        .reduce((s, l) => s + l.couponUses, 0),
    };
  }
}
