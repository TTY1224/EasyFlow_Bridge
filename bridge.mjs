#!/usr/bin/env node
/* EasyFlow 橋接 —— 跑在「你自己的電腦」上。
 *
 * 它做什麼：
 *   網站上的 Woby 幫你把「要填什麼」整理好、簽章，經 Supabase Realtime 送到這裡；
 *   這支程式用你自己電腦上的帳密登入 EasyFlow，把單填好，**停下來等你檢查**。
 *
 * ⚠️ 永遠不會替你按「存檔 / 暫存 / 送簽」。送出與否一律由人決定。
 *
 * 你的公司密碼只存在這台電腦（Windows DPAPI 加密），伺服器永遠看不到。
 */
import { createClient } from "@supabase/supabase-js";
import crypto from "node:crypto";
import * as cfgStore from "./config.mjs";
import { fillLeave, runQuery, QUERIES } from "./easyflow.mjs";

const log = (s) => console.log(s);
const die = (s) => { console.error("\n✗ " + s + "\n"); process.exit(1); };

if (!cfgStore.exists()) {
  die("還沒設定過。請先執行「首次設定.bat」（或 node setup.mjs）。");
}

let cfg;
try {
  cfg = cfgStore.load();
} catch (e) {
  die("設定讀不出來：" + (e?.message || e) +
      "\n  如果你換了電腦或換了 Windows 帳號，密碼就解不開了（這是刻意的）。" +
      "\n  請重新執行「首次設定.bat」。");
}

// 向網站換取要連的頻道與 Realtime 金鑰。順便驗證授權碼對不對。
let conn;
try {
  const r = await fetch(cfg.appUrl.replace(/\/+$/, "") + "/api/leave/bridge-config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: cfg.email, token: cfg.token }),
  });
  conn = await r.json();
  if (!conn.ok) die("網站不接受這組設定：" + (conn.error || `HTTP ${r.status}`) +
                    "\n  授權碼可以在網站上重新取得，然後重跑「首次設定.bat」。");
} catch (e) {
  die("連不到網站（" + cfg.appUrl + "）：" + (e?.message || e));
}

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

const supa = createClient(conn.supabaseUrl, conn.supabaseKey, { realtime: { params: { eventsPerSecond: 20 } } });
const channel = supa.channel(conn.channel, { config: { broadcast: { self: false }, presence: { key: "bridge" } } });
const emit = (event, payload) => { try { channel.send({ type: "broadcast", event, payload }); } catch { /* 還沒連上 */ } };

let busy = false;
let openBrowser = null;   // 前一張填好但還沒送出的單，開新的之前先關掉

async function handleFill(req) {
  busy = true;
  const rid = String(req.requestId);
  const tag = rid.slice(0, 8);
  const say = (text) => { log("   " + text); emit("status", { requestId: rid, text }); };
  let done = false;
  const finish = (ok, error) => {
    if (done) return;
    done = true; busy = false;
    emit("done", { requestId: rid, ok, error: error || "" });
    log("■ [" + tag + "] " + (ok ? "已填好，等你確認送出" : "失敗：" + error));
  };

  try {
    log(`▶ [${tag}] 填單 ${req.code} ${req.start} ${req.startT}～${req.end} ${req.endT}`);
    if (openBrowser) { try { await openBrowser.close(); } catch { /* ignore */ } openBrowser = null; }

    const r = await fillLeave({ cfg, req, say });
    openBrowser = r.browser;
    emit("filled", { requestId: rid, code: req.code, typeName: r.typeName, hours: r.hours, days: r.days, shot: r.shot });
    log(`   ✓ ${r.typeName}　時數 ${r.hours}　天數 ${r.days}`);
    log("   ⚠ 瀏覽器留著不關 —— 請自己檢查後按「送簽」。這支程式不會幫你送出。");
    finish(true, "");
  } catch (e) {
    // 「算出 0 小時」這種情況要把視窗留著，讓使用者自己改日期重算
    if (e?.keepBrowser) {
      openBrowser = e.keepBrowser;
      log("   ⚠ 視窗留著，你可以直接改日期再按「計算」");
    }
    finish(false, String(e?.message || e).slice(0, 250));
  }
}

async function handleQuery(req) {
  busy = true;
  const rid = String(req.requestId);
  const kind = String(req.kind);
  const say = (text) => { log("   " + text); emit("status", { requestId: rid, text }); };
  let done = false;
  const finish = (ok, error) => {
    if (done) return;
    done = true; busy = false;
    emit("done", { requestId: rid, ok, error: error || "" });
    if (!ok) log("■ 查詢失敗：" + error);
  };

  try {
    log(`▶ 查詢「${QUERIES[kind].label}」`);
    // 有一張填好還沒送出的單開著時不能查：同一個帳號再登入一次會把那張單的
    // session 踢掉，使用者確認到一半的單就白費了。寧可叫他先處理完。
    if (openBrowser) {
      throw new Error("你有一張填好還沒送出的假單開著。先送出或關掉那個視窗，再查一次（同時登入兩次會把那張單踢掉）");
    }
    const r = await runQuery({ cfg, kind, say });
    emit("qres", { requestId: rid, kind, label: r.label, cols: r.cols, rows: r.rows });
    log(`   ✓ ${r.label}：${r.rows.length} 筆`);
    finish(true, "");
  } catch (e) {
    finish(false, String(e?.message || e).slice(0, 250));
  }
}

channel
  .on("broadcast", { event: "req" }, ({ payload }) => {
    if (!verifyFill(payload)) { console.warn("✗ 收到無效簽章的填單請求，已忽略"); return; }
    if (busy) { emit("done", { requestId: payload.requestId, ok: false, error: "正在處理上一個請求，請稍候" }); return; }
    handleFill(payload);
  })
  .on("broadcast", { event: "q" }, ({ payload }) => {
    if (!verifyQuery(payload)) { console.warn("✗ 收到無效簽章的查詢請求，已忽略"); return; }
    if (busy) { emit("done", { requestId: payload.requestId, ok: false, error: "正在處理上一個請求，請稍候" }); return; }
    handleQuery(payload);
  })
  .on("presence", { event: "sync" }, () => {
    // 同一個頻道上有兩支橋在跑，會用同一組帳號搶登入而失敗（實際踩過）。
    // 每個人的頻道是各自獨立的，所以這裡只會抓到「自己重複開了兩次」。
    const st = channel.presenceState();
    let others = 0;
    for (const k in st) for (const m of st[k] || []) if (m.role === "bridge" && m.pid !== process.pid) others++;
    if (others > 0 && !globalThis.__warnedDup) {
      globalThis.__warnedDup = true;
      console.error("\n✗ 這支橋接已經在另一個視窗跑了。");
      console.error("  兩個一起跑會搶同一組 EasyFlow 帳號登入而失敗 —— 這一支自動結束。");
      console.error("  留一個就好。\n");
      try { supa.removeChannel(channel); } catch { /* ignore */ }
      process.exit(1);
    }
  })
  .subscribe((s) => {
    if (s === "SUBSCRIBED") {
      channel.track({ role: "bridge", at: Date.now(), pid: process.pid });
      log("");
      log("  ✓ EasyFlow 橋接已上線");
      log("  使用者：" + cfg.email + "　｜　EasyFlow 帳號：" + cfg.easyflowUser);
      log("  瀏覽器：" + (cfg.browser || "msedge"));
      log("");
      log("  ⚠ 只會「把單填好」，永遠不會替你按送出");
      log("  可查詢：可休時數 / 請假記錄 / 刷卡記錄（唯讀）");
      log("");
      log("  現在回網站上找 Woby 講話就可以了。這個視窗要留著開。");
      log("  （關掉這個視窗就等於下線，按 Ctrl+C 也是）");
      log("");
    } else if (s === "CHANNEL_ERROR" || s === "TIMED_OUT") {
      console.error("✗ 連不上 Realtime（" + s + "）。檢查網路後重開這支程式。");
    }
  });

process.on("SIGINT", () => { try { supa.removeChannel(channel); } catch { /* ignore */ } process.exit(0); });
