import express from "express";
import { createServer } from "node:http";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { networkInterfaces } from "node:os";
import { Server } from "socket.io";
import { Store, paid } from "./store.js";
import { createAuth } from "./auth.js";
const data = resolve(process.env.DATA_DIR || "data");
mkdirSync(data, { recursive: true });
const minutes = Number(process.env.ORDER_TTL_MINUTES || 15);
if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 120)
  throw Error("ORDER_TTL_MINUTESは0より大きく120以下にしてください");
const store = new Store(resolve(data, "cafe.sqlite"), {
    ttlMs: minutes * 60000,
  }),
  auth = createAuth(store, data),
  app = express(),
  http = createServer(app),
  io = new Server(http, { maxHttpBufferSize: 100000 });
app.use(express.json({ limit: "128kb" }));
app.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  res.set("X-Content-Type-Options", "nosniff");
  res.set("Referrer-Policy", "no-referrer");
  if (
    req.method === "POST" &&
    req.headers.origin &&
    req.headers.origin !== `${req.protocol}://${req.headers.host}`
  )
    return res.status(403).json({ error: "別サイトからの操作はできません" });
  next();
});
const endpoint = (fn) => (req, res) => {
  try {
    res.json(fn(req, res));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
};
function notify(o, kitchen = false) {
  io.to("register").to("admin").emit("changed");
  io.to("public").emit("menu");
  if (kitchen) io.to("kitchen").emit("changed");
  if (o?.id) {
    const c = store.db
      .prepare("SELECT tokenHash FROM customer_orders WHERE orderId=?")
      .get(o.id);
    if (c) io.to("customer:" + c.tokenHash).emit("changed");
  }
}
function expire() {
  const ids = store.expire();
  for (const id of ids) notify({ id });
}
const expiryTimer = setInterval(() => {
  try {
    expire();
  } catch (e) {
    console.error("失効処理に失敗:", e.message);
  }
}, 3000);
expiryTimer.unref();
expire();
app.post(
  "/api/login",
  endpoint((req) => auth.login(req.body, req.ip)),
);
app.get(
  "/api/public/menu",
  endpoint(() => {
    expire();
    return store.publicMenu();
  }),
);
app.post(
  "/api/public/quote",
  endpoint((req) => store.quote(req.body)),
);
const rate = new Map();
app.post(
  "/api/public/submit",
  endpoint((req) => {
    const now = Date.now();
    for (const [ip, r] of rate) if (now - r.at > 60000) rate.delete(ip);
    const r = rate.get(req.ip) || { n: 0, at: now };
    rate.set(req.ip, r);
    if (++r.n > 60)
      throw Error("注文送信が多すぎます。少し待って再送してください");
    expire();
    const result = store.mutate("customer", "submit", req.body),
      o = store.order(result.id);
    notify(o);
    return store.publicOrder(o);
  }),
);
app.post(
  "/api/public/track",
  endpoint((req) => {
    expire();
    return store.customerOrder(req.body.customerToken);
  }),
);
app.post(
  "/api/public/resolve",
  endpoint((req) => {
    const r = store.resolveRequest(
      req.body.requestId,
      "customer:" + store.customerToken(req.body.customerToken),
    );
    return r.found
      ? { found: true, result: store.customerOrder(req.body.customerToken) }
      : r;
  }),
);
app.use("/api", (req, res, next) => {
  const session = auth.session(
    req.headers.authorization?.replace("Bearer ", ""),
  );
  if (!session)
    return res.status(401).json({ error: "スタッフ認証が必要です" });
  req.session = session;
  req.role = session.role;
  next();
});
app.post(
  "/api/logout",
  endpoint((req) => {
    store.run("DELETE FROM devices WHERE tokenHash=?", req.session.tokenHash);
    for (const s of io.sockets.sockets.values())
      if (s.data.session?.tokenHash === req.session.tokenHash)
        s.disconnect(true);
    return { ok: true };
  }),
);
app.get(
  "/api/state",
  endpoint((req) => {
    expire();
    return store.snapshot(req.role);
  }),
);
app.post(
  "/api/request/:id",
  endpoint((req) => store.resolveRequest(req.params.id, req.role)),
);
app.post(
  "/api/action/:action",
  endpoint((req) => {
    expire();
    const r = store.mutate(req.role, req.params.action, req.body);
    const o = r.id && r.items ? store.order(r.id) : r;
    notify(o, !!o.items && paid(o));
    return r;
  }),
);
app.use(["/api/report", "/api/export", "/api/devices"], (req, res, next) =>
  req.role === "admin"
    ? next()
    : res.status(403).json({ error: "管理者権限が必要です" }),
);
app.get(
  "/api/report",
  endpoint((req) => store.report(req.query.day)),
);
app.get(
  "/api/devices",
  endpoint(() =>
    store.all(
      "SELECT tokenHash,role,name,expires,createdAt FROM devices WHERE expires>?",
      Date.now(),
    ),
  ),
);
app.post(
  "/api/devices/revoke",
  endpoint((req) => {
    store.run("DELETE FROM devices WHERE tokenHash=?", req.body.tokenHash);
    store.log("admin", "device-revoke", { tokenHash: req.body.tokenHash });
    for (const s of io.sockets.sockets.values())
      if (s.data.session?.tokenHash === req.body.tokenHash) s.disconnect(true);
    return { ok: true };
  }),
);
function csv(rows) {
  return (
    "\ufeff" +
    rows
      .map((row) =>
        row
          .map((v) => {
            let s = String(v ?? "");
            if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
            return '"' + s.replaceAll('"', '""') + '"';
          })
          .join(","),
      )
      .join("\r\n")
  );
}
app.get("/api/export/:kind", (req, res) => {
  let rows;
  if (req.params.kind === "ledger")
    rows = [
      [
        "ID",
        "日付",
        "日時",
        "種別",
        "決済方法",
        "金額",
        "注文ID",
        "理由",
        "割引増減",
        "クーポン件数増減",
      ],
      ...store
        .all("SELECT * FROM ledger ORDER BY at")
        .map((l) => [
          l.id,
          l.day,
          l.at,
          l.kind,
          l.method,
          l.amount,
          l.orderId,
          l.note,
          l.discount,
          l.couponUses,
        ]),
    ];
  else if (req.params.kind === "orders")
    rows = [
      [
        "ID",
        "受付日",
        "番号",
        "状態",
        "入金日時",
        "割引前",
        "クーポン",
        "割引額",
        "請求額",
        "返金済額",
        "返金上限残額",
        "決済方法",
        "明細JSON",
      ],
      ...store
        .snapshot()
        .orders.map((o) => [
          o.id,
          o.day,
          o.number,
          o.status,
          o.paidAt ?? "",
          o.subtotal ?? o.total,
          Number(!!o.coupon),
          o.discount || 0,
          o.total,
          o.refunded,
          paid(o) ? o.total - o.refunded : 0,
          o.method,
          JSON.stringify(o.items),
        ]),
    ];
  else if (req.params.kind === "audit")
    rows = [
      ["ID", "日時", "権限", "操作", "内容JSON"],
      ...store
        .all("SELECT * FROM audit ORDER BY at")
        .map((a) => [a.id, a.at, a.role, a.action, a.data]),
    ];
  else return res.sendStatus(404);
  res.type("text/csv").send(csv(rows));
});
app.use("/api", (req, res) =>
  res.status(404).json({ error: "APIが見つかりません" }),
);
io.use((socket, next) => {
  const { token, customerToken } = socket.handshake.auth;
  if (token) {
    const s = auth.session(token);
    if (!s) return next(Error("スタッフ認証が必要です"));
    socket.data.session = s;
  } else if (customerToken) {
    try {
      socket.data.customerHash = store.customerToken(customerToken);
    } catch {
      return next(Error("受付キーが不正です"));
    }
  }
  next();
});
io.on("connection", (socket) => {
  const s = socket.data.session;
  if (s) {
    socket.join(s.role);
    const timer = setInterval(() => {
      if (!auth.session(socket.handshake.auth.token)) socket.disconnect(true);
    }, 10000);
    socket.on("disconnect", () => clearInterval(timer));
  } else {
    socket.join("public");
    if (socket.data.customerHash)
      socket.join("customer:" + socket.data.customerHash);
  }
});
app.use(express.static(resolve("dist")));
app.get("/{*path}", (req, res) => res.sendFile(resolve("dist/index.html")));
http.on("error", (e) => {
  console.error(
    "起動できません:",
    e.code === "EADDRINUSE"
      ? "ポート使用中です。既存サーバーを停止してください"
      : e.message,
  );
  process.exit(1);
});
http.listen(Number(process.env.PORT || 3000), "0.0.0.0", () => {
  const port = http.address().port;
  console.log(
    `JK-Cafe http://localhost:${port}\n初回設定情報: ${resolve(data, "initial-access.json")}`,
  );
  for (const nets of Object.values(networkInterfaces()))
    for (const n of nets || [])
      if (n.family === "IPv4" && !n.internal)
        console.log(`タブレット: http://${n.address}:${port}`);
});
