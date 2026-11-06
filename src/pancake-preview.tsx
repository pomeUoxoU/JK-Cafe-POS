import type { CSSProperties } from "react";
import type { Catalog, Line } from "./shared";

// All files are local. Replace files at these paths without changing order data.
export const foodImages: Record<string, string> = {
  base: "/menu/base-single-plain.png",
  "base-choco": "/menu/base-single-choco.png",
  "base-maple": "/menu/base-single-maple.png",
  "base-berry": "/menu/base-single-berry.png",
  choco: "/menu/choco.webp",
  maple: "/menu/maple.webp",
  berry: "/menu/berry.webp",
  cream: "/menu/cream.webp",
  sprinkles: "/menu/sprinkles-micro-v3.webp",
  ice: "/menu/ice.webp",
  oreo: "/images/oreo/processed/piece-01.png",
  ...Object.fromEntries(
    ["piece", "crumb"].flatMap((kind) =>
      Array.from({ length: 10 }, (_, i) => [
        `oreo-${kind}-${i}`,
        `/images/oreo/processed/${kind}-${String(i).padStart(2, "0")}.png`,
      ]),
    ),
  ),

  "cream-choco-overlay": "/menu/cream-choco-overlay-v6.webp",
  "cream-maple-overlay": "/menu/cream-maple-overlay-v6.webp",
  "cream-berry-overlay": "/menu/cream-berry-overlay-v6.webp",
  "ice-choco-overlay": "/menu/ice-choco-overlay-v6.webp",
  "ice-maple-overlay": "/menu/ice-maple-overlay-v6.webp",
  "ice-berry-overlay": "/menu/ice-berry-overlay-v6.webp",
};

export function FoodImage({
  id,
  fallbackId,
}: {
  id: string;
  fallbackId?: string;
}) {
  return (
    <img
      src={foodImages[id]}
      alt=""
      draggable={false}
      decoding="async"
      onError={(e) => {
        const fallback = fallbackId && foodImages[fallbackId];
        if (fallback && !e.currentTarget.src.endsWith(fallback))
          e.currentTarget.src = fallback;
        else e.currentTarget.hidden = true;
      }}
    />
  );
}

// These counts are for drawing only. The server remains the sole price/stock authority.
export function previewToppings(line: Line | null, special: boolean) {
  const counts: Record<string, { included: number; extra: number }> = {};
  const add = (id: string, included: number, extra: number) => {
    if (!id) return;
    const old = counts[id] || { included: 0, extra: 0 };
    counts[id] = {
      included: old.included + included,
      extra: old.extra + extra,
    };
  };
  if (line) {
    add(line.syrupId, 1, 0);
    if (special) {
      add("sprinkles", 1, 0);
      add("ice", 1, 0);
    }
    add(line.includedId, 1, 0);
    for (const t of line.extras) add(t.id, 0, t.quantity);
  }
  return counts;
}

// Visual serving limits do not limit the order. Dense toppings use staged clusters.
export const PREVIEW_LIMITS = { cream: 9, ice: 6, oreo: 6, sprinkles: 9 };
type Placement = {
  x: number;
  y: number;
  w: number;
  z: number;
  rotation: number;
  stretch: number;
  opacity: number;
};
const arrangements: Record<string, number[][]> = {
  cream: [
    [33, 47, 27, 9, -5],
    [25, 53, 24, 12, 8],
    [43, 53, 25, 13, -9],
    [30, 40, 25, 15, 4],
    [43, 42, 23, 16, -4],
    [35, 34, 23, 18, 3],
    [23, 42, 18, 20, -7],
    [46, 33, 19, 21, 5],
    [34, 27, 18, 22, -3],
  ],
  ice: [
    [65, 44, 29, 6, -6],
    [74, 53, 25, 10, 9],
    [54, 54, 26, 11, -10],
    [70, 40, 23, 14, 4],
    [56, 39, 25, 17, -5],
    [64, 31, 23, 19, 3],
  ],
};
export function previewLayout(id: string, quantity: number): Placement[] {
  const limit = PREVIEW_LIMITS[id as keyof typeof PREVIEW_LIMITS];
  if (!limit || quantity <= 0) return [];
  const n = Math.min(limit, quantity);
  if (id === "sprinkles" || id === "oreo") return [];
  const count = n;
  return arrangements[id].slice(0, count).map(([x, y, w, z, rotation]) => ({
    x,
    y,
    w,
    z,
    rotation,
    stretch: 1,
    opacity: 1,
  }));
}

// Seeded sampling: redraws and quantity changes never reshuffle existing pieces.
function grainRandom(index: number, channel: number, seed: number) {
  let h =
    Math.imul(index + 1, 374761393) ^ Math.imul(channel + 1, 668265263) ^ seed;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function scatteredPoint(index: number, batch: number, seed: number) {
  const r = (channel: number) => grainRandom(index, channel, seed);
  const angle = r(1) * Math.PI * 2;
  const mix = r(0);
  let x: number, y: number;
  if (mix < 0.64) {
    // Unequal handfuls leave visible gaps between deposits.
    const centers = [
      [-0.43, -0.22],
      [0.38, 0.12],
      [-0.08, 0.55],
    ];
    const center = centers[mix < 0.29 ? 0 : mix < 0.51 ? 1 : 2];
    const radius = Math.sqrt(r(2));
    x = center[0] + Math.cos(angle) * radius * 0.24;
    y = center[1] + Math.sin(angle) * radius * 0.28;
  } else {
    // Broad sparse scatter plus a few detached grains near the rim.
    const radius = mix > 0.94 ? 0.88 + r(2) * 0.1 : Math.sqrt(r(2)) * 0.94;
    x = Math.cos(angle) * radius;
    y = Math.sin(angle) * radius;
  }
  return {
    x: 50 + x * (32 + Math.min(batch, 8) * 0.5),
    y: 52 + y * (15 + Math.min(batch, 8) * 0.2),
  };
}
export function sprinkleParticles(quantity: number) {
  const servings = Math.max(
    0,
    Math.min(PREVIEW_LIMITS.sprinkles, Math.floor(quantity)),
  );
  return Array.from({ length: servings * 100 }, (_, i) => {
    const r = (channel: number) => grainRandom(i, channel, 731);
    return {
      ...scatteredPoint(i, Math.floor(i / 100), 731),
      width: 0.85 + r(3) * 1.3,
      height: 0.35 + r(4) * 0.23,
      rotation: r(5) * 180,
      color: [
        "#e65b91",
        "#a47bd2",
        "#48b6dc",
        "#f2c341",
        "#ed8669",
        "#9ac957",
        "#fff8ec",
      ][Math.floor(r(6) * 7)],
      delay: Math.floor(r(7) * 110),
    };
  });
}
type CookiePiece = {
  kind: "medium" | "small" | "dust";
  footprint: number;
  x: number;
  y: number;
  width: number;
  rotation: number;
  asset: string;
  delay: number;
};
// Build one deterministic sequence, then show its prefix. Minimum spacing prevents piles.
const cookieSequence: CookiePiece[] = [];
for (
  let attempt = 0;
  cookieSequence.length < PREVIEW_LIMITS.oreo * 28 && attempt < 100000;
  attempt++
) {
  const r = (channel: number) => grainRandom(attempt, channel, 8431);
  const slot = cookieSequence.length % 28;
  const kind = slot < 3 ? "medium" : slot < 24 ? "small" : "dust";
  const creamPiece = slot < 2;
  const nearWhip = slot < 7 && r(7) < 0.75;
  const angle = r(0) * Math.PI * 2;
  const radius = Math.sqrt(r(1));
  const x = nearWhip
    ? 39 + Math.cos(angle) * radius * 14
    : 50 + Math.cos(angle) * radius * 30;
  const y = nearWhip
    ? 54 + Math.sin(angle) * radius * 9
    : 52 + Math.sin(angle) * radius * 13;
  if (((x - 50) / 30) ** 2 + ((y - 52) / 13) ** 2 > 1) continue;
  // The isolated crumbs occupy less of their transparent canvas than the main pieces.
  const width = creamPiece
    ? 6.2 + r(3)
    : kind === "medium"
      ? 9 + r(3) * 2
      : kind === "small"
        ? 6 + r(3) * 2
        : 1.8 + r(3) * 0.8;
  const footprint = width * (creamPiece ? 0.8 : 0.45);
  if (
    cookieSequence.some(
      (p) =>
        Math.hypot(x - p.x, (y - p.y) * 1.35) <
        (footprint + p.footprint) * 0.38,
    )
  )
    continue;
  cookieSequence.push({
    kind,
    footprint,
    x,
    y,
    width,
    rotation: (r(4) - 0.5) * 70,
    asset: creamPiece
      ? `oreo-piece-${[4, 5, 6, 9][Math.floor(r(5) * 4)]}`
      : `oreo-crumb-${[4, 5, 7][Math.floor(r(5) * 3)]}`,
    delay: Math.floor(r(6) * 120),
  });
}
export function cookieParticles(quantity: number) {
  return cookieSequence.slice(
    0,
    Math.max(0, Math.min(PREVIEW_LIMITS.oreo, Math.floor(quantity))) * 28,
  );
}

export function PancakeLayers({
  line,
  special,
  animate = true,
}: {
  line: Line | null;
  special: boolean;
  animate?: boolean;
}) {
  const counts = previewToppings(line, special);
  const raisedToppings = ["cream", "ice"].flatMap((id) =>
    previewLayout(id, (counts[id]?.included || 0) + (counts[id]?.extra || 0)),
  );
  const toppingDepth = (x: number, y: number, candidate: boolean) =>
    candidate &&
    raisedToppings.some(
      (p) =>
        ((x - p.x) / (p.w * 0.3)) ** 2 + ((y - p.y) / (p.w * 0.3)) ** 2 < 1,
    )
      ? 45
      : 5;
  const selectedBase = line?.syrupId ? `base-${line.syrupId}` : "base";
  const baseId = foodImages[selectedBase] ? selectedBase : "base";
  return (
    <div
      className={`pancake-scene ${animate ? "animate-food" : ""}`}
      aria-hidden="true"
    >
      <div className="plate-placeholder" />
      <div key={baseId} className="pancake-base" data-base={baseId}>
        <FoodImage id={baseId} fallbackId="base" />
      </div>
      {["cream", "ice"].flatMap((id) => {
        const n = (counts[id]?.included || 0) + (counts[id]?.extra || 0);
        return previewLayout(id, n).map((pos, i) => {
          const style = {
            left: `${pos.x}%`,
            top: `${pos.y + 5}%`,
            width: `${pos.w}%`,
            zIndex: pos.z,
            transform: `translate(-50%, -50%) rotate(${pos.rotation}deg) scaleY(${pos.stretch})`,
            opacity: pos.opacity,
          } as CSSProperties;
          return (
            <div
              key={`${id}-${i}`}
              className={`topping-layer layer-${id}`}
              style={style}
            >
              <div className="food-arrival">
                <FoodImage id={id} />
                {["cream", "ice"].includes(id) &&
                  foodImages[`${id}-${line?.syrupId}-overlay`] && (
                    <div
                      className="contour-sauce"
                      style={{
                        maskImage: `url(${foodImages[id]})`,
                        WebkitMaskImage: `url(${foodImages[id]})`,
                      }}
                    >
                      <FoodImage
                        key={`${id}-${line?.syrupId}`}
                        id={`${id}-${line?.syrupId}-overlay`}
                      />
                    </div>
                  )}
              </div>
            </div>
          );
        });
      })}
      <div className="cookie-field">
        {cookieParticles(
          (counts.oreo?.included || 0) + (counts.oreo?.extra || 0),
        ).map((p, i) => (
          <span
            key={`oreo-${i}`}
            className="cookie-crumb photo-piece"
            style={{
              zIndex: toppingDepth(
                p.x,
                p.y,
                p.kind === "small" && i % 28 === 6 && i < 84,
              ),
              left: `${p.x}%`,
              top: `${p.y + 5}%`,
              width: `${p.width}%`,
              transform: `translate(-50%, -50%) rotate(${p.rotation}deg)`,
              aspectRatio: 1,
            }}
          >
            <i style={{ animationDelay: `${p.delay}ms` }}>
              <FoodImage id={p.asset} />
            </i>
          </span>
        ))}
      </div>
      <div className="sprinkle-field">
        {sprinkleParticles(
          (counts.sprinkles?.included || 0) + (counts.sprinkles?.extra || 0),
        ).map((p, i) => (
          <span
            key={`grain-${i}`}
            className="sprinkle-grain"
            style={{
              zIndex: toppingDepth(p.x, p.y, i % 12 === 0 && i < 180),
              left: `${p.x}%`,
              top: `${p.y + 5}%`,
              width: `${p.width}%`,
              height: `${p.height}%`,
              transform: `rotate(${p.rotation}deg)`,
            }}
          >
            <i
              style={
                {
                  "--grain-color": p.color,
                  animationDelay: `${p.delay}ms`,
                } as CSSProperties
              }
            />
          </span>
        ))}
      </div>
    </div>
  );
}

export function FoodVisual({ id }: { id: string }) {
  const product = id === "plain" || id === "special";
  const syrup = ["choco", "maple", "berry"].includes(id);
  return (
    <span className={`food-visual food-${id}`} aria-hidden="true">
      {product || syrup ? (
        <PancakeLayers
          animate={false}
          special={id === "special"}
          line={{
            productId: syrup ? "plain" : id,
            syrupId: syrup ? id : "choco",
            includedId: "",
            quantity: 1,
            extras: [],
          }}
        />
      ) : foodImages[id] ? (
        <FoodImage id={id} />
      ) : (
        <span className="image-placeholder">写真準備中</span>
      )}
    </span>
  );
}

export function PancakePreview({
  line,
  catalog,
}: {
  line: Line | null;
  catalog: Catalog[];
}) {
  const product = catalog.find((p) => p.id === line?.productId);
  const counts = previewToppings(line, product?.category === "special");
  return (
    <div className="preview-card">
      <div className="preview-title">
        <h2>完成イメージ</h2>
        <span>1皿分</span>
      </div>
      <PancakeLayers line={line} special={product?.category === "special"} />
      <div
        className="preview-description"
        aria-live="polite"
        aria-atomic="true"
      >
        <h3>{product?.name || "商品を選んでください"}</h3>
        {line && (
          <p className="preview-quantity">この内容で {line.quantity}皿</p>
        )}
        <ul>
          {Object.entries(counts).map(([id, n]) => (
            <li key={id}>
              <span>{catalog.find((p) => p.id === id)?.name || id}</span>
              <b>×{n.included + n.extra}</b>
              <small>
                {n.included > 0 && `込み ${n.included}`}
                {n.included > 0 && n.extra > 0 && " ／ "}
                {n.extra > 0 && `追加 ${n.extra}`}
              </small>
            </li>
          ))}
        </ul>
      </div>
      <small className="preview-disclaimer">
        盛り付けは量に応じたイメージです。ホイップ・スプレーは9回、クッキー・アイスは6回相当まで表示。実際の数量は「×n」をご確認ください。
      </small>
    </div>
  );
}
