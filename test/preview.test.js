import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, unlinkSync, rmdirSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Store } from "../server/store.js";

const dir = mkdtempSync(resolve("node_modules/.preview-test-"));
const file = join(dir, "preview.mjs");
after(() => {
  if (existsSync(file)) unlinkSync(file);
  rmdirSync(dir);
});
await build({
  entryPoints: ["src/pancake-preview.tsx"],
  outfile: file,
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
  jsx: "automatic",
});
const {
  previewToppings,
  PancakeLayers,
  PancakePreview,
  foodImages,
  previewLayout,
  PREVIEW_LIMITS,
  sprinkleParticles,
  cookieParticles,
} = await import(pathToFileURL(file));

test("プレビューの無料分・重ねがけ数量がサーバーの内訳と一致する", (t) => {
  const store = new Store(":memory:");
  store.run("UPDATE catalog SET stock=2000");
  t.after(() => store.db.close());
  for (const special of [false, true]) {
    const line = {
      productId: special ? "special" : "plain",
      syrupId: "berry",
      includedId: special ? "sprinkles" : "cream",
      quantity: 3,
      extras: [
        { id: "cream", quantity: 2 },
        { id: "ice", quantity: 1 },
        { id: "sprinkles", quantity: 2 },
      ],
    };
    const original = JSON.stringify(line);
    const actual = previewToppings(line, special);
    const quote = store.quote({ items: [line], coupon: true });
    for (const topping of quote.items[0].toppings) {
      assert.deepEqual(actual[topping.id], {
        included: topping.included,
        extra: topping.quantity - topping.included,
      });
    }
    assert.equal(
      JSON.stringify(line),
      original,
      "プレビューが注文内容を書き換えない",
    );
    assert.equal(quote.discount, 30);
  }
});

test("スペシャルの選択無料分3種類がプレビューとサーバーで一致", (t) => {
  const store = new Store(":memory:");
  t.after(() => store.db.close());
  for (const includedId of ["cream", "oreo", "sprinkles"]) {
    const line = {
      productId: "special",
      syrupId: "choco",
      includedId,
      quantity: 1,
      extras: [],
    };
    const q = store.quote({ items: [line], coupon: false });
    const counts = previewToppings(line, true);
    assert.equal(q.total, 400);
    for (const topping of q.items[0].toppings)
      assert.equal(counts[topping.id].included, topping.included);
    assert.equal(
      counts[includedId].included,
      includedId === "sprinkles" ? 2 : 1,
    );
  }
});

test("大量追加でも画像は上限内、数値は省略せず表示する", () => {
  const line = {
    productId: "special",
    syrupId: "choco",
    includedId: "sprinkles",
    quantity: 2,
    extras: ["cream", "ice", "oreo", "sprinkles"].map((id) => ({
      id,
      quantity: 20,
    })),
  };
  const html = renderToStaticMarkup(
    createElement(PancakeLayers, { line, special: true }),
  );
  assert.equal((html.match(/class="topping-layer /g) || []).length, 15);
  const catalog = [
    { id: "special", name: "スペシャル", category: "special" },
    ...["cream", "ice", "oreo", "sprinkles", "choco"].map((id) => ({
      id,
      name: id,
    })),
  ];
  const full = renderToStaticMarkup(
    createElement(PancakePreview, { line, catalog }),
  );
  assert.match(full, /×21/);
  assert.match(full, /追加 20/);
  assert.match(full, /この内容で 2皿/);
});

test("選び直すと旧レイヤーが消え、未選択ではベースのみ表示する", () => {
  const line = {
    productId: "plain",
    syrupId: "maple",
    includedId: "oreo",
    quantity: 1,
    extras: [],
  };
  const html = renderToStaticMarkup(
    createElement(PancakeLayers, { line, special: false }),
  );
  assert.match(html, /base-single-maple.png/);
  assert.match(html, /cookie-crumb/);
  assert.doesNotMatch(html, /layer-cream|berry.webp/);
  const empty = renderToStaticMarkup(
    createElement(PancakeLayers, { line: null, special: false }),
  );
  assert.doesNotMatch(empty, /topping-layer|syrup-layer/);
  for (const path of Object.values(foodImages))
    assert.ok(existsSync(resolve("public" + path)), path);
});

test("自然なベースを維持し形状別ソースをホイップとアイスだけに重ねる", () => {
  for (const syrupId of ["choco", "maple", "berry"]) {
    for (const extras of [
      [],
      [{ id: "cream", quantity: 3 }],
      [{ id: "ice", quantity: 4 }],
      [
        { id: "cream", quantity: 9 },
        { id: "ice", quantity: 6 },
      ],
    ]) {
      const line = {
        productId: "plain",
        syrupId,
        includedId: "oreo",
        quantity: 1,
        extras,
      };
      const html = renderToStaticMarkup(
        createElement(PancakeLayers, { line, special: false }),
      );
      assert.ok(html.includes(`data-base="base-${syrupId}"`));
      assert.ok(html.includes(`/menu/base-single-${syrupId}.png`));
      assert.doesNotMatch(html, /class="syrup-layer/);
      assert.doesNotMatch(html, /topping-drizzle|drizzle.webp/);
      const expected = extras.reduce(
        (sum, t) => sum + previewLayout(t.id, t.quantity).length,
        0,
      );
      assert.equal(
        (html.match(/class="contour-sauce"/g) || []).length,
        expected,
      );
      for (const t of extras)
        assert.ok(html.includes(`/menu/${t.id}-${syrupId}-overlay-v6.webp`));
    }
  }
});

test("少量から盛り盛りへ段階的に増え、上限以上でも配置と描画負荷を維持", () => {
  for (const id of ["cream", "ice"]) {
    const limit = PREVIEW_LIMITS[id];
    const one = previewLayout(id, 1),
      many = previewLayout(id, limit);
    assert.ok(many.length > 2);
    assert.deepEqual(previewLayout(id, 0), []);
    assert.deepEqual(previewLayout(id, 20), many);
    assert.deepEqual(
      previewLayout(id, limit),
      many,
      "毎回ランダムに位置が飛ばない",
    );
    let prior = 0;
    for (let n = 1; n <= limit; n++) {
      const layout = previewLayout(id, n);
      assert.ok(layout.length >= prior);
      prior = layout.length;
      assert.ok(
        layout.every(
          (p) =>
            p.x > 0 &&
            p.x < 100 &&
            p.y > 0 &&
            p.y < 100 &&
            Number.isFinite(p.w),
        ),
      );
    }
    assert.ok(new Set(many.map((p) => p.rotation)).size > 1);
    if (id === "cream" || id === "ice") {
      for (let n = 1; n <= limit; n++) {
        assert.equal(previewLayout(id, n).length, n, "1追加ごとに1つ増える");
        assert.deepEqual(
          previewLayout(id, n).slice(0, n - 1),
          previewLayout(id, n - 1),
          "既存の山・玉は動かさない",
        );
      }
    }
    if (id === "ice")
      assert.ok(new Set(many.map((p) => p.w)).size > 1, "大小の玉を混ぜる");
  }
});

test("スプレーは既存粒を固定して追加し、上限内で広く散布する", () => {
  assert.deepEqual(sprinkleParticles(0), []);
  let previous = [];
  let previousRange = 0;
  for (let n = 1; n <= 9; n++) {
    const particles = sprinkleParticles(n);
    assert.equal(particles.length, n * 100);
    assert.deepEqual(particles.slice(0, previous.length), previous);
    assert.ok(
      particles.every(
        (p) =>
          p.x >= 14 &&
          p.x <= 86 &&
          p.y >= 35 &&
          p.y <= 69 &&
          p.width >= 0.85 &&
          p.width < 2.15,
      ),
    );
    const range =
      Math.max(...particles.map((p) => p.x)) -
      Math.min(...particles.map((p) => p.x));
    assert.ok(range >= previousRange);
    previousRange = range;
    previous = particles;
  }
  assert.ok(previousRange > 60);
  assert.deepEqual(sprinkleParticles(20), previous);
  const line = {
    productId: "special",
    syrupId: "berry",
    includedId: "",
    quantity: 1,
    extras: [{ id: "sprinkles", quantity: 1 }],
  };
  const html = renderToStaticMarkup(
    createElement(PancakeLayers, { line, special: true }),
  );
  assert.equal(
    (html.match(/class="sprinkle-grain"/g) || []).length,
    200,
    "無料分も散布する",
  );
});

test("オレオ写真は0/1/2/3/5回で追加され、既存位置と間隔を維持", () => {
  assert.deepEqual(cookieParticles(0), []);
  let previous = [];
  for (const n of [1, 2, 3, 5, 6]) {
    const pieces = cookieParticles(n);
    assert.equal(pieces.length, n * 28);
    assert.equal(pieces.filter((p) => p.kind === "medium").length, n * 3);
    assert.equal(pieces.filter((p) => p.kind === "small").length, n * 21);
    assert.equal(pieces.filter((p) => p.kind === "dust").length, n * 4);
    assert.deepEqual(pieces.slice(0, previous.length), previous);
    for (const p of pieces) {
      assert.ok(((p.x - 50) / 30) ** 2 + ((p.y - 52) / 13) ** 2 <= 1);
      assert.ok(p.width >= 1.8 && p.width <= 11);
      assert.ok(foodImages[p.asset].startsWith("/images/oreo/processed/"));
      for (const other of pieces)
        if (p !== other)
          assert.ok(
            Math.hypot(p.x - other.x, (p.y - other.y) * 1.35) >=
              (p.footprint + other.footprint) * 0.38,
          );
    }
    const html = renderToStaticMarkup(
      createElement(PancakeLayers, {
        line: {
          productId: "plain",
          syrupId: "choco",
          includedId: "cream",
          quantity: 1,
          extras: [{ id: "oreo", quantity: n }],
        },
        special: false,
      }),
    );
    assert.equal((html.match(/class="cookie-crumb /g) || []).length, n * 28);
    assert.match(html, /layer-cream/);
    assert.doesNotMatch(
      html,
      /cookie-crushed|cookie-cluster|未反映|--crumb-color/,
    );
    previous = pieces;
  }
  assert.deepEqual(cookieParticles(100), previous);
});

test("粒の大半はパンケーキ面、トッピング上は少量に制限", () => {
  const line = {
    productId: "plain",
    syrupId: "choco",
    includedId: "cream",
    quantity: 1,
    extras: [
      { id: "ice", quantity: 1 },
      { id: "oreo", quantity: 5 },
      { id: "sprinkles", quantity: 5 },
    ],
  };
  const html = renderToStaticMarkup(
    createElement(PancakeLayers, { line, special: false }),
  );
  const spans = [
    ...html.matchAll(
      /<span class="(cookie-crumb photo-piece|sprinkle-grain)" style="([^"]+)"/g,
    ),
  ];
  for (const kind of ["cookie-crumb photo-piece", "sprinkle-grain"]) {
    const pieces = spans.filter((p) => p[1] === kind);
    const above = pieces.filter((p) => p[2].includes("z-index:45")).length;
    assert.ok(pieces.length > 0);
    assert.ok(above <= (kind === "sprinkle-grain" ? 15 : 3));
    assert.ok(
      pieces.filter((p) => p[2].includes("z-index:5;")).length >
        pieces.length * 0.9,
    );
  }
  assert.ok(html.includes("/menu/base-single-choco.png"));
});

test("粒は濃淡のある分布と不揃いな寸法を持ち、再描画でも変わらない", () => {
  for (const make of [sprinkleParticles]) {
    const particles = make(3);
    assert.deepEqual(make(3), particles);
    const bins = Array(8).fill(0);
    for (const p of particles) {
      const column = Math.min(3, Math.max(0, Math.floor((p.x - 14) / 18)));
      const row = p.y < 52 ? 0 : 1;
      bins[row * 4 + column]++;
    }
    assert.ok(
      Math.max(...bins) > Math.min(...bins) * 2,
      "密集域とまばらな域がある",
    );
    assert.ok(
      particles.some((p) => p.x < 24 || p.x > 76),
      "離れた粒も残す",
    );
    assert.ok(
      new Set(particles.map((p) => p.width)).size > 25,
      "寸法が周期的な数種類に揃わない",
    );
    assert.ok(new Set(particles.map((p) => p.rotation)).size > 25);
  }
  assert.equal(new Set(sprinkleParticles(9).map((p) => p.color)).size, 7);
});
