#!/usr/bin/env node
/* 視窗介面版（給一般使用者）。
 *
 * 沒有用 Electron —— 那要多裝 150MB。做法是：
 *   ① 在 127.0.0.1 開一個只有自己連得到的小伺服器，吐 ui.html
 *   ② 用 Edge 的 --app 模式開視窗（沒有網址欄，看起來就是一支獨立程式）
 *   ③ 給它專屬的 --user-data-dir，這樣才會是「我們自己的」瀏覽器行程，
 *      不會被併到使用者原本開著的 Edge 裡面（那樣就抓不到關窗事件）
 *   ④ 視窗關掉 → 那個行程結束 → 這支程式跟著結束。
 *      這點很重要：沒有小黑窗的話，使用者沒有別的方法可以關掉它。
 *
 * 我們本來就需要 Edge 來操作 EasyFlow，所以這個做法沒有多一個依賴。
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as cfgStore from "./config.mjs";
// core.mjs（supabase-js）和 verify.mjs（playwright-core）刻意**不在這裡 import**：
// 那兩包載進來要好幾秒，而「把視窗開起來」只需要 node:http。
// 先讓使用者看到畫面，這些等到真的要用時再動態載入。

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULTS = {
  appUrl: "https://fwanalysis.tty1224.com",
  easyflowUrl: "https://efnet.wanin.tw/EFNET/",
  browser: "msedge",
};

// ── 狀態（畫面每 1.2 秒來問一次） ──
const S = {
  screen: "boot",        // boot | setup | checking | running（boot＝還在判斷有沒有設定）
  status: "idle",        // idle | connecting | online | offline | duplicate
  busy: false,
  task: "",
  config: {},
  setup: { steps: [], error: "" },
  log: [],
};
const LOG_MAX = 200;
const pushLog = (l) => { S.log.push(l); if (S.log.length > LOG_MAX) S.log.splice(0, S.log.length - LOG_MAX); };

let bridge = null;
// ⚠️ 這是「bridge 正在用的那個 cfg 物件本身」（不是複本）。
// core.mjs 每次填單都從這個物件讀 browser，所以改它就等於即時換瀏覽器，
// 不用重連、也不用叫使用者重新設定。
let liveCfg = null;
let lastPing = Date.now();   // 介面最後一次來問狀態的時間（用來判斷視窗還在不在）
let quitting = false;

function publicConfig(c) {
  // 畫面只需要這些。密碼跟授權碼不往外送 —— 就算只是傳給自己的 localhost 也沒必要。
  return { email: c.email || "", easyflowUser: c.easyflowUser || "", browser: c.browser || "msedge" };
}

async function connect(cfg) {
  // ⚠️ 重新設定完會再呼叫一次這裡。舊的連線一定要先收掉，否則同一個行程裡會有
  // 兩個 channel 在聽同一條頻道 —— 每個請求被處理兩次，兩次登入互相搶，
  // 結果兩邊都失敗（實際踩過：症狀是「登入 EasyFlow…」出現兩三次然後登入失敗）。
  if (bridge) {
    try { await bridge.stop(); } catch { /* ignore */ }
    bridge = null;
  }
  S.screen = "running";
  S.config = publicConfig(cfg);
  liveCfg = cfg;
  try {
    const { startBridge } = await import("./core.mjs");
    bridge = await startBridge({
      cfg,
      onLog: (l) => pushLog(l),
      onState: (p) => Object.assign(S, p),
    });
  } catch (e) {
    S.status = "offline";
    pushLog({ text: String(e?.message || e), kind: "err", at: Date.now() });
  }
}

// ── 設定的檢查流程（畫面上會一步一步亮） ──
async function runSetup(input) {
  const steps = [
    { name: "連上網站、確認授權碼", status: "wait" },
    { name: BROWSERS[input.browser] ? "確認 " + BROWSERS[input.browser].label + " 能開" : "找瀏覽器", status: "wait" },
    { name: "試登入 EasyFlow", status: "wait" },
    { name: "存檔（密碼加密）", status: "wait" },
  ];
  S.setup = { steps, error: "" };
  S.screen = "checking";
  const cfg = { ...DEFAULTS, ...input };
  const fail = (i, msg) => { steps[i].status = "fail"; S.setup.error = msg; };

  try {
    const { checkToken, findBrowser, checkLogin } = await import("./verify.mjs");
    steps[0].status = "run";
    try { await checkToken(cfg); steps[0].status = "done"; }
    catch (e) { return fail(0, "網站不接受這組 email／授權碼：" + (e?.message || e)); }

    steps[1].status = "run";
    try { cfg.browser = await findBrowser(BROWSERS[input.browser] ? input.browser : undefined); steps[1].status = "done"; }
    catch (e) { return fail(1, String(e?.message || e)); }

    steps[2].status = "run";
    try { await checkLogin(cfg); steps[2].status = "done"; }
    catch (e) { return fail(2, "用這組帳密登不進 EasyFlow：" + (e?.message || e)); }

    steps[3].status = "run";
    try { cfgStore.save(cfg); steps[3].status = "done"; }
    catch (e) { return fail(3, "存檔失敗：" + (e?.message || e)); }

    pushLog({ text: "設定完成", kind: "ok", at: Date.now() });
    await connect(cfg);
  } catch (e) {
    S.setup.error = String(e?.message || e);
  }
}

// 瀏覽器安裝位置。這裡只用來「找得到就列出來給使用者選」——真的能不能開，
// 設定流程會實際啟動一次來驗（比檢查檔案存在可靠）。
const BROWSERS = {
  msedge: {
    label: "Edge",
    paths: ["C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
            "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"],
  },
  chrome: {
    label: "Chrome",
    paths: ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
            "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"],
  },
};

function browserExe(channel) {
  return (BROWSERS[channel]?.paths || []).find((x) => fs.existsSync(x)) || "";
}

function installedBrowsers() {
  return Object.entries(BROWSERS)
    .filter(([ch]) => browserExe(ch))
    .map(([ch, v]) => ({ channel: ch, label: v.label }));
}

// ── 同一台電腦只跑一份 ──
// 常見情況：先點了「開始使用.bat」開一個視窗，後來又點桌面捷徑 —— 就會變成兩份，
// 兩份搶同一組 EasyFlow 登入會兩邊都失敗。所以第二次啟動不要自己跑，
// 直接把「已經在跑的那一份」的視窗叫出來就好。
const LOCK = path.join(cfgStore.DIR, "running.json");

async function findRunning() {
  try {
    const j = JSON.parse(fs.readFileSync(LOCK, "utf8"));
    if (!j?.port) return null;
    // 真的去問它一聲，光看 pid 不準（pid 可能被別的程式重用）
    const r = await fetch(`http://127.0.0.1:${j.port}/state`, { signal: AbortSignal.timeout(1500) });
    if (r.ok) { await r.json(); return j; }
  } catch { /* 沒有、讀不到、或死掉了 —— 都當成沒有 */ }
  return null;
}

function writeLock(port) {
  try {
    fs.mkdirSync(cfgStore.DIR, { recursive: true });
    fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, port }), "utf8");
  } catch { /* 寫不進去也還是能跑，只是失去單一實例保護 */ }
}

function clearLock() {
  try {
    const j = JSON.parse(fs.readFileSync(LOCK, "utf8"));
    if (j?.pid === process.pid) fs.unlinkSync(LOCK);   // 別刪到別人的
  } catch { /* ignore */ }
}

// ── 小伺服器 ──
const readBody = (req) => new Promise((res) => {
  let b = "";
  req.on("data", (c) => { b += c; if (b.length > 65536) req.destroy(); });
  req.on("end", () => { try { res(JSON.parse(b || "{}")); } catch { res({}); } });
});

let logoDataUri = "";
try {
  const p = path.join(HERE, "logo.png");
  if (fs.existsSync(p)) logoDataUri = "data:image/png;base64," + fs.readFileSync(p).toString("base64");
} catch { /* 沒圖也沒差 */ }

const server = http.createServer(async (req, res) => {
  const send = (code, body, type = "application/json") => {
    res.writeHead(code, { "Content-Type": type + "; charset=utf-8", "Cache-Control": "no-store" });
    res.end(body);
  };
  const url = (req.url || "/").split("?")[0];

  if (url === "/") return send(200, fs.readFileSync(path.join(HERE, "ui.html"), "utf8"), "text/html");
  if (url === "/logo") return send(200, logoDataUri, "text/plain");
  if (url === "/state") { lastPing = Date.now(); return send(200, JSON.stringify(S)); }
  if (url === "/browsers") return send(200, JSON.stringify({ list: installedBrowsers() }));
  // 視窗被關掉時瀏覽器會用 sendBeacon 打這裡，這是最快、最準的收工訊號
  if (url === "/bye") { send(200, "{}"); return shutdown(); }

  if (url === "/setup") {
    const b = await readBody(req);
    runSetup(b);                       // 不 await：讓畫面可以一步步看進度
    return send(200, JSON.stringify({ ok: true }));
  }
  if (url === "/setup-reset") {
    const b = await readBody(req);
    if (b.wipe) { try { fs.unlinkSync(cfgStore.FILE); } catch { /* ignore */ } await bridge?.stop(); bridge = null; }
    S.screen = "setup"; S.status = "idle"; S.setup = { steps: [], error: "" };
    return send(200, JSON.stringify({ ok: true }));
  }
  if (url === "/open-setup-page") {
    const target = (S.configFull?.appUrl || DEFAULTS.appUrl) + "/?app=leavesetup";
    spawn("cmd", ["/c", "start", "", target], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    return send(200, JSON.stringify({ ok: true }));
  }
  // 換瀏覽器。刻意**不重連、不重跑設定檢查** —— 只要改掉 bridge 正在用的那個 cfg，
  // 下一次填單就會用新的瀏覽器開。（這個視窗本身沒辦法換，要下次開才會換。）
  if (url === "/browser") {
    const b = await readBody(req);
    const ch = String(b.channel || "");
    if (!BROWSERS[ch] || !browserExe(ch)) {
      return send(400, JSON.stringify({ ok: false, error: "這台電腦找不到那個瀏覽器" }));
    }
    try {
      const cfg = liveCfg || cfgStore.load();
      cfg.browser = ch;                     // 改的是同一個物件，所以馬上生效
      cfgStore.save(cfg);                   // 存起來，下次開也記得
      liveCfg = cfg;
      S.config = { ...S.config, browser: ch };
      pushLog({ text: `填單改用 ${BROWSERS[ch].label} 了（這個視窗要下次開才會跟著換）`, kind: "ok", at: Date.now() });
      return send(200, JSON.stringify({ ok: true, browser: ch }));
    } catch (e) {
      return send(500, JSON.stringify({ ok: false, error: String(e?.message || e) }));
    }
  }
  if (url === "/quit") { send(200, JSON.stringify({ ok: true })); return shutdown(); }

  send(404, JSON.stringify({ error: "not found" }));
});

// 只聽 127.0.0.1，別人連不進來。port 交給系統挑，避免撞到別的程式。
// （EFBRIDGE_PORT 只是開發時要固定 port 好測試用，正常不會設。）
// 讀一下偏好再開視窗，否則「已經在跑」那條路會用預設瀏覽器開，
// 跟正在跑的那份用不同 profile，就會變成兩個視窗
if (cfgStore.exists()) S.config = { ...S.config, ...cfgStore.peek() };

const already = await findRunning();
if (already) {
  // 已經有一份在跑：把它的視窗叫出來，自己安靜退場（不要印錯誤嚇人）
  openWindow(already.port);
  setTimeout(() => process.exit(0), 2500);
}

server.listen(Number(process.env.EFBRIDGE_PORT) || 0, "127.0.0.1", () => {
  if (already) return;
  const port = server.address().port;
  writeLock(port);

  // 開視窗前先讀一下偏好（不解密，很快）：這樣視窗會用使用者選的瀏覽器開，
  // 畫面上也能立刻顯示帳號，不用等連線完成。
  if (cfgStore.exists()) S.config = { ...S.config, ...cfgStore.peek() };

  // ⚠️ 順序很重要：**先把視窗開起來**，再去連線。
  // 之前是先連線才開視窗，結果使用者點下去要等 10 秒以上才看到任何東西
  // （讀設定要解密、驗授權碼要打伺服器、Realtime 要連上），
  // 中間毫無反應，大家都以為沒點到就再點一次。
  openWindow(port);

  // 有設定就接著連線（畫面會自己從「連線中」變「已上線」）；沒設定就停在設定畫面
  if (!cfgStore.exists()) { S.screen = "setup"; return; }
  S.status = "connecting";
  (async () => {
    try {
      const cfg = cfgStore.load();
      await connect(cfg);
    } catch {
      S.screen = "setup";
      pushLog({ text: "舊設定讀不出來（換過電腦或 Windows 帳號？）請重新設定。", kind: "warn", at: Date.now() });
    }
  })();
});

function openWindow(port) {
  // 介面視窗用使用者選的那個瀏覽器（EasyFlow 操作也是同一個，行為一致）
  const picked = S.config.browser === "chrome" ? "chrome" : "msedge";
  // ⚠️ profile 目錄要分開放。Edge 和 Chrome 共用同一個 --user-data-dir 時，
  // 先被其中一個佔住，另一個就啟動不起來（症狀：切換瀏覽器後視窗完全不出現）。
  const profile = path.join(os.tmpdir(), "efbridge-ui-" + picked);
  const args = [
    `--app=http://127.0.0.1:${port}/`,
    `--user-data-dir=${profile}`,     // 專屬 profile：確保這是「我們的」行程，關窗抓得到
    // 高度只留「動態收起來」時剛好夠的量（實測內容需要 413px，加上標題列的餘裕）。
    // 以前是 760 —— 那是動態展開時的長度，一開起來下面一大片空白。
    // 展開動態的時候 main 自己會捲，不用把視窗開那麼高。
    "--window-size=520,468",
    "--no-first-run",
    "--no-default-browser-check",
  ];
  const exe = browserExe(picked) || browserExe(picked === "chrome" ? "msedge" : "chrome");
  if (!exe) {
    // 找不到就退而求其次用預設瀏覽器開（會有網址欄，但至少能用）
    spawn("cmd", ["/c", "start", "", `http://127.0.0.1:${port}/`], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    return;
  }
  // ⚠️ 不能用 spawn 出來的行程來判斷視窗死活：Edge/Chrome 啟動後會自己重新
  // fork 一份，原本那個行程立刻結束，於是 exit 事件會馬上誤觸發。
  // 改成看「介面有沒有在跟我要狀態」——關窗時它會打 /bye，這是最準的；
  // 萬一 /bye 沒送到（當掉、強制關閉），心跳逾時當後備。
  spawn(exe, args, { stdio: "ignore", windowsHide: true }).unref();

  lastPing = Date.now();
  setInterval(() => {
    // 給到 2 分鐘：視窗最小化時瀏覽器會把計時器降頻，太短會誤殺。
    if (Date.now() - lastPing > 120000) shutdown();
  }, 15000).unref();
}

async function shutdown() {
  if (quitting) return;
  quitting = true;
  try { await bridge?.stop(); } catch { /* ignore */ }
  try { server.close(); } catch { /* ignore */ }
  clearLock();
  setTimeout(() => process.exit(0), 300);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
