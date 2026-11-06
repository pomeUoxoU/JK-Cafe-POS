import { DatabaseSync } from "node:sqlite";
import { mkdirSync, copyFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
const data = resolve(process.env.DATA_DIR || "data"),
  target = resolve(
    process.env.BACKUP_DIR || "backups",
    new Date().toISOString().replaceAll(":", "-"),
  );
if (!existsSync(join(data, "cafe.sqlite")))
  throw Error("バックアップ元のDBがありません。DATA_DIRを確認してください。");
mkdirSync(target, { recursive: true });
const db = new DatabaseSync(join(data, "cafe.sqlite"));
db.exec(
  "VACUUM INTO '" + join(target, "cafe.sqlite").replaceAll("'", "''") + "'",
);
db.close();
for (const name of [
  "staff-keys.json",
  "auth-config.json",
  "initial-access.json",
]) {
  if (existsSync(join(data, name)))
    copyFileSync(join(data, name), join(target, name));
}
console.log("バックアップ完了: " + target);
