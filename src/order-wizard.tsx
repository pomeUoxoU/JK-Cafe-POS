import { recommendToppings } from "./recommendations";
import { FoodVisual as Visual, PancakePreview } from "./pancake-preview";
import { useEffect, useState } from "react";
import { api, Catalog, Details, Line, Quote, Totals, yen } from "./shared";

const steps = ["商品", "シロップ", "基本トッピング", "追加", "注文確認"];
export function OrderWizard({
  catalog,
  lines,
  setLines,
  coupon,
  setCoupon,
  q,
  onQuote,
  disabled,
  online,
  onSend,
}: {
  catalog: Catalog[];
  lines: Line[];
  setLines: (v: Line[]) => void;
  coupon: boolean;
  setCoupon: (v: boolean) => void;
  q: Quote | null;
  onQuote: (v: Quote | null) => void;
  disabled: boolean;
  online: boolean;
  onSend: () => void;
}) {
  const [step, setStep] = useState(lines.length ? 5 : 1);
  const [draft, setDraft] = useState<Line | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [previewIndex, setPreviewIndex] = useState(0);
  useEffect(() => {
    let active = true;
    onQuote(null);
    setError("");
    if (!lines.length) return;
    const timer = setTimeout(() => {
      api("public/quote", { items: lines, coupon })
        .then((value) => {
          if (active) onQuote(value);
        })
        .catch((e) => {
          if (active) setError(e.message);
        });
    }, 200);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [lines, coupon, catalog, online, onQuote]);
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "auto" });
  }, [step]);
  const options = (category: string) =>
    catalog.filter((p) => p.active && p.category === category);
  const product = catalog.find((p) => p.id === draft?.productId);
  const special = product?.category === "special";
  const available = (id: string) =>
    catalog.some((p) => p.id === id && p.active && p.stock > 0);
  const canAdd = (p: Catalog) =>
    p.stock > 0 &&
    options("syrup").some((t) => t.stock > 0) &&
    (p.category === "standard"
      ? options("normal").some((t) => t.stock > 0)
      : available("sprinkles") &&
        available("ice") &&
        options("normal").some(
          (t) => t.stock >= (t.id === "sprinkles" ? 2 : 1),
        ));
  const update = (patch: Partial<Line>) =>
    setDraft(draft ? { ...draft, ...patch } : null);
  function save() {
    if (!draft) return;
    onQuote(null);
    setLines(
      editing === null
        ? [...lines, draft]
        : lines.map((l, i) => (i === editing ? draft : l)),
    );
    setPreviewIndex(editing ?? lines.length);
    setStep(5);
    setDraft(null);
    setEditing(null);
  }
  const suggested = recommendToppings(draft, catalog);
  const recommendations = new Set(suggested.map((r) => r.item.id));
  function changeExtra(p: Catalog, delta: number) {
    if (disabled) return;
    setDraft((current) => {
      if (!current) return current;
      const count = current.extras.find((t) => t.id === p.id)?.quantity || 0;
      const next = Math.max(0, Math.min(20, count + delta));
      if (delta > 0 && (!p.active || p.stock <= count)) return current;
      return {
        ...current,
        extras: [
          ...current.extras.filter((t) => t.id !== p.id),
          ...(next ? [{ id: p.id, quantity: next }] : []),
        ],
      };
    });
  }
  function choice(
    p: Catalog,
    selected: boolean,
    select: () => void,
    note: string,
    enabled = p.stock > 0,
  ) {
    return (
      <button
        type="button"
        key={p.id}
        className={`choice-card ${selected ? "selected" : ""}`}
        aria-pressed={selected}
        disabled={disabled || !enabled}
        onClick={select}
      >
        <Visual id={p.id} />
        <span className="choice-name">{p.name}</span>
        <span className="choice-price">{enabled ? note : "売り切れ"}</span>
        <span className="selection-mark">{selected ? "✓ 選択中" : "選ぶ"}</span>
      </button>
    );
  }
  return (
    <section className="wizard">
      <ol className="order-steps" aria-label="注文の手順">
        {steps.map((s, i) => (
          <li
            key={s}
            className={step === i + 1 ? "current" : step > i + 1 ? "done" : ""}
            aria-current={step === i + 1 ? "step" : undefined}
          >
            <span>{i + 1}</span>
            {s}
          </li>
        ))}
      </ol>
      <div className="ordering-layout">
        <div className="ordering-controls">
          <div className="wizard-heading">
            <div>
              <p className="eyebrow">STEP {step} / 5</p>
              <h2>
                {
                  [
                    "商品を選ぶ",
                    "シロップを1種類選ぶ",
                    "基本トッピングを1種類選ぶ",
                    "追加トッピングを選ぶ",
                    "注文内容を確認",
                  ][step - 1]
                }
              </h2>
            </div>
            <span className="basket-count">
              {lines.reduce((n, l) => n + l.quantity, 0)}皿 選択済み
            </span>
          </div>
          {step < 5 && product && (
            <p className="selection-summary">
              {product.name} · {yen(product.price)}
              {draft?.syrupId &&
                ` ／ ${catalog.find((p) => p.id === draft.syrupId)?.name}`}
            </p>
          )}
          {step === 1 && (
            <div className="choice-grid product-choices">
              {catalog
                .filter(
                  (p) =>
                    p.active && p.kind === "product" && p.category !== "legacy",
                )
                .map((p) =>
                  choice(
                    p,
                    draft?.productId === p.id,
                    () =>
                      setDraft({
                        productId: p.id,
                        syrupId: "",
                        includedId: "",
                        quantity: draft?.quantity || 1,
                        extras: [],
                      }),
                    yen(p.price) +
                      (p.category === "special"
                        ? " · アイス・スプレー＋選べる通常トッピング込み"
                        : " · シロップ・基本トッピング込み"),
                    canAdd(p),
                  ),
                )}
            </div>
          )}
          {step === 2 && (
            <>
              <p>1種類は基本料金に含まれます。</p>
              <div className="choice-grid">
                {options("syrup").map((p) =>
                  choice(
                    p,
                    draft?.syrupId === p.id,
                    () => update({ syrupId: p.id }),
                    "料金込み",
                  ),
                )}
              </div>
            </>
          )}
          {step === 3 && (
            <>
              {special && (
                <div className="included-panel">
                  <b>アイス1回・チョコスプレー1回・シロップ1種類込み</b>
                  <p>さらに通常トッピングを1種類、無料で選べます。</p>
                </div>
              )}
              <p>1種類・1回分は基本料金に含まれます。</p>
              <div className="choice-grid">
                {options("normal").map((p) =>
                  choice(
                    p,
                    draft?.includedId === p.id,
                    () => update({ includedId: p.id }),
                    special && p.id === "sprinkles"
                      ? "固定分と合わせて2回分込み"
                      : "1回分込み",
                    p.stock >= (special && p.id === "sprinkles" ? 2 : 1),
                  ),
                )}
              </div>
            </>
          )}
          {step === 4 && draft && (
            <>
              <p>追加なしでも進めます。追加回数は1皿あたりです。</p>
              {suggested.length > 0 && (
                <section
                  className="recommendation-section"
                  aria-label="おすすめトッピング"
                >
                  <div className="recommendation-heading">
                    <h3>この組み合わせにおすすめ</h3>
                    <span>＋1回</span>
                  </div>
                  <div className="recommendation-grid">
                    {suggested.map(({ item: p, context, reason }) => (
                      <button
                        type="button"
                        className="recommendation-card"
                        key={p.id}
                        disabled={disabled}
                        aria-label={`${context}。${reason} ＋${yen(p.price)}`}
                        onClick={() => changeExtra(p, 1)}
                      >
                        <span className="recommendation-label">
                          あと1種類 <small>相性◎</small>
                        </span>
                        <Visual id={p.id} />
                        <span>
                          <b>{p.name}</b>
                          <small>＋{yen(p.price)} / 回</small>
                        </span>
                        <span className="recommendation-reason">
                          <small>{context}</small>
                          <b>{reason}</b>
                        </span>
                        <span className="recommendation-add">＋ 追加</span>
                      </button>
                    ))}
                  </div>
                </section>
              )}
              <div className="extras-grid">
                {catalog
                  .filter(
                    (p) => p.active && ["normal", "ice"].includes(p.category),
                  )
                  .map((p) => {
                    const count =
                      draft.extras.find((t) => t.id === p.id)?.quantity || 0;
                    return (
                      <div
                        className={`extra-card ${count ? "has-extra" : ""}`}
                        key={p.id}
                      >
                        <Visual id={p.id} />
                        <div>
                          <h3>{p.name}</h3>
                          <p>+{yen(p.price)} / 回</p>
                          {recommendations.has(p.id) && p.stock > 0 && (
                            <span className="recommendation">おすすめ</span>
                          )}
                          {p.stock <= 0 && <span>売り切れ</span>}
                        </div>
                        <div className="stepper">
                          <button
                            aria-label={`${p.name}を1回減らす`}
                            disabled={disabled || count === 0}
                            onClick={() => changeExtra(p, -1)}
                          >
                            −
                          </button>
                          <output aria-label={`${p.name}の追加回数`}>
                            {count}
                          </output>
                          <button
                            aria-label={`${p.name}を1回追加`}
                            disabled={
                              disabled || p.stock <= count || count >= 20
                            }
                            onClick={() => changeExtra(p, 1)}
                          >
                            ＋
                          </button>
                        </div>
                      </div>
                    );
                  })}
              </div>
              <div className="quantity-row">
                <div>
                  <b>この内容の皿数</b>
                  <p>別のトッピングの皿は、確認画面から追加できます。</p>
                </div>
                <div className="stepper">
                  <button
                    aria-label="皿数を減らす"
                    disabled={disabled || draft.quantity <= 1}
                    onClick={() => update({ quantity: draft.quantity - 1 })}
                  >
                    −
                  </button>
                  <output>{draft.quantity}皿</output>
                  <button
                    aria-label="皿数を増やす"
                    disabled={
                      disabled ||
                      draft.quantity >= Math.min(30, product?.stock || 0)
                    }
                    onClick={() => update({ quantity: draft.quantity + 1 })}
                  >
                    ＋
                  </button>
                </div>
              </div>
            </>
          )}
          {step === 5 && (
            <>
              {lines.map((l, i) => (
                <article className="review-plate" key={i}>
                  <div className="review-plate-heading">
                    <b>
                      {i + 1}. {catalog.find((p) => p.id === l.productId)?.name}{" "}
                      × {l.quantity}皿
                    </b>
                    <div>
                      <button
                        disabled={disabled}
                        onClick={() => {
                          setDraft(l);
                          setEditing(i);
                          setStep(2);
                        }}
                      >
                        変更
                      </button>
                      <button
                        disabled={disabled}
                        onClick={() => {
                          onQuote(null);
                          setLines(lines.filter((_, j) => i !== j));
                        }}
                      >
                        削除
                      </button>
                    </div>
                  </div>
                  {q ? (
                    <Details items={[q.items[i]]} />
                  ) : (
                    <p>
                      {catalog.find((p) => p.id === l.syrupId)?.name ||
                        "シロップ未選択"}{" "}
                      ／{" "}
                      {catalog.find((p) => p.id === l.includedId)?.name ||
                        "基本トッピング未選択"}
                      {l.extras
                        .map(
                          (t) =>
                            ` ／ ${catalog.find((p) => p.id === t.id)?.name} 追加${t.quantity}回`,
                        )
                        .join("")}
                    </p>
                  )}
                </article>
              ))}
              <button
                className="add-plate"
                disabled={disabled}
                onClick={() => {
                  setDraft(null);
                  setEditing(null);
                  setStep(1);
                }}
              >
                ＋ 商品を追加する
              </button>
              <label className={`coupon-card ${coupon ? "selected" : ""}`}>
                <input
                  type="checkbox"
                  checked={coupon}
                  disabled={disabled}
                  onChange={(e) => {
                    onQuote(null);
                    setCoupon(e.target.checked);
                  }}
                />
                <span>
                  <b>
                    クーポンを使う <strong>−30円</strong>
                  </b>
                  <small>
                    1会計1回。お会計時にスタッフへ提示してください。
                  </small>
                </span>
              </label>
              {error && (
                <p className="error" role="alert">
                  {error}
                </p>
              )}
              {q ? (
                <Totals q={q} />
              ) : (
                <p role="status">
                  {!lines.length
                    ? "商品を追加してください。"
                    : error
                      ? "内容を変更して、もう一度確認してください。"
                      : "金額・在庫を確認しています…"}
                </p>
              )}
              <p className="payment-note">
                送信後、会計スタッフへ現金でお支払いください。
              </p>
              <button
                className="primary large"
                disabled={disabled || !online || !q || !lines.length}
                onClick={onSend}
              >
                この内容で注文を送信
              </button>
            </>
          )}
          {step < 5 && (
            <div className="wizard-footer">
              <button
                disabled={disabled}
                onClick={() => {
                  if (step === 1) {
                    setDraft(null);
                    setStep(5);
                  } else setStep(step - 1);
                }}
              >
                {step === 1 ? "注文一覧へ" : "戻る"}
              </button>
              <button
                className="primary"
                disabled={
                  disabled ||
                  !draft ||
                  (step === 1 && (!product || !canAdd(product))) ||
                  (step === 2 && !available(draft?.syrupId || "")) ||
                  (step === 3 &&
                    (!available(draft?.includedId || "") ||
                      (special &&
                        (!available("sprinkles") ||
                          !available("ice") ||
                          (draft?.includedId === "sprinkles" &&
                            (catalog.find((p) => p.id === "sprinkles")?.stock ||
                              0) < 2)))))
                }
                onClick={() => (step === 4 ? save() : setStep(step + 1))}
              >
                {step === 4 ? "注文内容を確認する" : "次へ"}
              </button>
            </div>
          )}
        </div>
        <aside className="ordering-preview" aria-label="選択中のパンケーキ">
          {step === 5 && lines.length > 1 && (
            <div className="preview-tabs" aria-label="プレビューする商品">
              {lines.map((l, i) => (
                <button
                  key={i}
                  aria-pressed={i === Math.min(previewIndex, lines.length - 1)}
                  onClick={() => setPreviewIndex(i)}
                >
                  {i + 1}品目 · {l.quantity}皿
                </button>
              ))}
            </div>
          )}
          <PancakePreview
            line={
              step === 5
                ? lines[Math.min(previewIndex, lines.length - 1)] || null
                : draft
            }
            catalog={catalog}
          />
        </aside>
      </div>
    </section>
  );
}
