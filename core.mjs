/* 橋接的核心：連上 Realtime、驗簽章、分派工作。
 *
 * 抽出來讓兩種用法共用：
 *   bridge.mjs  命令列（給 mprocs / 開發用）
 *   app.mjs     視窗介面（給同事用）
 * 所有訊息都走 onLog / onState 回報，這裡面不直接 console.log。
 */
import { createClient } from "@supabase/supabase-js";
import crypto from "node:crypto";
import { fillLeave, runQuery, fillBatch, sendForm, saveDraft, sendDrafts, QUERIES, FORMS } from "./easyflow.mjs";
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
  // ⚠️ 單別（請假/加班調休）也要進簽章，否則有人能把「請假」改成「加班調休」再重送
  const verifyFill = (p) =>
    p && p.sig && p.requestId && (!p.form || FORMS[p.form]) &&
    Math.abs(Date.now() - Number(p.ts || 0)) <= 180000 &&
    safeEq(hmac([p.requestId, p.ts, p.email, p.form || "leave", p.code,
                 p.start, p.startT, p.end, p.endT, p.reason].join("|")), p.sig);

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

  // 單張填完後「確定發送／儲存草稿／取消」。動作也要簽 —— 不然有人能把「存草稿」改成「送出」。
  const verifyAct = (p) =>
    p && p.sig && p.requestId && ["send", "draft", "cancel"].includes(p.action) &&
    Math.abs(Date.now() - Number(p.ts || 0)) <= 180000 &&
    safeEq(hmac([p.requestId, p.ts, p.email, "a", p.action].join("|")), p.sig);

  // 批次的「一起送出」。草稿的識別（填表日期時間）也一起簽。
  const verifySend = (p) =>
    p && p.sig && p.requestId && Array.isArray(p.drafts) && p.drafts.length &&
    Math.abs(Date.now() - Number(p.ts || 0)) <= 180000 &&
    safeEq(hmac([p.requestId, p.ts, p.email, "s", p.drafts.join(",")].join("|")), p.sig);

  const supa = createClient(conn.supabaseUrl, conn.supabaseKey, { realtime: { params: { eventsPerSecond: 20 } } });
  const newChannel = () => supa.channel(conn.channel,
    { config: { broadcast: { self: false }, presence: { key: "bridge" } } });
  let channel = newChannel();
  const emit = (event, payload) => { try { channel.send({ type: "broadcast", event, payload }); } catch { /* 還沒連上 */ } };

  let busy = false;
  let openBrowser = null;   // 前一張填好但還沒處理掉的單，開新的之前先關掉
  let pending = null;       // 那張單的操作把手（page/outer/notes），使用者按三顆時要用
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
      log(`收到填單請求：${FORMS[req.form || "leave"].label} ${req.code || ""} `
        + `${req.start} ${req.startT}～${req.end} ${req.endT}`, "task");
      if (openBrowser) { try { await openBrowser.close(); } catch { /* ignore */ } openBrowser = null; }

      const r = await fillLeave({ cfg, req, say });
      openBrowser = r.browser;
      pending = { page: r.page, outer: r.outer, notes: r.notes };
      emit("filled", { requestId: rid, code: req.code, typeName: r.typeName, hours: r.hours, days: r.days, shot: r.shot });
      log(`${r.typeName}　時數 ${r.hours}　天數 ${r.days}`, "ok");
      finish(true, "");
    } catch (e) {
      // 「算出 0 小時」這種情況要把視窗留著，讓使用者自己改日期重算
      if (e?.keepBrowser) {
        openBrowser = e.keepBrowser;
        if (e.session) pending = e.session;      // 讓使用者改完還是可以按那三顆
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

      // 截圖等全部跑完才傳（使用者要的是最後一次看完全部，不是邊跑邊跳）。
      // 但一則一個人 —— Realtime 單則約 256KB，人數不固定，全部塞同一則一定會被丟掉。
      // 中間隔一下，免得撞到每秒事件數上限（eventsPerSecond: 20）。
      const shots = (r.shots || []).filter((x) => x && x.shot);
      if (shots.length) log(`回傳 ${shots.length} 張截圖…`);
      for (let i = 0; i < shots.length; i++) {
        emit("batchshot", { requestId: rid, i, n: shots.length, name: shots[i].name, shot: shots[i].shot });
        await new Promise((res) => setTimeout(res, 200));
      }

      const okCount = r.results.filter((x) => x.ok).length;
      emit("batchdone", { requestId: rid, form: req.form, label, results: r.results, shots: shots.length });
      log(`批次完成：${okCount}/${r.results.length} 成功，都存成草稿`, okCount ? "ok" : "err");
      finish(true, "");
    } catch (e) {
      finish(false, String(e && e.message ? e.message : e).slice(0, 250));
    }
  }

  /* 單張填完之後，使用者選了「確定發送 / 儲存草稿 / 取消」。
     🚨 send 這條是唯一會真的送出表單的路徑，而且一定是使用者按了才會走到。 */
  async function handleAct(req) {
    const rid = String(req.requestId);
    const say = (text) => { log("　" + text); emit("status", { requestId: rid, text }); };
    const done = (ok, error, result) => emit("acted", { requestId: rid, action: req.action, ok, error: error || "", result: result || "" });

    if (!pending || !openBrowser) {
      done(false, "那張表單已經不在了（瀏覽器關掉或已經處理過）");
      return;
    }
    busy = true;
    onState({ busy: true, task: req.action === "send" ? "傳送" : req.action === "draft" ? "存草稿" : "取消" });
    try {
      if (req.action === "send") {
        log("使用者選擇【確定發送】", "task");
        const msg = await sendForm({ page: pending.page, outer: pending.outer, notes: pending.notes, say });
        log("已送出簽核" + (msg ? "（" + msg + "）" : ""), "ok");
        done(true, "", msg);
      } else if (req.action === "draft") {
        log("使用者選擇【儲存草稿】", "task");
        await saveDraft({ page: pending.page, outer: pending.outer, notes: pending.notes, say });
        log("已存成草稿，沒有送出", "ok");
        done(true, "", "已存成草稿");
      } else {
        log("使用者選擇【取消】，關掉表單不儲存", "task");
        done(true, "", "已取消");
      }
      // 送出／存草稿／取消之後這張就結束了，關掉瀏覽器
      try { await openBrowser.close(); } catch { /* ignore */ }
      openBrowser = null;
      pending = null;
    } catch (e) {
      const msg = String(e && e.message ? e.message : e).slice(0, 250);
      log(msg, "err");
      done(false, msg);
    } finally {
      busy = false;
      onState({ busy: false, task: "" });
    }
  }

  /* 🚨 批次的「一起送出」：把剛才存的那幾張草稿一張一張打開、按傳送。不可逆。 */
  async function handleSendDrafts(req) {
    busy = true;
    onState({ busy: true, task: "送出草稿" });
    const rid = String(req.requestId);
    const say = (text) => { log("　" + text); emit("status", { requestId: rid, text }); };
    let finished = false;
    const finish = (ok, error) => {
      if (finished) return;
      finished = true; busy = false;
      onState({ busy: false, task: "" });
      emit("done", { requestId: rid, ok, error: error || "" });
    };
    try {
      log(`使用者選擇【全部送出】：${req.drafts.length} 張草稿`, "task");
      if (openBrowser) { try { await openBrowser.close(); } catch { /* ignore */ } openBrowser = null; pending = null; }
      const r = await sendDrafts({
        cfg, whens: req.drafts, say,
        onEach: (one) => emit("sentone", { requestId: rid, ...one }),
      });
      openBrowser = r.browser;
      const ok = r.results.filter((x) => x.ok).length;
      emit("sentdone", { requestId: rid, results: r.results });
      log(`送出完成：${ok}/${r.results.length} 張`, ok ? "ok" : "err");
      finish(true, "");
    } catch (e) {
      finish(false, String(e && e.message ? e.message : e).slice(0, 250));
    }
  }

  /* ── 斷線重連 ───────────────────────────────────────────────────────
   * 使用者下班掛著整晚，實際 log 長這樣：
   *   18:50 CHANNEL_ERROR → 18:50 已上線（2 秒後自己回來）
   *   21:06 CHANNEL_ERROR → 21:06 已上線
   *   03:10 CHANNEL_ERROR → （沒有然後了，就這樣斷著）
   * 也就是：supabase-js 大多數時候會自己重連，但**偶爾會回不來**，
   * 而且訊息還寫「檢查網路後重開」—— 網路根本沒斷，只是嚇人。
   *
   * 所以這裡自己顧一層：
   *   ① 斷線只說「重連中」，不要叫人重開
   *   ② 15 秒還沒回來就**整條頻道重建**（removeChannel + 重新 subscribe）
   *   ③ 每 60 秒巡一次，狀態不是 joined 就重建（睡眠喚醒、網路換手都靠這個）
   *   ④ 退避：5s → 10s → 20s → 30s → 60s 封頂，然後一直試下去，不放棄
   */
  let online = false;
  let attempts = 0;
  let retryTimer = null;
  let downSince = 0;

  const clearRetry = () => { if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; } };

  function scheduleRetry() {
    if (stopped || retryTimer) return;
    const wait = [5000, 10000, 20000, 30000][Math.min(attempts, 3)] || 60000;
    attempts += 1;
    retryTimer = setTimeout(() => { retryTimer = null; rebuild(); }, wait);
  }

  /* 整條頻道砍掉重練。⚠️ 一定要 removeChannel 舊的，
     否則同一個 client 上會留著一條殭屍頻道，事件會被處理兩次。 */
  function rebuild() {
    if (stopped) return;
    try { supa.removeChannel(channel); } catch { /* 本來就壞了 */ }
    try { supa.realtime?.connect?.(); } catch { /* 有些版本沒有這個方法 */ }
    channel = newChannel();
    wire();
  }

  function onDown(why) {
    if (stopped || !online && downSince) { scheduleRetry(); return; }
    online = false;
    downSince = downSince || Date.now();
    onState({ status: "offline" });
    const mins = Math.floor((Date.now() - downSince) / 60000);
    // 只有真的一直連不上才講重話 —— 平常那 2 秒的閃斷不該嚇人
    log(mins >= 2 ? `已經 ${mins} 分鐘連不上即時通道（${why}），還在重試。網路正常的話通常會自己回來。`
                  : `連線中斷（${why}），重連中…`, mins >= 2 ? "err" : "warn");
    scheduleRetry();
  }

  /* 把所有事件掛上去並訂閱。重連時會整個再跑一次。 */
  function wire() {
  channel
    .on("broadcast", { event: "a" }, ({ payload }) => {
      if (!verifyAct(payload)) { log("收到簽章無效的操作請求，已忽略", "warn"); return; }
      if (busy) { emit("acted", { requestId: payload.requestId, action: payload.action, ok: false, error: "正在處理上一個請求，請稍候" }); return; }
      handleAct(payload);
    })
    .on("broadcast", { event: "s" }, ({ payload }) => {
      if (!verifySend(payload)) { log("收到簽章無效的送出請求，已忽略", "warn"); return; }
      if (busy) { emit("done", { requestId: payload.requestId, ok: false, error: "正在處理上一個請求，請稍候" }); return; }
      handleSendDrafts(payload);
    })
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
    .subscribe((st) => {
      if (stopped) return;
      if (st === "SUBSCRIBED") {
        channel.track({ role: "bridge", at: Date.now(), pid: process.pid });
        clearRetry();
        attempts = 0;
        const wasDown = downSince;
        downSince = 0;
        onState({ status: "online" });
        // 斷過才報「回來了」，第一次上線用原本那句
        log(wasDown ? "連線回來了，已上線" : "已上線，可以回網站找 Woby 講話了", "ok");
        online = true;
      } else if (st === "CHANNEL_ERROR" || st === "TIMED_OUT" || st === "CLOSED") {
        onDown(st);
      }
    });
  }

  wire();

  /* 巡邏：每分鐘看一次頻道到底是不是還活著。
     ⚠️ 這條是給「沒有觸發任何事件就默默死掉」的情況用的 —— 筆電睡醒、
     Wi-Fi 換手常常這樣，supabase-js 不一定會回報錯誤，狀態就一直卡在非 joined。 */
  setInterval(() => {
    if (stopped || busy) return;                 // 正在填單就別動連線
    const st = String(channel?.state || "");
    if (st === "joined") return;
    if (!retryTimer) {
      log(`偵測到頻道狀態是「${st || "unknown"}」，重新連線…`, "warn");
      onDown("watchdog");
    }
  }, 60000).unref();

  return {
    email: conn.email,
    stop: async () => {
      stopped = true;
      clearRetry();
      if (openBrowser) { try { await openBrowser.close(); } catch { /* ignore */ } }
      try { supa.removeChannel(channel); } catch { /* ignore */ }
    },
    // 手動重連（視窗上的按鈕、或測試用）
    reconnect: () => { clearRetry(); attempts = 0; rebuild(); },
  };
}
