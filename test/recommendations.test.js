import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, unlinkSync, rmdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const dir = mkdtempSync(resolve("node_modules/.recommendations-test-"));
const file = join(dir, "recommendations.mjs");
after(() => {
  unlinkSync(file);
  rmdirSync(dir);
});
await build({
  entryPoints: ["src/recommendations.ts"],
  outfile: file,
  bundle: true,
  platform: "node",
  format: "esm",
});
const { recommendToppings } = await import(pathToFileURL(file));
const catalog = [
  ["plain", "トッピングパンケーキ", "standard"],
  ["special", "スペシャル", "special"],
  ["choco", "チョコ", "syrup"],
  ["berry", "いちご", "syrup"],
  ["maple", "メープル", "syrup"],
  ["cream", "ホイップ", "normal"],
  ["oreo", "オレオ", "normal"],
  ["sprinkles", "チョコスプレー", "normal"],
  ["ice", "アイス", "ice"],
].map(([id, name, category]) => ({
  id,
  name,
  category,
  active: 1,
  stock: 20,
  price: id === "ice" ? 100 : 50,
}));
const line = (syrupId, includedId, extras = []) => ({
  productId: "plain",
  syrupId,
  includedId,
  quantity: 1,
  extras,
});
const ids = (l, c = catalog) => recommendToppings(l, c).map((r) => r.item.id);

for (const [syrup, chosen, expected] of [
  ["choco", "cream", "oreo"],
  ["choco", "oreo", "cream"],
  ["berry", "cream", "sprinkles"],
  ["berry", "sprinkles", "cream"],
  ["maple", "cream", "ice"],
  ["maple", "ice", "cream"],
  ["choco", "sprinkles", "ice"],
  ["choco", "ice", "sprinkles"],
])
  test(`${syrup}＋${chosen} → ${expected}のみおすすめ`, () => {
    const current =
      chosen === "ice"
        ? line(syrup, "", [{ id: "ice", quantity: 1 }])
        : line(syrup, chosen);
    const snapshot = JSON.stringify([current, catalog]);
    assert.deepEqual(ids(current), [expected]);
    assert.deepEqual(
      JSON.stringify([current, catalog]),
      snapshot,
      "入力を変更しない",
    );
    assert.match(recommendToppings(current, catalog)[0].reason, /追加して完成/);
  });

test("追加済み・無料分・完成済みは再度おすすめしない", () => {
  assert.deepEqual(
    ids(line("choco", "cream", [{ id: "oreo", quantity: 1 }])),
    [],
  );
  assert.deepEqual(
    ids(line("berry", "cream", [{ id: "sprinkles", quantity: 3 }])),
    [],
  );
  for (const syrupId of ["choco", "berry", "maple"]) {
    const current = { ...line(syrupId, ""), productId: "special" };
    assert.deepEqual(ids(current), syrupId === "choco" ? [] : ["cream"]);
  }
  assert.deepEqual(ids(line("choco", "cream", [{ id: "oreo", quantity: 0 }])), [
    "oreo",
  ]);
});
test("売り切れ・非公開・存在しない材料を除外", () => {
  assert.deepEqual(
    ids({ ...line("berry", "cream"), productId: "special" }),
    [],
  );
  assert.deepEqual(
    ids({ ...line("maple", "cream"), productId: "special" }),
    [],
  );
  assert.deepEqual(ids({ ...line("choco", "cream"), productId: "special" }), [
    "oreo",
  ]);
  assert.deepEqual(ids({ ...line("choco", "oreo"), productId: "special" }), [
    "cream",
  ]);
  for (const patch of [{ stock: 0 }, { active: 0 }]) {
    assert.deepEqual(
      ids(
        line("choco", "cream"),
        catalog.map((p) => (p.id === "oreo" ? { ...p, ...patch } : p)),
      ),
      [],
    );
  }
  assert.deepEqual(
    ids(
      line("choco", "cream"),
      catalog.filter((p) => p.id !== "oreo"),
    ),
    [],
  );
});
test("同率はレシピの固定順、カタログ順が変わっても安定", () => {
  const current = line("choco", "cream", [{ id: "sprinkles", quantity: 1 }]);
  assert.deepEqual(ids(current), ["oreo", "ice"]);
  assert.deepEqual(ids(current, [...catalog].reverse()), ["oreo", "ice"]);
});
test("該当する組み合わせがなければ表示しない", () => {
  assert.deepEqual(ids(null), []);
  assert.deepEqual(ids(line("unknown", "cream")), []);
  assert.deepEqual(ids(line("berry", "oreo")), []);
  assert.deepEqual(ids(line("choco", "")), []);
});
