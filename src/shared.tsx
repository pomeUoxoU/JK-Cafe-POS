import { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";
export type Catalog = {
  id: string;
  name: string;
  kind: string;
  category: string;
  price: number;
  stock: number;
  active: number;
};
export type Line = {
  productId: string;
  quantity: number;
  syrupId: string;
  includedId: string;
  recipeVersion?: number;
  extras: { id: string; quantity: number }[];
  name?: string;
  price?: number;
  subtotal?: number;
  toppings?: {
    id: string;
    name: string;
    quantity: number;
    included: number;
    price: number;
  }[];
};
export type Quote = {
  items: Line[];
  subtotal: number;
  discount: number;
  coupon: boolean;
  total: number;
};
export type Order = Quote & {
  id: string;
  day: string;
  number: number;
  status: string;
  version: number;
  paidAt: string | null;
  paid?: boolean;
  refunded: number;
  method: string;
  expiresAt: string;
  pending: null | { kind: string; reason: string; previous: Line[] };
};
export type State = { catalog: Catalog[]; orders: Order[]; today: string };
export type Auth = { token: string; role: string; expires: number };
export const yen = (v: number) => "¥" + v.toLocaleString("ja-JP");
export const labels: Record<string, string> = {
  unpaid: "お会計待ち",
  waiting: "未調理",
  cooking: "調理中",
  ready: "調理完了",
  handed: "受け渡し済み",
  cancelled: "キャンセル",
  expired: "失効（未払い）",
};
export const random = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(32)), (n) =>
    n.toString(16).padStart(2, "0"),
  ).join("");
export const read = <T,>(key: string, fallback: T): T => {
  try {
    return JSON.parse(localStorage.getItem(key) || "null") ?? fallback;
  } catch {
    return fallback;
  }
};
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export async function api(path: string, body?: unknown, token?: string) {
  const controller = new AbortController(),
    timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const r = await fetch("/api/" + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: "Bearer " + token } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const result = await r.json();
    if (!r.ok) throw new ApiError(result.error || "操作できません", r.status);
    return result;
  } finally {
    clearTimeout(timeout);
  }
}
export function useLive(
  load: () => Promise<unknown>,
  receive: (data: any) => void,
  token?: string,
  customerToken?: string,
) {
  const refs = useRef({ load, receive });
  refs.current = { load, receive };
  const [online, setOnline] = useState(false),
    [error, setError] = useState(""),
    refreshRef = useRef<() => void>(() => {});
  useEffect(() => {
    let alive = true,
      sequence = 0;
    const socket = io({ auth: { token, customerToken } });
    const refresh = async () => {
      const n = ++sequence;
      try {
        const data = await refs.current.load();
        if (alive && n === sequence) {
          refs.current.receive(data);
          setOnline(socket.connected);
          setError("");
        }
      } catch (e) {
        if (alive) {
          setOnline(false);
          setError((e as Error).message);
        }
      }
    };
    refreshRef.current = refresh;
    socket.on("connect", refresh);
    socket.on("changed", refresh);
    socket.on("menu", refresh);
    socket.on("disconnect", () => setOnline(false));
    socket.on("connect_error", () => {
      setOnline(false);
      refresh();
    });
    const timer = setInterval(refresh, 5000);
    refresh();
    return () => {
      alive = false;
      socket.disconnect();
      clearInterval(timer);
    };
  }, [token, customerToken]);
  return { online, error, refresh: () => refreshRef.current() };
}
export function useSound() {
  const context = useRef<AudioContext | null>(null),
    [enabled, setEnabled] = useState(false);
  const beep = () => {
    const c = context.current;
    if (!c || c.state !== "running") return;
    [0, 0.23].forEach((t) => {
      const o = c.createOscillator(),
        g = c.createGain();
      o.connect(g);
      g.connect(c.destination);
      o.frequency.value = 880;
      g.gain.setValueAtTime(0.13, c.currentTime + t);
      g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + t + 0.18);
      o.start(c.currentTime + t);
      o.stop(c.currentTime + t + 0.2);
    });
  };
  return {
    beep,
    button: (
      <button
        onClick={async () => {
          context.current ??= new AudioContext();
          await context.current.resume();
          setEnabled(true);
          beep();
        }}
      >
        {enabled ? "通知音 ON" : "通知音を有効化"}
      </button>
    ),
  };
}
export function Connection({ online }: { online: boolean }) {
  return !online ? (
    <div className="offline" role="alert">
      通信が切れています。注文・入金の完了を判断せず、接続の復旧をお待ちください。
    </div>
  ) : null;
}
export function Details({ items }: { items: Line[] }) {
  return (
    <ul className="details">
      {items.map((l, i) => (
        <li key={i}>
          <b>
            {l.name} × {l.quantity}皿
          </b>
          <div className="topping-breakdown">
            <small>1皿あたり</small>
            {l.toppings?.filter((t) => t.included > 0).length ? (
              <div className="included-toppings">
                <em>料金込み</em>
                {l.toppings
                  .filter((t) => t.included > 0)
                  .map((t) => (
                    <span key={t.id}>
                      {t.name} × {t.included}
                    </span>
                  ))}
              </div>
            ) : null}
            {l.toppings?.filter((t) => t.quantity > (t.included || 0))
              .length ? (
              <div className="added-toppings">
                <em>追加</em>
                {l.toppings
                  .filter((t) => t.quantity > (t.included || 0))
                  .map((t) => (
                    <span key={t.id}>
                      {t.name} × {t.quantity - (t.included || 0)}
                    </span>
                  ))}
              </div>
            ) : null}
          </div>
          {l.subtotal !== undefined && <small>小計 {yen(l.subtotal)}</small>}
        </li>
      ))}
    </ul>
  );
}
export function Totals({ q }: { q: Quote }) {
  return (
    <div>
      <p>商品合計 {yen(q.subtotal)}</p>
      {q.coupon && <p>クーポン −{yen(q.discount)}（1会計1回）</p>}
      <div className="total">
        <span>合計</span>
        <strong>{yen(q.total)}</strong>
      </div>
    </div>
  );
}
export function Editor({
  catalog,
  lines,
  setLines,
  coupon,
  setCoupon,
  disabled,
  onQuote,
}: {
  catalog: Catalog[];
  lines: Line[];
  setLines: (x: Line[]) => void;
  coupon: boolean;
  setCoupon: (v: boolean) => void;
  disabled: boolean;
  onQuote: (q: Quote | null) => void;
}) {
  const [error, setError] = useState("");
  const onQuoteRef = useRef(onQuote);
  onQuoteRef.current = onQuote;
  useEffect(() => {
    let active = true;
    onQuoteRef.current(null);
    if (!lines.length || lines.some((l) => !l.syrupId || !l.includedId)) {
      setError("");
      return;
    }
    const timer = setTimeout(
      () =>
        api("public/quote", { items: lines, coupon })
          .then((q) => {
            if (active) {
              onQuoteRef.current(q);
              setError("");
            }
          })
          .catch((e) => {
            if (active) setError(e.message);
          }),
      200,
    );
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [lines, coupon, catalog]);
  const options = (category: string) =>
    catalog.filter((p) => p.active && p.category === category);
  const change = (i: number, patch: Partial<Line>) =>
    setLines(lines.map((l, j) => (i === j ? { ...l, ...patch } : l)));
  const canAdd = (p: Catalog) =>
    p.stock > 0 &&
    options("syrup").some((t) => t.stock > 0) &&
    (p.category === "standard"
      ? options("normal").some((t) => t.stock > 0)
      : options("normal").some(
          (t) => t.stock >= (t.id === "sprinkles" ? 2 : 1),
        ) &&
        ["sprinkles", "ice"].every((id) =>
          catalog.some((t) => t.id === id && t.active && t.stock > 0),
        ));
  return (
    <section className="panel">
      <div className="products">
        {catalog
          .filter(
            (p) => p.active && p.kind === "product" && p.category !== "legacy",
          )
          .map((p) => (
            <button
              key={p.id}
              disabled={disabled || !canAdd(p)}
              onClick={() =>
                setLines([
                  ...lines,
                  {
                    productId: p.id,
                    quantity: 1,
                    syrupId: "",
                    includedId: "",
                    extras: [],
                  },
                ])
              }
            >
              <b>{p.name}</b>
              <strong>{yen(p.price)}</strong>
              <small>
                {p.category === "standard"
                  ? "シロップ1種・通常トッピング1種込み"
                  : "シロップ・スプレー・アイス＋選べる通常トッピング1種込み"}
              </small>
              {!canAdd(p) && <b>売り切れ</b>}
            </button>
          ))}
      </div>
      {lines.map((l, i) => {
        const p = catalog.find((p) => p.id === l.productId);
        return (
          <fieldset disabled={disabled} className="plate" key={i}>
            <legend>
              {i + 1}. {p?.name}
            </legend>
            <div className="row">
              <label>
                同じ内容の皿数
                <input
                  type="number"
                  inputMode="numeric"
                  min="1"
                  max="30"
                  value={l.quantity}
                  onChange={(e) =>
                    change(i, { quantity: Number(e.target.value) })
                  }
                />
              </label>
              <button onClick={() => setLines(lines.filter((_, j) => j !== i))}>
                この皿を削除
              </button>
            </div>
            <label>
              シロップを1種類選択（料金込み）
              <select
                value={l.syrupId}
                onChange={(e) => change(i, { syrupId: e.target.value })}
              >
                <option value="">選択してください</option>
                {options("syrup").map((t) => (
                  <option
                    key={t.id}
                    value={t.id}
                    disabled={!t.stock && l.syrupId !== t.id}
                  >
                    {t.name}
                    {!t.stock ? "（売り切れ）" : ""}
                  </option>
                ))}
              </select>
            </label>
            {p?.category === "special" && (
              <p>
                チョコスプレー1回・アイス1回込み。さらに通常トッピングを1種類選んでください。
              </p>
            )}
            {
              <label>
                通常トッピングを1種類選択（料金込み）
                <select
                  value={l.includedId}
                  onChange={(e) => change(i, { includedId: e.target.value })}
                >
                  <option value="">選択してください</option>
                  {options("normal").map((t) => (
                    <option
                      key={t.id}
                      value={t.id}
                      disabled={!t.stock && l.includedId !== t.id}
                    >
                      {t.name}
                      {p?.category === "special" && t.id === "sprinkles"
                        ? "（固定分と合わせて2回込み）"
                        : ""}
                      {!t.stock ? "（売り切れ）" : ""}
                    </option>
                  ))}
                </select>
              </label>
            }
            <h3>追加トッピング（1皿あたり）</h3>
            {catalog
              .filter((t) => t.active && ["normal", "ice"].includes(t.category))
              .map((t) => {
                const n = l.extras.find((e) => e.id === t.id)?.quantity || 0;
                const update = (q: number) =>
                  change(i, {
                    extras: [
                      ...l.extras.filter((e) => e.id !== t.id),
                      ...(q ? [{ id: t.id, quantity: q }] : []),
                    ],
                  });
                return (
                  <div className="topping" key={t.id}>
                    <span>
                      {t.name} +{yen(t.price)} / 回
                    </span>
                    <div className="stepper">
                      <button
                        aria-label={t.name + "の追加を減らす"}
                        disabled={!n}
                        onClick={() => update(n - 1)}
                      >
                        −
                      </button>
                      <b>{n}</b>
                      <button
                        aria-label={t.name + "を追加"}
                        disabled={!t.stock || n >= 20}
                        onClick={() => update(n + 1)}
                      >
                        ＋
                      </button>
                    </div>
                  </div>
                );
              })}
          </fieldset>
        );
      })}
      {!lines.length && <p className="empty">商品を選択してください</p>}
      <label className="check">
        <input
          disabled={disabled}
          type="checkbox"
          checked={coupon}
          onChange={(e) => setCoupon(e.target.checked)}
        />
        30円引きクーポンを使う（会計時に提示）
      </label>
      {error && <p className="error">{error}</p>}
    </section>
  );
}
