import { useRef, useState, useEffect } from "react";
import {
  api,
  ApiError,
  Auth,
  Catalog,
  Connection,
  Details,
  Editor,
  labels,
  Line,
  Order,
  Quote,
  random,
  read,
  State,
  Totals,
  useLive,
  useSound,
  yen,
} from "./shared";
type Command = { action: string; body: any };
export function Staff({ role }: { role: string }) {
  const storage = role === "admin" ? sessionStorage : localStorage,
    key = "pos-auth-" + role;
  const [auth, setAuth] = useState<Auth | null>(() => {
      try {
        const a = JSON.parse(storage.getItem(key) || "null");
        return a?.expires > Date.now() ? a : null;
      } catch {
        return null;
      }
    }),
    [error, setError] = useState("");
  const logout = () => {
    storage.removeItem(key);
    setAuth(null);
  };
  if (auth) return <Workspace auth={auth} invalid={logout} />;
  return (
    <main className="login">
      <h1>JK-Cafe</h1>
      <h2>
        {
          {
            register: "会計スタッフ端末登録",
            kitchen: "調理端末登録",
            admin: "管理者ログイン",
          }[role]
        }
      </h2>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          try {
            const a = await api("login", {
              role,
              pin: f.get("pin"),
              code: f.get("code"),
              name: f.get("name"),
            });
            storage.setItem(key, JSON.stringify(a));
            setAuth(a);
            setError("");
          } catch (e) {
            setError((e as Error).message);
          }
        }}
      >
        {role === "admin" ? (
          <label>
            管理者PIN
            <input
              name="pin"
              type="password"
              inputMode="numeric"
              pattern="[0-9]{6}"
              required
              autoComplete="off"
            />
          </label>
        ) : (
          <>
            <label>
              端末名
              <input
                name="name"
                placeholder="会計PC / 調理タブレット"
                maxLength={100}
                required
              />
            </label>
            <label>
              初回登録コード
              <input
                name="code"
                type="password"
                inputMode="numeric"
                required
                autoComplete="off"
              />
            </label>
            <p>
              登録後はこの端末で90日間ログインを保持します。お客さん用タブレットでは登録しないでください。
            </p>
          </>
        )}
        <button className="primary large">
          {role === "admin" ? "管理画面を開く" : "この端末を登録する"}
        </button>
      </form>
      {error && <p className="error">{error}</p>}
      <small>初回情報はPCの data/initial-access.json にあります。</small>
    </main>
  );
}
function Workspace({ auth, invalid }: { auth: Auth; invalid: () => void }) {
  const [state, setState] = useState<State>({
      catalog: [],
      orders: [],
      today: "",
    }),
    [view, setView] = useState(auth.role),
    [history, setHistory] = useState(false),
    [selected, setSelected] = useState<string | null>(null),
    [edit, setEdit] = useState<Order | null>(null),
    [notice, setNotice] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [pending, setPending] = useState<Command | null>(() =>
      read("pos-command-" + auth.role, null),
    );
  const previous = useRef<Order[] | null>(null),
    lock = useRef(false),
    pendingRef = useRef(pending),
    sound = useSound();
  pendingRef.current = pending;
  const call = async (path: string, b?: unknown) => {
    try {
      return await api(path, b, auth.token);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) invalid();
      throw e;
    }
  };
  const live = useLive(
    () => call("state"),
    (s: State) => {
      const old = previous.current;
      if (old) {
        const arrivals = s.orders.filter(
          (o) =>
            o.status === "waiting" &&
            !old.some((p) => p.id === o.id && p.status !== "unpaid"),
        );
        const ready = s.orders.filter(
          (o) =>
            o.status === "ready" &&
            old.some((p) => p.id === o.id && p.status !== "ready"),
        );
        const changes = s.orders.filter(
          (o) =>
            o.pending &&
            !old.some((p) => p.id === o.id && p.version === o.version),
        );
        if (
          (view === "kitchen" && (arrivals.length || changes.length)) ||
          (view !== "kitchen" && ready.length)
        ) {
          sound.beep();
          setNotice(
            ready.length
              ? "調理完了：" + ready.map((o) => "#" + o.number).join("、")
              : "新規注文または訂正を確認してください",
          );
        }
      }
      previous.current = s.orders;
      setState((old) => ({
        ...s,
        catalog:
          JSON.stringify(old.catalog) === JSON.stringify(s.catalog)
            ? old.catalog
            : s.catalog,
      }));
    },
    auth.token,
  );
  const blocked = busy || !!pending || !live.online;
  async function execute(action?: string, body?: any) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      let command = pendingRef.current;
      if (!command) {
        command = { action: action!, body: { ...body, requestId: random() } };
        localStorage.setItem(
          "pos-command-" + auth.role,
          JSON.stringify(command),
        );
        pendingRef.current = command;
        setPending(command);
      }
      const r = await call("action/" + command.action, command.body);
      localStorage.removeItem("pos-command-" + auth.role);
      pendingRef.current = null;
      setPending(null);
      setSelected(null);
      setEdit(null);
      setNotice(
        command.action === "pay"
          ? `#${r.number} 入金確認済み ／ お釣り ${yen(command.body.received - r.total)}`
          : "操作を保存しました",
      );
      live.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function resolve() {
    if (lock.current || !pending) return;
    lock.current = true;
    setBusy(true);
    try {
      const r = await call("request/" + pending.body.requestId, {});
      setNotice(
        r.found
          ? "操作は保存済みです"
          : "未処理の送信を無効にしました。内容を確認して操作し直してください",
      );
      localStorage.removeItem("pos-command-" + auth.role);
      pendingRef.current = null;
      setPending(null);
      setError("");
      setSelected(null);
      setEdit(null);
      live.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  const chosen = state.orders.find((o) => o.id === selected);
  const orders = state.orders
    .filter(
      (o) =>
        view !== "kitchen" ||
        (o.paidAt !== null && o.status !== "unpaid" && o.status !== "expired"),
    )
    .filter(
      (o) =>
        history ||
        o.pending ||
        !["handed", "cancelled", "expired"].includes(o.status),
    )
    .sort(
      (a, b) =>
        (view === "register"
          ? Number(b.status === "unpaid") - Number(a.status === "unpaid")
          : 0) ||
        a.day.localeCompare(b.day) ||
        a.number - b.number,
    );
  return (
    <>
      <header>
        <b className="brand">JK-Cafe</b>
        <nav>
          {(auth.role === "admin"
            ? ["register", "kitchen", "admin"]
            : [auth.role]
          ).map((v) => (
            <button
              className={view === v ? "active" : ""}
              key={v}
              onClick={() => setView(v)}
            >
              {{ register: "会計", kitchen: "調理", admin: "管理" }[v]}
            </button>
          ))}
        </nav>
        <span>{live.online ? "● 接続中" : "通信切断"}</span>
        {sound.button}
        {auth.role !== "admin" && <a href="/admin">管理</a>}
        <button
          disabled={busy || !!pending}
          onClick={async () => {
            if (
              auth.role !== "admin" &&
              !window.confirm(
                "端末登録を解除しますか？ 次回は登録コードが必要です。",
              )
            )
              return;
            try {
              await call("logout", {});
              invalid();
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          {auth.role === "admin" ? "管理画面をロック" : "この端末の登録を解除"}
        </button>
      </header>
      <Connection online={live.online} />
      {(error || live.error) && (
        <div className="alert error" role="alert">
          {error || live.error}
          <button onClick={() => setError("")}>閉じる</button>
        </div>
      )}
      {notice && (
        <div className="alert success" role="status">
          {notice}
          <button onClick={() => setNotice("")}>閉じる</button>
        </div>
      )}
      {pending && (
        <div className="warning">
          <b>操作結果が未確認です。重ねて操作しないでください。</b>
          <div className="actions">
            <button disabled={busy || !live.online} onClick={() => execute()}>
              同じ送信IDで再送
            </button>
            <button disabled={busy || !live.online} onClick={resolve}>
              結果を確認して戻る
            </button>
          </div>
        </div>
      )}
      <main
        className={view === "kitchen" ? "kitchen-workspace" : "staff-workspace"}
      >
        <div className="section-heading">
          <h1>
            {{ register: "スタッフ会計", kitchen: "調理", admin: "管理" }[view]}
          </h1>
          <span>{state.today}</span>
        </div>
        {edit ? (
          <Correction
            key={edit.id}
            order={edit}
            catalog={state.catalog}
            blocked={blocked}
            save={(b) => execute("correct", b)}
            close={() => setEdit(null)}
          />
        ) : view === "admin" ? (
          <Admin
            state={state}
            call={call}
            blocked={blocked}
            execute={execute}
            onError={setError}
          />
        ) : (
          <>
            <label className="check">
              <input
                type="checkbox"
                checked={history}
                onChange={(e) => setHistory(e.target.checked)}
              />
              完了・キャンセル・過去の注文を表示
            </label>
            <div className="order-grid">
              {orders.map((o) => (
                <article className={"order " + o.status} key={o.id}>
                  <div className="row">
                    <b className="number">
                      #{String(o.number).padStart(3, "0")}
                    </b>
                    <span className="badge">{labels[o.status]}</span>
                  </div>
                  <div className="order-meta">
                    <strong>
                      {o.items.reduce((s, l) => s + l.quantity, 0)}皿
                    </strong>
                    <small>{o.day}</small>
                  </div>
                  {o.pending && (
                    <div className="warning">
                      <b>
                        {o.pending.kind === "cancel"
                          ? "キャンセル：調理を止めてください"
                          : "訂正確認が必要です"}
                      </b>
                      <p>{o.pending.reason}</p>
                      <small>変更前</small>
                      <Details items={o.pending.previous} />
                    </div>
                  )}
                  <Details items={o.items} />
                  {view !== "kitchen" && (
                    <>
                      <strong>{yen(o.total)}</strong>
                      {o.coupon && <p>クーポン −{yen(o.discount || 0)}</p>}
                      {o.status === "unpaid" && (
                        <p>
                          有効期限{" "}
                          {new Date(o.expiresAt).toLocaleTimeString("ja-JP")}
                        </p>
                      )}
                    </>
                  )}
                  <div className="actions">
                    {view === "kitchen" ? (
                      o.pending ? (
                        <button
                          className="primary"
                          disabled={blocked}
                          onClick={() =>
                            execute("ack", { id: o.id, version: o.version })
                          }
                        >
                          変更内容を確認しました
                        </button>
                      ) : (
                        ["waiting", "cooking"].includes(o.status) && (
                          <button
                            className="primary"
                            disabled={blocked}
                            onClick={() =>
                              execute("status", {
                                id: o.id,
                                version: o.version,
                                status:
                                  o.status === "waiting" ? "cooking" : "ready",
                              })
                            }
                          >
                            {o.status === "waiting" ? "調理開始" : "調理完了"}
                          </button>
                        )
                      )
                    ) : (
                      <>
                        <button
                          className={o.status === "unpaid" ? "primary" : ""}
                          disabled={blocked}
                          onClick={() => setSelected(o.id)}
                        >
                          {o.status === "unpaid"
                            ? "会計する"
                            : "詳細・訂正・返金"}
                        </button>
                        {o.status === "ready" && !o.pending && (
                          <button
                            disabled={blocked}
                            onClick={() =>
                              execute("status", {
                                id: o.id,
                                version: o.version,
                                status: "handed",
                              })
                            }
                          >
                            受け渡し済み
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </article>
              ))}
            </div>
            {!orders.length && <p className="empty">対象の注文はありません</p>}
          </>
        )}
      </main>
      {chosen && !edit && (
        <div className="modal-backdrop">
          <section className="panel modal">
            <h2>
              受付 #{chosen.number} ／ {labels[chosen.status]}
            </h2>
            {chosen.status === "unpaid" ? (
              <details className="payment-order-details">
                <summary>
                  注文内容を確認（
                  {chosen.items.reduce((n, l) => n + l.quantity, 0)}皿）
                </summary>
                <Details items={chosen.items} />
              </details>
            ) : (
              <Details items={chosen.items} />
            )}
            <Totals
              q={{
                ...chosen,
                subtotal: chosen.subtotal ?? chosen.total,
                discount: chosen.discount || 0,
              }}
            />
            {chosen.status === "unpaid" && (
              <Payment
                key={chosen.id + "-" + chosen.version}
                order={chosen}
                blocked={blocked}
                execute={execute}
              />
            )}
            {chosen.status !== "unpaid" && (
              <p>
                返金済額 {yen(chosen.refunded || 0)} ／ 返金可能額{" "}
                {yen(chosen.total - (chosen.refunded || 0))}
              </p>
            )}
            <div className="actions">
              <button
                disabled={
                  blocked ||
                  !!chosen.pending ||
                  !!chosen.refunded ||
                  ["handed", "cancelled", "expired"].includes(chosen.status)
                }
                onClick={() => {
                  setEdit(chosen);
                  setSelected(null);
                }}
              >
                内容を訂正
              </button>
              <button
                disabled={
                  blocked || ["cancelled", "expired"].includes(chosen.status)
                }
                onClick={() => {
                  const reason = prompt("キャンセル理由");
                  if (!reason) return;
                  const unpaid = chosen.status === "unpaid";
                  if (
                    !window.confirm(
                      unpaid
                        ? "この未払い注文をキャンセルしますか？"
                        : `${yen(chosen.total - chosen.refunded)} の返金を済ませましたか？`,
                    )
                  )
                    return;
                  const restore =
                    unpaid ||
                    window.confirm(
                      "材料を在庫に戻しますか？ 使用済みなら「キャンセル」を選択",
                    );
                  execute("cancel", {
                    id: chosen.id,
                    version: chosen.version,
                    reason,
                    restore,
                    settlementConfirmed: true,
                  });
                }}
              >
                {chosen.status === "unpaid"
                  ? "未払い注文をキャンセル"
                  : "全取消・残額返金"}
              </button>
              {chosen.status !== "unpaid" && (
                <button
                  disabled={
                    blocked ||
                    ["cancelled", "expired"].includes(chosen.status) ||
                    chosen.total <= chosen.refunded
                  }
                  onClick={() => {
                    const amount = Number(
                      prompt("返金額（在庫・数量は変わりません）"),
                    );
                    if (!amount) return;
                    const reason = prompt("返金理由");
                    if (
                      reason &&
                      window.confirm(yen(amount) + " を返金しましたか？")
                    )
                      execute("refund", {
                        id: chosen.id,
                        version: chosen.version,
                        amount,
                        reason,
                        settlementConfirmed: true,
                      });
                  }}
                >
                  金額指定返金
                </button>
              )}
              <button onClick={() => setSelected(null)}>閉じる</button>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
function Payment({
  order: o,
  blocked,
  execute,
}: {
  order: Order;
  blocked: boolean;
  execute: (a: string, b: any) => void;
}) {
  const [received, setReceived] = useState(""),
    [confirmed, setConfirmed] = useState(false);
  return (
    <div className="payment-console">
      <label>
        お預かり金額（現金）
        <input
          type="text"
          inputMode="numeric"
          autoComplete="off"
          placeholder="0"
          maxLength={7}
          value={received}
          onChange={(e) => {
            if (/^\d{0,7}$/.test(e.target.value)) setReceived(e.target.value);
          }}
          disabled={blocked}
        />
      </label>
      <div className="cash-presets" aria-label="お預かり金額の候補">
        {[o.total, 500, 1000, 5000, 10000].map((amount, i) => (
          <button
            key={i}
            disabled={blocked}
            onClick={() => setReceived(String(amount))}
          >
            {i === 0 ? "ちょうど" : yen(amount)}
          </button>
        ))}
      </div>
      <div className="cash-keypad" aria-label="お預かり金額テンキー">
        {["7", "8", "9", "4", "5", "6", "1", "2", "3", "00", "0", "削除"].map(
          (key) => (
            <button
              key={key}
              disabled={blocked}
              onClick={() =>
                setReceived((value) =>
                  key === "削除"
                    ? value.slice(0, -1)
                    : (value + key).replace(/^0+(?=\d)/, "").slice(0, 7),
                )
              }
            >
              {key}
            </button>
          ),
        )}
        <button
          className="keypad-clear"
          disabled={blocked}
          onClick={() => setReceived("")}
        >
          クリア
        </button>
      </div>
      <div
        className={`change ${received && Number(received) < o.total ? "insufficient" : ""}`}
        aria-live="polite"
      >
        {received === "" ? (
          <>
            お釣り <b>—</b>
          </>
        ) : Number(received) < o.total ? (
          <>
            不足 <b>{yen(o.total - Number(received))}</b>
          </>
        ) : (
          <>
            お釣り <b>{yen(Number(received) - o.total)}</b>
          </>
        )}
      </div>
      {o.coupon && (
        <>
          <label className="check">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
              disabled={blocked}
            />
            クーポンの提示を確認しました
          </label>
          <button
            disabled={blocked}
            onClick={() => {
              if (window.confirm("クーポンを外して金額を変更しますか？"))
                execute("coupon", {
                  id: o.id,
                  version: o.version,
                  coupon: false,
                });
            }}
          >
            クーポンを使わない
          </button>
        </>
      )}
      <button
        className="primary large"
        disabled={
          blocked ||
          received === "" ||
          !Number.isInteger(Number(received)) ||
          Number(received) < o.total ||
          (o.coupon && !confirmed)
        }
        onClick={() =>
          execute("pay", {
            id: o.id,
            version: o.version,
            received: Number(received),
            expectedTotal: o.total,
            couponConfirmed: confirmed,
          })
        }
      >
        入金確認
      </button>
    </div>
  );
}
function Correction({
  order: o,
  catalog,
  blocked,
  save,
  close,
}: {
  order: Order;
  catalog: Catalog[];
  blocked: boolean;
  save: (b: any) => void;
  close: () => void;
}) {
  const [lines, setLines] = useState<Line[]>(
      o.items.map((l) => ({
        ...l,
        syrupId: l.syrupId || "",
        includedId:
          catalog.find((p) => p.id === l.productId)?.category === "special" &&
          !l.recipeVersion
            ? ""
            : l.includedId || "",
        extras: l.extras || [],
      })),
    ),
    [coupon, setCoupon] = useState(!!o.coupon),
    [q, setQ] = useState<Quote | null>(null),
    [reason, setReason] = useState("");
  return (
    <>
      <h2>受付 #{o.number} を訂正</h2>
      {o.items.some(
        (l) =>
          catalog.find((p) => p.id === l.productId)?.category === "special" &&
          !l.recipeVersion,
      ) && (
        <p>
          旧仕様のスペシャルです。訂正を確定すると新仕様になるため、無料の通常トッピングを選んでください。
        </p>
      )}
      <Editor
        catalog={catalog}
        lines={lines}
        setLines={setLines}
        coupon={coupon}
        setCoupon={setCoupon}
        disabled={blocked}
        onQuote={setQ}
      />
      {q && (
        <section className="panel">
          <Totals q={q} />
          <p>差額 {yen(q.total - o.total)}</p>
          <label>
            訂正理由
            <input value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          <button
            className="primary"
            disabled={blocked || !reason.trim()}
            onClick={() => {
              if (
                !window.confirm(
                  o.status === "unpaid"
                    ? "この内容に訂正しますか？"
                    : `差額 ${yen(q.total - o.total)} の受領／返金を確認しましたか？`,
                )
              )
                return;
              const couponConfirmed =
                !coupon ||
                o.coupon ||
                window.confirm("クーポンの提示を確認しましたか？");
              if (!couponConfirmed) return;
              const restore =
                ["waiting", "unpaid"].includes(o.status) ||
                window.confirm(
                  "減らした材料を在庫に戻しますか？ 使用済みなら「キャンセル」",
                );
              save({
                id: o.id,
                version: o.version,
                items: lines,
                coupon,
                expectedTotal: q.total,
                reason,
                restore,
                settlementConfirmed: true,
                couponConfirmed,
              });
            }}
          >
            訂正を確定
          </button>
        </section>
      )}
      <button disabled={blocked} onClick={close}>
        訂正をやめる
      </button>
    </>
  );
}
function Admin({
  state,
  call,
  blocked,
  execute,
  onError,
}: {
  state: State;
  call: (p: string, b?: unknown) => Promise<any>;
  blocked: boolean;
  execute: (a: string, b: any) => void;
  onError: (s: string) => void;
}) {
  const [date, setDate] = useState(state.today),
    [report, setReport] = useState<any>(null),
    [devices, setDevices] = useState<any[]>([]);
  useEffect(() => {
    if (!date) setDate(state.today);
  }, [state.today]);
  async function csv(kind: string) {
    try {
      const auth = JSON.parse(
        sessionStorage.getItem("pos-auth-admin") || "null",
      );
      const r = await fetch("/api/export/" + kind, {
        headers: { Authorization: "Bearer " + auth?.token },
      });
      if (!r.ok)
        throw Error("CSV取得に失敗しました。管理者PINを確認してください");
      const url = URL.createObjectURL(await r.blob()),
        a = document.createElement("a");
      a.href = url;
      a.download = "JK-Cafe-" + kind + ".csv";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      onError((e as Error).message);
    }
  }
  return (
    <>
      <section className="panel">
        <h2>売上・クーポン集計</h2>
        <div className="row">
          <input
            aria-label="集計日"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
          <button
            onClick={() =>
              call("report?day=" + date)
                .then(setReport)
                .catch((e) => onError(e.message))
            }
          >
            集計する
          </button>
        </div>
        {report && (
          <>
            <div className="metrics">
              <div>
                純売上<strong>{yen(report.sales)}</strong>
              </div>
              <div>
                経費<strong>{yen(report.expenses)}</strong>
              </div>
              <div>
                概算利益<strong>{yen(report.sales - report.expenses)}</strong>
              </div>
            </div>
            <p>
              クーポン適用 {report.couponIssued}件 ／ 取消反映後{" "}
              {report.couponUses}件 ／ 割引増減合計 {yen(report.discount)}
            </p>
            <div className="chips">
              {report.counts.map((c: any) => (
                <span key={c.id}>
                  {c.kind === "product" ? "商品" : "トッピング"}：{c.name} ×{" "}
                  {c.quantity}
                </span>
              ))}
            </div>
            <p>
              売上は入金日、訂正・返金は実施日に計上。数量は入金日基準の訂正後数量です。
            </p>
            {report.closings.map((c: any) => (
              <p key={c.id}>
                締め：理論 {yen(c.expected)} ／ 実際 {yen(c.counted)} ／ 差異{" "}
                {yen(c.difference)}
              </p>
            ))}
            <details>
              <summary>会計履歴</summary>
              {report.ledger.map((l: any) => (
                <p key={l.id}>
                  {l.at} · {l.kind} · {yen(l.amount)} · 割引増減{" "}
                  {yen(l.discount)} · {l.note}
                </p>
              ))}
            </details>
          </>
        )}
        <div className="actions">
          {["ledger", "orders", "audit"].map((k, i) => (
            <button key={k} onClick={() => csv(k)}>
              {["会計", "注文", "操作履歴"][i]} CSV
            </button>
          ))}
        </div>
      </section>
      <section className="panel">
        <h2>価格・在庫</h2>
        <p>
          在庫は未払い注文の確保分を除く「販売可能数」です。無料分も消費します。
        </p>
        {state.catalog.map((p) => (
          <CatalogForm
            key={JSON.stringify(p)}
            p={p}
            blocked={blocked}
            save={(b) => execute("catalog", b)}
          />
        ))}
      </section>
      <section className="panel">
        <h2>経費・レジ締め</h2>
        <form
          className="admin-form"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            if (window.confirm("経費を登録しますか？"))
              execute("expense", {
                amount: Number(f.get("amount")),
                method: f.get("method"),
                note: f.get("note"),
              });
          }}
        >
          <input
            aria-label="経費内容"
            name="note"
            placeholder="経費内容"
            required
          />
          <input
            aria-label="経費金額"
            name="amount"
            type="number"
            min="1"
            placeholder="金額"
            required
          />
          <select aria-label="経費支払い元" name="method">
            <option value="cash">レジの現金</option>
            <option value="external">レジ以外で支払</option>
          </select>
          <button disabled={blocked}>経費登録</button>
        </form>
        <form
          className="admin-form"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            if (window.confirm("本日の会計を締めますか？"))
              execute("close", {
                opening: Number(f.get("opening")),
                counted: Number(f.get("counted")),
              });
          }}
        >
          <input
            aria-label="開始釣り銭"
            name="opening"
            type="number"
            min="0"
            placeholder="開始釣り銭"
            required
          />
          <input
            aria-label="実際の現金"
            name="counted"
            type="number"
            min="0"
            placeholder="実際の現金"
            required
          />
          <button disabled={blocked}>レジ締め</button>
        </form>
        <button
          disabled={blocked}
          onClick={() => {
            const reason = prompt("締め解除の理由");
            if (reason) execute("reopen", { reason });
          }}
        >
          締め解除
        </button>
      </section>
      <section className="panel">
        <h2>登録端末</h2>
        <button
          onClick={() =>
            call("devices")
              .then(setDevices)
              .catch((e) => onError(e.message))
          }
        >
          端末一覧を更新
        </button>
        {devices.map((d) => (
          <div className="row" key={d.tokenHash}>
            <p>
              {d.name} ／ {d.role} ／{" "}
              {new Date(d.expires).toLocaleString("ja-JP")}
            </p>
            <button
              disabled={blocked}
              onClick={() => {
                if (window.confirm(d.name + " の認証を取り消しますか？"))
                  call("devices/revoke", { tokenHash: d.tokenHash })
                    .then(() => call("devices"))
                    .then(setDevices)
                    .catch((e) => onError(e.message));
              }}
            >
              認証を取り消す
            </button>
          </div>
        ))}
      </section>
    </>
  );
}
function CatalogForm({
  p,
  blocked,
  save,
}: {
  p: Catalog;
  blocked: boolean;
  save: (b: any) => void;
}) {
  return (
    <form
      className="catalog-form"
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        if (window.confirm(p.name + " の価格・販売可能数を更新しますか？"))
          save({
            id: p.id,
            previous: p,
            name: f.get("name"),
            price: Number(f.get("price")),
            stock: Number(f.get("stock")),
            active: f.get("active") === "on",
          });
      }}
    >
      <label>
        名称
        <input name="name" defaultValue={p.name} required />
      </label>
      <span>{p.category}</span>
      <label>
        {p.category === "syrup" ? "単価（1種込み）" : "単価"}
        <input
          name="price"
          type="number"
          min="0"
          defaultValue={p.price}
          required
        />
      </label>
      <label>
        販売可能数
        <input
          name="stock"
          type="number"
          min="0"
          defaultValue={p.stock}
          required
        />
      </label>
      <label className="check">
        <input
          name="active"
          type="checkbox"
          defaultChecked={!!p.active}
          disabled={p.category === "legacy"}
        />
        販売中
      </label>
      <button disabled={blocked}>保存</button>
    </form>
  );
}
