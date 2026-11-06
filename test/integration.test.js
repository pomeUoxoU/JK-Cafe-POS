import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { io } from "socket.io-client";
const sleep = (n) => new Promise((r) => setTimeout(r, n));
const receipt = () => randomBytes(32).toString("hex");
const body = () => ({
  requestId: randomUUID(),
  customerToken: receipt(),
  items: [
    {
      productId: "plain",
      quantity: 1,
      syrupId: "choco",
      includedId: "cream",
      extras: [],
    },
  ],
  coupon: true,
  expectedTotal: 270,
});
test("HTTP・Socket.IO：権限分離、同時注文、入金通知、再起動認証、失効、CSV、バックアップ", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jk-self-http-"));
  let child, base, kitchen, customer;
  async function start() {
    let output = "";
    child = spawn(process.execPath, ["server/index.js"], {
      env: {
        ...process.env,
        DATA_DIR: dir,
        PORT: "0",
        ORDER_TTL_MINUTES: "0.05",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    for (let i = 0; i < 200; i++) {
      const m = output.match(/localhost:(\d+)/);
      if (m) {
        base = "http://127.0.0.1:" + m[1];
        return;
      }
      if (child.exitCode !== null) break;
      await sleep(50);
    }
    throw Error("起動失敗 " + output);
  }
  async function stop() {
    if (child && child.exitCode === null) {
      const stopped = once(child, "exit");
      child.kill();
      await stopped;
    }
  }
  const api = async (path, token, b) => {
    const r = await fetch(base + "/api/" + path, {
      method: b === undefined ? "GET" : "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: "Bearer " + token } : {}),
      },
      body: b === undefined ? undefined : JSON.stringify(b),
    });
    return { status: r.status, body: await r.json() };
  };
  const changed = (socket) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error("通知なし")), 3000);
      socket.once("changed", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  try {
    await start();
    const keys = JSON.parse(
      readFileSync(join(dir, "initial-access.json"), "utf8"),
    );
    const login = async (role) =>
      (
        await api("login", null, {
          role,
          pin: keys.adminPin,
          code: keys.pairingCode,
          name: "テスト端末",
        })
      ).body.token;
    const register = await login("register"),
      kit = await login("kitchen"),
      admin = await login("admin");
    for (const path of [
      "state",
      "report?day=2026-10-14",
      "devices",
      "export/orders",
    ])
      assert.equal((await api(path)).status, 401);
    assert.equal((await api("report?day=2026-10-14", register)).status, 403);
    assert.equal((await api("devices", kit)).status, 403);
    assert.equal((await api("action/pay", null, {})).status, 401);
    assert.equal((await api("action/sale", register, {})).status, 400);
    let state = (await api("state", admin)).body;
    const plain = state.catalog.find((p) => p.id === "plain");
    assert.equal(
      (await api("action/catalog", register, { id: "plain", stock: 999 }))
        .status,
      400,
    );
    assert.equal(
      (
        await api("action/catalog", admin, {
          requestId: randomUUID(),
          id: "plain",
          previous: plain,
          name: plain.name,
          stock: 1,
          price: 300,
          active: true,
        })
      ).status,
      200,
    );
    kitchen = io(base, { auth: { token: kit } });
    customer = io(base);
    await Promise.all([once(kitchen, "connect"), once(customer, "connect")]);
    let kitchenNotifications = 0,
      publicNotifications = 0;
    kitchen.on("changed", () => kitchenNotifications++);
    customer.on("changed", () => publicNotifications++);
    const a = body(),
      b = body();
    const results = await Promise.all([
      api("public/submit", null, a),
      api("public/submit", null, b),
    ]);
    assert.equal(results.filter((r) => r.status === 200).length, 1);
    assert.equal(results.filter((r) => r.status === 400).length, 1);
    const winner = results[0].status === 200 ? a : b;
    let order = results.find((r) => r.status === 200).body;
    assert.equal((await api("public/submit", null, winner)).body.id, order.id);
    await sleep(100);
    assert.equal(kitchenNotifications, 0);
    assert.equal(publicNotifications, 0);
    assert.equal((await api("state", kit)).body.orders.length, 0);
    const today = (await api("state", register)).body.today;
    assert.equal((await api("report?day=" + today, admin)).body.sales, 0);
    assert.equal(
      (await api("public/track", null, { customerToken: receipt() })).status,
      400,
    );
    assert.equal(
      (
        await api("public/resolve", null, {
          requestId: winner.requestId,
          customerToken: receipt(),
        })
      ).status,
      400,
    );
    const pay = {
      requestId: randomUUID(),
      id: order.id,
      version: order.version,
      received: 500,
      expectedTotal: 270,
      couponConfirmed: true,
    };
    const arrival = changed(kitchen);
    const payments = await Promise.all([
      api("action/pay", register, pay),
      api("action/pay", register, pay),
    ]);
    await arrival;
    assert.ok(payments.every((p) => p.status === 200));
    assert.equal((await api("report?day=" + today, admin)).body.sales, 270);
    assert.equal(
      (await api("public/track", null, { customerToken: winner.customerToken }))
        .body.paid,
      true,
    );
    assert.equal(
      (await api("action/pay", kit, { ...pay, requestId: randomUUID() }))
        .status,
      400,
    );
    order = payments[0].body;
    order = (
      await api("action/status", kit, {
        requestId: randomUUID(),
        id: order.id,
        version: order.version,
        status: "cooking",
      })
    ).body;
    order = (
      await api("action/status", kit, {
        requestId: randomUUID(),
        id: order.id,
        version: order.version,
        status: "ready",
      })
    ).body;
    assert.equal(order.status, "ready");
    const csv = await fetch(base + "/api/export/ledger", {
      headers: { Authorization: "Bearer " + admin },
    });
    assert.equal(csv.status, 200);
    assert.match(await csv.text(), /クーポン件数増減/);
    kitchen.disconnect();
    customer.disconnect();
    await stop();
    await start();
    assert.equal((await api("state", register)).status, 200);
    assert.equal((await api("state", kit)).body.orders[0].status, "ready");
    state = (await api("state", admin)).body;
    const p = state.catalog.find((p) => p.id === "plain");
    await api("action/catalog", admin, {
      requestId: randomUUID(),
      id: p.id,
      previous: p,
      name: p.name,
      stock: 1,
      price: 300,
      active: true,
    });
    const expiring = body();
    const unpaid = (await api("public/submit", null, expiring)).body;
    assert.equal(unpaid.status, "unpaid");
    await sleep(3100);
    const expired = (
      await api("public/track", null, { customerToken: expiring.customerToken })
    ).body;
    assert.equal(expired.status, "expired");
    assert.equal(
      (await api("public/menu")).body.catalog.find((p) => p.id === "plain")
        .stock,
      1,
    );
    assert.equal(
      (
        await api("action/pay", register, {
          ...pay,
          id: expired.id,
          version: expired.version,
          requestId: randomUUID(),
        })
      ).status,
      400,
    );
    const backupRoot = join(dir, "backups");
    const backup = spawnSync(process.execPath, ["scripts/backup.js"], {
      env: { ...process.env, DATA_DIR: dir, BACKUP_DIR: backupRoot },
      encoding: "utf8",
    });
    assert.equal(backup.status, 0, backup.stderr);
    const backupDir = join(backupRoot, readdirSync(backupRoot)[0]);
    const restored = new DatabaseSync(join(backupDir, "cafe.sqlite"));
    assert.equal(
      restored.prepare("PRAGMA integrity_check").get().integrity_check,
      "ok",
    );
    assert.equal(restored.prepare("SELECT COUNT(*) n FROM orders").get().n, 2);
    restored.close();
    assert.ok(readFileSync(join(backupDir, "auth-config.json"), "utf8"));
    const devices = (await api("devices", admin)).body;
    const target = devices.find((d) => d.role === "register");
    assert.equal(
      (await api("devices/revoke", kit, { tokenHash: target.tokenHash }))
        .status,
      403,
    );
    await api("devices/revoke", admin, { tokenHash: target.tokenHash });
    assert.equal((await api("state", register)).status, 401);
  } finally {
    kitchen?.disconnect();
    customer?.disconnect();
    await stop();
    rmSync(dir, { recursive: true });
  }
});
