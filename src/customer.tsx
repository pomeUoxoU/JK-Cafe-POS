import { OrderWizard } from "./order-wizard";
import { useEffect, useRef, useState } from "react";
import {
  api,
  Catalog,
  Connection,
  Details,
  Line,
  Order,
  Quote,
  random,
  read,
  useLive,
  labels,
  yen,
} from "./shared";
export function Customer() {
  const [catalog, setCatalog] = useState<Catalog[]>([]),
    [lines, setLines] = useState<Line[]>(() => read("self-draft", [])),
    [coupon, setCoupon] = useState(() => read("self-coupon", false)),
    [q, setQ] = useState<Quote | null>(null),
    [receipt, setReceipt] = useState<string | null>(() =>
      read("self-receipt", null),
    ),
    [order, setOrder] = useState<Order | null>(null),
    [pending, setPending] = useState<any>(() => read("self-pending", null)),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const lock = useRef(false),
    command = useRef(pending);
  command.current = pending;
  const live = useLive(
    async () => ({
      menu: await api("public/menu"),
      order: receipt
        ? await api("public/track", { customerToken: receipt })
        : null,
    }),
    (data) => {
      setCatalog((old) =>
        JSON.stringify(old) === JSON.stringify(data.menu.catalog)
          ? old
          : data.menu.catalog,
      );
      setOrder(data.order);
    },
    undefined,
    receipt || undefined,
  );
  useEffect(() => {
    localStorage.setItem("self-draft", JSON.stringify(lines));
  }, [lines]);
  useEffect(() => {
    localStorage.setItem("self-coupon", JSON.stringify(coupon));
  }, [coupon]);
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "auto" });
  }, [receipt]);
  function reset() {
    localStorage.removeItem("self-receipt");
    setReceipt(null);
    setOrder(null);
    setLines([]);
    setCoupon(false);
    setQ(null);
    setError("");
  }
  useEffect(() => {
    if (!order?.paid) return;
    const timer = setTimeout(reset, 8000);
    return () => clearTimeout(timer);
  }, [order?.paid]);
  async function send() {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      let b = command.current;
      if (!b) {
        if (!q) throw Error("金額の確認が必要です");
        b = {
          requestId: random(),
          customerToken: random(),
          items: lines,
          coupon,
          expectedTotal: q.total,
        };
        localStorage.setItem("self-pending", JSON.stringify(b));
        command.current = b;
        setPending(b);
      }
      const o = await api("public/submit", b);
      localStorage.setItem("self-receipt", JSON.stringify(b.customerToken));
      setReceipt(b.customerToken);
      setOrder(o);
      localStorage.removeItem("self-pending");
      command.current = null;
      setPending(null);
      setLines([]);
      setCoupon(false);
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
      const r = await api("public/resolve", {
        requestId: pending.requestId,
        customerToken: pending.customerToken,
      });
      if (r.found) {
        localStorage.setItem(
          "self-receipt",
          JSON.stringify(pending.customerToken),
        );
        setReceipt(pending.customerToken);
        setOrder(r.result);
        setLines([]);
        setCoupon(false);
      }
      localStorage.removeItem("self-pending");
      command.current = null;
      setPending(null);
      setError("");
      live.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <>
      <header>
        <b className="brand">JK-Cafe</b>
        <span>お客さん用注文画面</span>
        <span className="connection">
          {live.online ? "● 接続中" : "通信切断"}
        </span>
      </header>
      <Connection online={live.online} />
      <main className="customer">
        <h1>{receipt ? "注文受付" : "ご注文"}</h1>
        {(error || live.error) && (
          <p className="error" role="alert">
            {error || live.error}
          </p>
        )}
        {receipt ? (
          <section className="panel receipt">
            {order ? (
              <>
                <h2>
                  {order.paid ? "お支払いを確認しました" : labels[order.status]}
                </h2>
                <p>受付番号</p>
                <strong className="receipt-number">
                  {String(order.number).padStart(3, "0")}
                </strong>
                <p>{order.day}</p>
                <strong className="receipt-total">{yen(order.total)}</strong>
                {order.status === "unpaid" && (
                  <>
                    <p>この番号を会計スタッフにお伝えください。</p>
                    {order.coupon && (
                      <p>クーポンを会計スタッフに提示してください。</p>
                    )}
                    <p>
                      受付有効期限：
                      {new Date(order.expiresAt).toLocaleTimeString("ja-JP", {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </p>
                  </>
                )}
                <Details items={order.items} />
                {order.paid && <p>8秒後に次の注文画面へ戻ります。</p>}
                {(order.paid ||
                  ["expired", "cancelled"].includes(order.status)) && (
                  <button className="primary large" onClick={reset}>
                    次の注文へ
                  </button>
                )}
              </>
            ) : (
              <p>受付情報を確認しています…</p>
            )}
          </section>
        ) : (
          <>
            {pending && (
              <section className="warning" role="alert">
                <b>送信結果の確認が必要です</b>
                <p>
                  新しい注文は始めず、同じ内容で再送するか結果を確認してください。
                </p>
                <button disabled={busy || !live.online} onClick={send}>
                  同じ注文を再送
                </button>{" "}
                <button disabled={busy || !live.online} onClick={resolve}>
                  結果を確認して戻る
                </button>
              </section>
            )}
            <OrderWizard
              catalog={catalog}
              lines={lines}
              setLines={setLines}
              coupon={coupon}
              setCoupon={setCoupon}
              q={q}
              onQuote={setQ}
              disabled={busy || !!pending}
              online={live.online}
              onSend={send}
            />
          </>
        )}
      </main>
    </>
  );
}
