/* 橋接的核心：連上 Realtime、驗簽章、分派工作。
 *
 * 抽出來讓兩種用法共用：
 *   bridge.mjs  命令列（給 mprocs / 開發用）
 *   app.mjs     視窗介面（給同事用）
 * 所有訊息都走 onLog / onState 回報，這裡面不直接 console.log。
 */
import { createClient } from "@supabase/supabase-js";
import crypto from "node:crypto";
import { fillLeave, runQuery, fillBatch, QUERIES, FORMS } from "./easyflow.mjs";
import { checkToken } from "./verify.mjs";

export async function startBridge({ cfg, onLog = () => {}, onState = () => {} }) {
  const log = (text, kind = "info") => onLog({ text, kind, at: Date.now() });

  onState({ status: "connecting" });
  const conn = await checkToken(cfg);      // 順便驗授權碼，錯了就不用往下走

  const hmac = (d) => crypto.createHmac("sha256", cfg.token).update(d).digest("hex");
  const safeEq = (a, b) => {
    try {
      const x = Buffer.from(String(a)), y = Buffer.from(String(b));
      return x.length === y.length && crypto.timingSafeEqual(x, y);
    } catch { return false; }
  };

  // 只認「用我的授權碼簽過」的請求。簽章涵蓋所有會被填進表單的欄位，
  // 所以別人拿到一張舊簽章也沒辦法改成別的日期或假別再重送。
  const verifyFill = (p) =>
    p && p.sig && p.requestId &&
    Math.abs(Date.now() - Number(p.ts || 0)) <= 180000 &&
    safeEq(hmac([p.requestId, p.ts, p.email, p.code, p.start, p.startT, p.end, p.endT, p.reason].join("|")), p.sig);

  // 查詢的簽章夾一個 "q" 當領域標記，所以填單簽章不可能被拿去當查詢用（反之亦然）
  const verifyQuery = (p) =>
    p && p.sig && p.requestId && QUERIES[p.kind] &&
    Math.abs(Date.now() - Number(p.ts || 0)) <= 180000 &&
    safeEq(hmac([p.requestId, p.ts, p.email, "q", p.kind].join("|")), p.sig);

  // 批次的簽章夾一個 "b" 當領域標記，人名也一起簽 ——
  // 所以拿到一張批次簽章也沒辦法改成幫別人上單。
  const verifyBatch = (p) =>
    p && p.sig && p.requestId && FORMS[p.form] && Array.isArray(p.people) && p.people.length &&
    Math.abs(Date.now() - Number(p.ts || 0)) <= 180000 &&
    safeEq(hmac([p.requestId, p.ts, p.email, "b", p.form, p.people.join(","),
                 p.code, p.start, p.startT, p.end, p.endT, p.reason].join("|")), p.sig);

  const supa = createClient(conn.supabaseUrl, conn.supabaseKey, { realtime: { params: { eventsPerSecond: 20 } } });
  const channel = supa.channel(conn.channel, { config: { broadcast: { self: false }, presence: { key: "bridge" } } });
  const emit = (event, payload) => { try { channel.send({ type: "broadcast", event, payload }); } catch { /* 還沒連上 */ } };

  let busy = false;
  let openBrowser = null;   // 前一張填好但還沒送出的單，開新的之前先關掉
  let stopped = false;

  async function handleFill(req) {
    busy = true;
    onState({ busy: true, task: "填假單" });
    const rid = String(req.requestId);
    const say = (text) => { log("　" + text); emit("status", { requestId: rid, text }); };
    let done = false;
    const finish = (ok, error) => {
      if (done) return;
      done = true; busy = false;
      onState({ busy: false, task: "" });
      emit("done", { requestId: rid, ok, error: error || "" });
      log(ok ? "已填好，等你到瀏覽器確認後按送簽" : "失敗：" + error, ok ? "ok" : "err");
    };

    try {
      log(`收到填單請求：${req.code} ${req.start} ${req.startT}～${req.end} ${req.endT}`, "task");
      if (openBrowser) { try { await openBrowser.close(); } catch { /* ignore */ } openBrowser = null; }

      const r = await fillLeave({ cfg, req, say });
      openBrowser = r.browser;
      emit("filled", { requestId: rid, code: req.code, typeName: r.typeName, hours: r.hours, days: r.days, shot: r.shot });
      log(`${r.typeName}　時數 ${r.hours}　天數 ${r.days}`, "ok");
      finish(true, "");
    } catch (e) {
      // 「算出 0 小時」這種情況要把視窗留著，讓使用者自己改日期重算
      if (e?.keepBrowser) {
        openBrowser = e.keepBrowser;
        log("瀏覽器視窗留著，你可以直接改日期再按「計算」", "warn");
      }
      finish(false, String(e?.message || e).slice(0, 250));
    }
  }

  async function handleQuery(req) {
    busy = true;
    const kind = String(req.kind);
    onState({ busy: true, task: "查" + QUERIES[kind].label });
    const rid = String(req.requestId);
    const say = (text) => { log("　" + text); emit("status", { requestId: rid, text }); };
    let done = false;
    const finish = (ok, error) => {
      if (done) return;
      done = true; busy = false;
      onState({ busy: false, task: "" });
      emit("done", { requestId: rid, ok, error: error || "" });
      if (!ok) log("查詢失敗：" + error, "err");
    };

    try {
      log(`收到查詢請求：${QUERIES[kind].label}`, "task");
      // 有一張填好還沒送出的單開著時不能查：同一個帳號再登入一次會把那張單的
      // session 踢掉，使用者確認到一半的單就白費了。寧可叫他先處理完。
      if (openBrowser) {
        throw new Error("你有一張填好還沒送出的假單開著。先送出或關掉那個視窗，再查一次（同時登入兩次會把那張單踢掉）");
      }
      const r = await runQuery({ cfg, kind, say });
      emit("qres", { requestId: rid, kind, label: r.label, cols: r.cols, rows: r.rows });
      log(`${r.label}：${r.rows.length} 筆`, "ok");
      finish(true, "");
    } catch (e) {
      finish(false, String(e?.message || e).slice(0, 250));
    }
  }

  /* 批次代填：一次幫多位同事上同一種單。
     每個人都是「重開空白單 → 選人 → 填 → 計算 → 草稿儲存」，
     ⚠️ 只按草稿儲存，永遠不按傳送。 */
  async function handleBatch(req) {
    busy = true;
    const label = FORMS[req.form].label;
    onState({ busy: true, task: `批次${label}` });
    const rid = String(req.requestId);
    const say = (text) => { log("　" + text); emit("status", { requestId: rid, text }); };
    let done = false;
    const finish = (ok, error) => {
      if (done) return;
      done = true; busy = false;
      onState({ busy: false, task: "" });
      emit("done", { requestId: rid, ok, error: error || "" });
      if (!ok) log("批次失敗：" + error, "err");
    };

    try {
      log(`收到批次請求：${label} × ${req.people.length} 人（${req.people.join("、")}）`, "task");
      // 有一張填好還沒送出的單開著時不能跑批次：同一個帳號再登入會把那張單踢掉
      if (openBrowser) {
        throw new Error("你有一張填好還沒送出的單開著。先處理完再跑批次（同時登入兩次會把那張單踢掉）");
      }

      const r = await fillBatch({
        cfg, req, say,
        // 每填完一個人就即時回報，讓聊天室看得到進度
        onEach: (one) => emit("batchone", { requestId: rid, ...one }),
      });
      openBrowser = r.browser;      // 瀏覽器留著，讓使用者自己檢查草稿

      const okCount = r.results.filter((x) => x.ok).length;
      emit("batchdone", { requestId: rid, form: req.form, label, results: r.results });
      log(`批次完成：${okCount}/${r.results.length} 成功，都存成草稿`, okCount ? "ok" : "err");
      finish(true, "");
    } catch (e) {
      finish(false, String(e && e.message ? e.message : e).slice(0, 250));
    }
  }

  channel
    .on("broadcast", { event: "b" }, ({ payload }) => {
      if (!verifyBatch(payload)) { log("收到簽章無效的批次請求，已忽略", "warn"); return; }
      if (busy) { emit("done", { requestId: payload.requestId, ok: false, error: "正在處理上一個請求，請稍候" }); return; }
      handleBatch(payload);
    })
    .on("broadcast", { event: "req" }, ({ payload }) => {
      if (!verifyFill(payload)) { log("收到簽章無效的填單請求，已忽略", "warn"); return; }
      if (busy) { emit("done", { requestId: payload.requestId, ok: false, error: "正在處理上一個請求，請稍候" }); return; }
      handleFill(payload);
    })
    .on("broadcast", { event: "q" }, ({ payload }) => {
      if (!verifyQuery(payload)) { log("收到簽章無效的查詢請求，已忽略", "warn"); return; }
      if (busy) { emit("done", { requestId: payload.requestId, ok: false, error: "正在處理上一個請求，請稍候" }); return; }
      handleQuery(payload);
    })
    .on("presence", { event: "sync" }, () => {
      // 同一個帳號的橋開兩份，會搶同一組 EasyFlow 登入而兩邊都失敗（實際踩過）。
      // 每個人的頻道各自獨立，所以這裡抓到的一定是「自己開了兩次」。
      const st = channel.presenceState();
      let others = 0;
      for (const k in st) for (const m of st[k] || []) if (m.role === "bridge" && m.pid !== process.pid) others++;
      if (others > 0 && !stopped) {
        stopped = true;
        onState({ status: "duplicate" });
        log("偵測到你的橋接已經在別的地方跑著了（另一個視窗，或命令列版）。兩份一起跑會搶同一組 EasyFlow 登入而兩邊都失敗，所以這一份先停下來。把多的那個關掉就好。", "err");
        try { supa.removeChannel(channel); } catch { /* ignore */ }
      }
    })
    .subscribe((s) => {
      if (stopped) return;
      if (s === "SUBSCRIBED") {
        channel.track({ role: "bridge", at: Date.now(), pid: process.pid });
        onState({ status: "online" });
        log("已上線，可以回網站找 Woby 講話了", "ok");
      } else if (s === "CHANNEL_ERROR" || s === "TIMED_OUT") {
        onState({ status: "offline" });
        log("連不上即時通道（" + s + "）。檢查網路後重開。", "err");
      }
    });

  return {
    email: conn.email,
    stop: async () => {
      stopped = true;
      if (openBrowser) { try { await openBrowser.close(); } catch { /* ignore */ } }
      try { supa.removeChannel(channel); } catch { /* ignore */ }
    },
  };
}
