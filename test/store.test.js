import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store, day } from "../server/store.js";
const req = (b = {}) => ({ requestId: randomUUID(), ...b });
const line = (b = {}) => ({
  productId: "plain",
  quantity: 1,
  syrupId: "choco",
  includedId: "cream",
  extras: [],
  ...b,
});
const token = () => randomBytes(32).toString("hex");
test("停止中に期限切れになった未払い注文は再起動後に一度だけ在庫復元", () => {
  const dir = mkdtempSync(join(tmpdir(), "jk-expiry-restart-")),
    file = join(dir, "cafe.sqlite");
  let now = 100000;
  const a = new Store(file, { now: () => now, ttlMs: 1000 });
  a.run("UPDATE catalog SET stock=100");
  const o = submit(a);
  a.db.close();
  now += 2000;
  const b = new Store(file, { now: () => now, ttlMs: 1000 });
  assert.equal(b.expire().length, 1);
  assert.equal(b.expire().length, 0);
  assert.equal(b.order(o.id).status, "expired");
  assert.equal(b.publicMenu().catalog.find((p) => p.id === "cream").stock, 100);
  b.db.close();
  rmSync(dir, { recursive: true });
});
function setup(t, options) {
  const s = new Store(":memory:", options);
  s.run("UPDATE catalog SET stock=100");
  t.after(() => s.db.close());
  return s;
}
function submit(s, b = {}) {
  const body = { items: [line()], coupon: false, ...b };
  return s.mutate(
    "customer",
    "submit",
    req({
      ...body,
      customerToken: token(),
      expectedTotal: s.quote(body).total,
    }),
  );
}
function pay(s, o, b = {}) {
  return s.mutate(
    "register",
    "pay",
    req({
      id: o.id,
      version: o.version,
      received: 10000,
      expectedTotal: o.total,
      couponConfirmed: true,
      ...b,
    }),
  );
}
test("基本300円：シロップと通常トッピングの無料分を料金に足さず全量在庫消費", (t) => {
  const s = setup(t),
    o = submit(s);
  assert.equal(o.total, 300);
  assert.equal(o.items[0].toppings.length, 2);
  assert.ok(o.items[0].toppings.every((x) => x.included === 1));
  for (const id of ["plain", "choco", "cream"])
    assert.equal(s.publicMenu().catalog.find((p) => p.id === id).stock, 99);
  assert.throws(
    () => s.quote({ items: [line({ syrupId: "" })], coupon: false }),
    /選択/,
  );
});
test("同じ通常トッピングの重ねがけは無料1回と追加回数を分離・複数皿", (t) => {
  const s = setup(t),
    o = submit(s, {
      items: [
        line({
          quantity: 2,
          extras: [
            { id: "cream", quantity: 2 },
            { id: "ice", quantity: 1 },
          ],
        }),
      ],
    });
  assert.equal(o.total, 1000);
  assert.equal(o.items[0].toppings.find((x) => x.id === "cream").quantity, 3);
  assert.equal(s.publicMenu().catalog.find((p) => p.id === "cream").stock, 94);
  assert.equal(s.publicMenu().catalog.find((p) => p.id === "ice").stock, 98);
});
test("スペシャル400円に選べる通常トッピングも込み、追加分だけ課金", (t) => {
  const s = setup(t),
    b = {
      items: [line({ productId: "special", includedId: "oreo" })],
      coupon: false,
    };
  assert.equal(s.quote(b).total, 400);
  assert.equal(
    s.quote(b).items[0].toppings.find((t) => t.id === "oreo").included,
    1,
  );
  b.items[0].extras = [
    { id: "ice", quantity: 1 },
    { id: "sprinkles", quantity: 2 },
    { id: "oreo", quantity: 1 },
  ];
  const o = submit(s, b);
  assert.equal(o.total, 650);
  assert.equal(
    o.items[0].toppings.find((t) => t.id === "sprinkles").quantity,
    3,
  );
  assert.equal(o.items[0].toppings.find((t) => t.id === "ice").quantity, 2);
});
test("スペシャルの無料選択3種類・スプレー2回・在庫・取消", (t) => {
  const s = setup(t);
  for (const includedId of ["cream", "oreo", "sprinkles"]) {
    const o = submit(s, {
      items: [line({ productId: "special", includedId, quantity: 2 })],
    });
    assert.equal(o.total, 800);
    const ts = o.items[0].toppings;
    assert.equal(
      ts.find((t) => t.id === includedId).included,
      includedId === "sprinkles" ? 2 : 1,
    );
    assert.equal(
      s.publicMenu().catalog.find((p) => p.id === includedId).stock,
      includedId === "sprinkles" ? 96 : 98,
    );
    const p = pay(s, o);
    assert.deepEqual(
      s.snapshot("kitchen").orders.find((x) => x.id === o.id).items,
      o.items,
    );
    s.mutate(
      "register",
      "cancel",
      req({
        id: p.id,
        version: p.version,
        reason: "テスト",
        restore: true,
        settlementConfirmed: true,
      }),
    );
    assert.equal(
      s.publicMenu().catalog.find((p) => p.id === includedId).stock,
      100,
    );
  }
  for (const includedId of ["", "ice", "choco"])
    assert.throws(
      () =>
        s.quote({
          items: [line({ productId: "special", includedId })],
          coupon: false,
        }),
      /選択/,
    );
  s.run("UPDATE catalog SET stock=1 WHERE id='sprinkles'");
  assert.throws(
    () =>
      submit(s, {
        items: [line({ productId: "special", includedId: "sprinkles" })],
      }),
    /在庫/,
  );
  assert.equal(
    s.publicMenu().catalog.find((p) => p.id === "special").stock,
    100,
  );
});

test("スペシャルの無料分訂正・有料追加・割引・失効復元", (t) => {
  let now = 10000;
  const s = setup(t, { now: () => now, ttlMs: 1000 });
  let o = submit(s, {
    coupon: true,
    items: [line({ productId: "special", includedId: "cream" })],
  });
  assert.equal(o.total, 370);
  o = s.mutate(
    "register",
    "correct",
    req({
      id: o.id,
      version: o.version,
      reason: "変更",
      coupon: true,
      expectedTotal: 420,
      items: [
        line({
          productId: "special",
          includedId: "sprinkles",
          extras: [{ id: "sprinkles", quantity: 1 }],
        }),
      ],
    }),
  );
  const sp = o.items[0].toppings.find((t) => t.id === "sprinkles");
  assert.equal(sp.quantity, 3);
  assert.equal(sp.included, 2);
  assert.equal(s.publicMenu().catalog.find((p) => p.id === "cream").stock, 100);
  assert.equal(
    s.publicMenu().catalog.find((p) => p.id === "sprinkles").stock,
    97,
  );
  assert.equal(s.report(day()).sales, 0);
  now += 2000;
  s.expire();
  assert.equal(
    s.publicMenu().catalog.find((p) => p.id === "sprinkles").stock,
    100,
  );
  assert.equal(s.publicMenu().catalog.find((p) => p.id === "ice").stock, 100);
});

test("旧スペシャルの保存済み内訳は入金・返金で再計算しない", (t) => {
  const s = setup(t);
  const o = submit(s, {
    items: [line({ productId: "special", includedId: "cream" })],
  });
  // Simulate the old stored snapshot and its corresponding stock reservation.
  o.items[0].toppings = o.items[0].toppings.filter((t) => t.id !== "cream");
  o.items[0].includedId = "sprinkles";
  delete o.items[0].recipeVersion;
  s.run("UPDATE catalog SET stock=stock+1 WHERE id='cream'");
  s.save(o);
  const before = structuredClone(o.items);
  const p = pay(s, o);
  assert.deepEqual(p.items, before);
  assert.equal(s.report(day()).sales, 400);
  s.mutate(
    "register",
    "cancel",
    req({
      id: p.id,
      version: p.version,
      reason: "旧仕様取消",
      restore: true,
      settlementConfirmed: true,
    }),
  );
  assert.equal(s.publicMenu().catalog.find((p) => p.id === "cream").stock, 100);
  assert.equal(
    s.publicMenu().catalog.find((p) => p.id === "sprinkles").stock,
    100,
  );
  assert.equal(s.report(day()).sales, 0);
});

test("クーポン30円は皿数によらず1会計1回、合計は0円未満にならない", (t) => {
  const s = setup(t);
  assert.equal(
    s.quote({ items: [line({ quantity: 2 })], coupon: true }).total,
    570,
  );
  s.run("UPDATE catalog SET price=20 WHERE id='plain'");
  const o = submit(s, { coupon: true });
  assert.equal(o.discount, 20);
  assert.equal(o.total, 0);
  assert.throws(() => s.quote({ items: [line()], coupon: 2 }), /不正/);
});
test("未払いは売上・キッチンに含めず、入金時のみ売上計上・在庫二重減算なし", (t) => {
  const s = setup(t),
    o = submit(s, { coupon: true });
  assert.equal(s.report(day()).sales, 0);
  assert.equal(s.report(day()).counts.length, 0);
  assert.equal(s.snapshot("kitchen").orders.length, 0);
  assert.throws(() => pay(s, o, { couponConfirmed: false }), /提示/);
  assert.throws(() => pay(s, o, { received: 100 }), /不足/);
  assert.throws(() => pay(s, o, { method: "external" }), /現金/);
  const p = pay(s, o);
  assert.equal(p.status, "waiting");
  assert.equal(s.snapshot("kitchen").orders.length, 1);
  assert.equal(s.report(day()).sales, 270);
  assert.equal(s.report(day()).discount, 30);
  assert.equal(s.report(day()).couponUses, 1);
  assert.equal(s.publicMenu().catalog.find((x) => x.id === "plain").stock, 99);
});
test("二重注文・二重入金・クライアント金額改ざん拒否", (t) => {
  const s = setup(t),
    b = req({
      items: [line()],
      coupon: false,
      customerToken: token(),
      expectedTotal: 300,
    }),
    o = s.mutate("customer", "submit", b);
  assert.equal(s.mutate("customer", "submit", b).id, o.id);
  assert.equal(s.snapshot().orders.length, 1);
  assert.throws(
    () => s.mutate("customer", "submit", { ...b, requestId: randomUUID() }),
    /使用済み/,
  );
  const pb = req({
    id: o.id,
    version: o.version,
    received: 500,
    expectedTotal: 300,
  });
  s.mutate("register", "pay", pb);
  s.mutate("register", "pay", pb);
  assert.equal(s.report(day()).sales, 300);
  assert.throws(
    () => s.mutate("register", "pay", { ...pb, requestId: randomUUID() }),
    /更新/,
  );
  assert.throws(
    () =>
      s.mutate(
        "customer",
        "submit",
        req({
          ...b,
          requestId: randomUUID(),
          customerToken: token(),
          expectedTotal: 1,
        }),
      ),
    /金額/,
  );
});
test("在庫不足時は全引当をロールバック", (t) => {
  const s = setup(t);
  s.run("UPDATE catalog SET stock=0 WHERE id='cream'");
  assert.throws(() => submit(s), /在庫不足/);
  assert.equal(s.publicMenu().catalog.find((x) => x.id === "plain").stock, 100);
  assert.equal(s.snapshot().orders.length, 0);
});
test("失効・未払い取消で無料分も復元、再処理でも二重復元なし", (t) => {
  let now = 100000;
  const s = setup(t, { now: () => now, ttlMs: 1000 }),
    o = submit(s);
  now += 1001;
  assert.equal(s.expire().length, 1);
  assert.equal(s.expire().length, 0);
  assert.equal(s.order(o.id).status, "expired");
  assert.equal(s.publicMenu().catalog.find((x) => x.id === "cream").stock, 100);
  assert.throws(() => pay(s, s.order(o.id)), /入金待ち/);
  const another = submit(s);
  s.mutate(
    "register",
    "cancel",
    req({ id: another.id, version: another.version, reason: "取りやめ" }),
  );
  assert.equal(s.report(day()).sales, 0);
  assert.equal(s.publicMenu().catalog.find((x) => x.id === "plain").stock, 100);
  assert.equal(s.snapshot("kitchen").orders.length, 0);
});
test("調理中訂正は無料分を含め差分在庫・割引維持・確認必須", (t) => {
  const s = setup(t);
  let o = pay(s, submit(s, { coupon: true }));
  o = s.mutate(
    "kitchen",
    "status",
    req({ id: o.id, version: o.version, status: "cooking" }),
  );
  o = s.mutate(
    "register",
    "correct",
    req({
      id: o.id,
      version: o.version,
      items: [line({ quantity: 2 })],
      coupon: true,
      expectedTotal: 570,
      reason: "皿数変更",
      restore: false,
      settlementConfirmed: true,
    }),
  );
  assert.equal(o.discount, 30);
  assert.equal(o.total, 570);
  assert.equal(s.report(day()).sales, 570);
  assert.equal(s.report(day()).couponUses, 1);
  assert.equal(o.pending.previous[0].quantity, 1);
  assert.throws(
    () =>
      s.mutate(
        "kitchen",
        "status",
        req({ id: o.id, version: o.version, status: "ready" }),
      ),
    /確認/,
  );
  o = s.mutate("kitchen", "ack", req({ id: o.id, version: o.version }));
  o = s.mutate(
    "kitchen",
    "status",
    req({ id: o.id, version: o.version, status: "ready" }),
  );
  assert.equal(o.status, "ready");
});
test("割引後の額を上限に部分返金・全取消し、割引台帳も相殺", (t) => {
  const s = setup(t);
  let o = pay(s, submit(s, { coupon: true }));
  assert.throws(
    () =>
      s.mutate(
        "register",
        "refund",
        req({
          id: o.id,
          version: o.version,
          amount: 300,
          reason: "返金",
          settlementConfirmed: true,
        }),
      ),
    /数値/,
  );
  o = s.mutate(
    "register",
    "refund",
    req({
      id: o.id,
      version: o.version,
      amount: 100,
      reason: "一部返金",
      settlementConfirmed: true,
    }),
  );
  assert.equal(s.report(day()).sales, 170);
  assert.equal(s.report(day()).discount, 30);
  const b = req({
    id: o.id,
    version: o.version,
    reason: "全取消",
    restore: true,
    settlementConfirmed: true,
  });
  o = s.mutate("register", "cancel", b);
  s.mutate("register", "cancel", b);
  assert.equal(o.refunded, 270);
  assert.equal(s.report(day()).sales, 0);
  assert.equal(s.report(day()).discount, 0);
  assert.equal(s.report(day()).couponUses, 0);
  assert.equal(s.report(day()).couponIssued, 1);
});
test("未払い訂正・クーポン取り外しは台帳を作らない", (t) => {
  const s = setup(t);
  let o = submit(s, { coupon: true });
  o = s.mutate(
    "register",
    "coupon",
    req({ id: o.id, version: o.version, coupon: false }),
  );
  assert.equal(o.total, 300);
  o = s.mutate(
    "register",
    "correct",
    req({
      id: o.id,
      version: o.version,
      items: [line({ quantity: 2 })],
      coupon: true,
      expectedTotal: 570,
      reason: "変更",
    }),
  );
  assert.equal(o.pending, null);
  assert.equal(s.report(day()).sales, 0);
  pay(s, o);
  assert.equal(s.report(day()).sales, 570);
});
test("権限・現金経費・締め・未確認IDの無効化", (t) => {
  const s = setup(t),
    o = submit(s);
  assert.throws(() => s.mutate("customer", "pay", req({ id: o.id })), /権限/);
  assert.throws(() => s.mutate("register", "catalog", req({})), /権限/);
  assert.throws(() => s.mutate("kitchen", "refund", req({})), /権限/);
  assert.throws(
    () => s.mutate("admin", "close", req({ opening: 1000, counted: 1000 })),
    /会計待ち/,
  );
  pay(s, o);
  s.mutate(
    "admin",
    "expense",
    req({ amount: 100, method: "cash", note: "経費" }),
  );
  const c = s.mutate("admin", "close", req({ opening: 1000, counted: 1200 }));
  assert.equal(c.difference, 0);
  assert.throws(() => submit(s), /締め/);
  s.mutate("admin", "reopen", req({ reason: "再開" }));
  const b = req({
    items: [line()],
    coupon: false,
    customerToken: token(),
    expectedTotal: 300,
  });
  s.resolveRequest(b.requestId, "customer:" + s.customerToken(b.customerToken));
  assert.throws(() => s.mutate("customer", "submit", b), /異なる/);
});
test("DB移行は販売履歴・返金・台帳・在庫を保持し、再起動で価格を戻さない", () => {
  const dir = mkdtempSync(join(tmpdir(), "jk-migration-")),
    file = join(dir, "cafe.sqlite");
  const old = new DatabaseSync(file);
  old.exec(
    `CREATE TABLE catalog(id TEXT PRIMARY KEY,name TEXT,kind TEXT,price INTEGER,stock INTEGER,active INTEGER);CREATE TABLE orders(id TEXT PRIMARY KEY,day TEXT,number INTEGER,data TEXT,UNIQUE(day,number));CREATE TABLE ledger(id TEXT PRIMARY KEY,day TEXT,at TEXT,kind TEXT,method TEXT,amount INTEGER,orderId TEXT,note TEXT);`,
  );
  old
    .prepare("INSERT INTO catalog VALUES(?,?,?,?,?,?)")
    .run("plain", "旧パンケーキ", "product", 350, 17, 1);
  old
    .prepare("INSERT INTO catalog VALUES(?,?,?,?,?,?)")
    .run("powder", "粉砂糖", "topping", 10, 20, 1);
  const historic = {
    id: "old",
    day: day(),
    number: 1,
    status: "waiting",
    total: 500,
    refunded: 100,
    method: "external",
    items: [],
    version: 1,
    pending: null,
  };
  const encoded = JSON.stringify(historic);
  old
    .prepare("INSERT INTO orders VALUES(?,?,?,?)")
    .run("old", day(), 1, encoded);
  old
    .prepare("INSERT INTO ledger VALUES(?,?,?,?,?,?,?,?)")
    .run("l", day(), "old", "sale", "external", 500, "old", "旧会計");
  old.close();
  const s = new Store(file);
  assert.equal(s.db.prepare("SELECT data FROM orders").get().data, encoded);
  assert.equal(s.order("old").method, "external");
  assert.equal(s.report(day()).sales, 500);
  assert.equal(s.publicMenu().catalog.find((p) => p.id === "plain").stock, 17);
  assert.equal(
    s.publicMenu().catalog.some((p) => p.id === "powder"),
    false,
  );
  assert.ok(existsSync(file + ".before-self-pos.sqlite"));
  s.run("UPDATE catalog SET price=330 WHERE id='plain'");
  s.db.close();
  const reopened = new Store(file);
  assert.equal(
    reopened.publicMenu().catalog.find((p) => p.id === "plain").price,
    330,
  );
  assert.equal(reopened.order("old").refunded, 100);
  reopened.db.close();
  rmSync(dir, { recursive: true });
});
