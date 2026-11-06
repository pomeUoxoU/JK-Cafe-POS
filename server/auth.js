import {
  randomBytes,
  randomInt,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hash } from "./store.js";
export function createAuth(store, data) {
  const path = join(data, "auth-config.json");
  if (!existsSync(path)) {
    const adminPin = String(randomInt(100000, 1000000)),
      pairingCode = String(randomInt(10000000, 100000000)),
      salt = randomBytes(16).toString("hex");
    writeFileSync(
      path,
      JSON.stringify(
        {
          salt,
          pinHash: scryptSync(adminPin, salt, 32).toString("hex"),
          pairingHash: hash(pairingCode),
        },
        null,
        2,
      ),
    );
    writeFileSync(
      join(data, "initial-access.json"),
      JSON.stringify({ adminPin, pairingCode }, null, 2),
    );
  }
  const config = JSON.parse(readFileSync(path, "utf8"));
  const attempts = new Map();
  let total = { n: 0, at: Date.now() };
  function checkRate(ip) {
    const now = Date.now();
    for (const [key, a] of attempts)
      if (now - a.at > 300000) attempts.delete(key);
    const a = attempts.get(ip) || { n: 0, at: now };
    attempts.set(ip, a);
    if (now - total.at > 300000) total = { n: 0, at: now };
    if (++a.n > 10 || ++total.n > 100)
      throw Error("認証試行が多すぎます。5分後に再試行してください");
  }
  function login(b, ip) {
    checkRate(ip);
    let role;
    if (b.role === "admin") {
      if (
        typeof b.pin !== "string" ||
        !/^\d{6}$/.test(b.pin) ||
        !timingSafeEqual(
          scryptSync(b.pin, config.salt, 32),
          Buffer.from(config.pinHash, "hex"),
        )
      )
        throw Error("管理者PINが違います");
      role = "admin";
    } else {
      if (
        !["register", "kitchen"].includes(b.role) ||
        typeof b.code !== "string" ||
        hash(b.code) !== config.pairingHash
      )
        throw Error("端末登録コードが違います");
      role = b.role;
    }
    const token = randomBytes(32).toString("hex"),
      expires = Date.now() + (role === "admin" ? 15 * 60000 : 90 * 86400000),
      name = role === "admin" ? "管理者" : store.text(b.name);
    store.run(
      "INSERT INTO devices VALUES(?,?,?,?,?)",
      hash(token),
      role,
      name,
      expires,
      new Date().toISOString(),
    );
    store.log(role, "device-login", { name, expires });
    return { token, role, expires };
  }
  function session(token) {
    if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) return null;
    const d = store.db
      .prepare("SELECT * FROM devices WHERE tokenHash=? AND expires>?")
      .get(hash(token), Date.now());
    return d || null;
  }
  return { login, session };
}
