#!/usr/bin/env node
/* 首次設定精靈。問四件事，存到 %APPDATA%\EasyFlowBridge\config.json。
 * 密碼用 Windows 內建加密鎖住（綁這台電腦＋這個 Windows 帳號）。 */
import readline from "node:readline";
import { chromium } from "playwright-core";
import * as cfgStore from "./config.mjs";

const DEFAULTS = {
  appUrl: "https://fwanalysis.tty1224.com",
  easyflowUrl: "https://efnet.wanin.tw/EFNET/",
  browser: "msedge",
};

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q, dflt = "") => new Promise((res) => {
  rl.question(dflt ? `${q}（直接按 Enter＝${dflt}）\n> ` : `${q}\n> `, (a) => res((a || "").trim() || dflt));
});

// 密碼不要回顯在畫面上。Windows 的 cmd 下沒有現成做法，自己攔鍵盤。
const askSecret = (q) => new Promise((res) => {
  process.stdout.write(q + "\n> ");
  const stdin = process.stdin;
  const wasRaw = stdin.isRaw;
  if (stdin.setRawMode) stdin.setRawMode(true);
  stdin.resume();
  let buf = "";
  const onData = (ch) => {
    const c = ch.toString("utf8");
    if (c === "\r" || c === "\n") {
      stdin.removeListener("data", onData);
      if (stdin.setRawMode) stdin.setRawMode(Boolean(wasRaw));
      process.stdout.write("\n");
      res(buf);
    } else if (c === "") {                 // Ctrl+C
      process.stdout.write("\n已取消\n");
      process.exit(1);
    } else if (c === "" || c === "\b") {   // 退格
      if (buf.length) { buf = buf.slice(0, -1); process.stdout.write("\b \b"); }
    } else if (c >= " ") {
      buf += c;
      process.stdout.write("*");
    }
  };
  stdin.on("data", onData);
});

console.log(`
==================================================
  EasyFlow 橋接 — 首次設定
==================================================

  設定只存在這台電腦上。你的公司密碼會用 Windows 內建的
  加密鎖住（綁這台電腦＋這個 Windows 帳號），
  網站和其他人都看不到。
`);

const email = (await ask("① 你在數據網站上登入用的 email")).toLowerCase();
if (!email.includes("@")) { console.error("\n✗ 這看起來不像 email\n"); process.exit(1); }

console.log(`
② 授權碼
   到數據網站 → 跟 Woby 說「我要設定請假橋接」，
   或直接打開：${DEFAULTS.appUrl}/?app=leavesetup
   把上面那串授權碼複製過來。
`);
const token = await ask("   貼上授權碼");
if (token.length < 20) { console.error("\n✗ 授權碼看起來太短，應該有 30 幾個字\n"); process.exit(1); }

const easyflowUser = await ask("③ 你的 EasyFlow 帳號（就是簽單系統的帳號，不是 email）");
const easyflowPass = await askSecret("④ 你的 EasyFlow 密碼（打字不會顯示出來，這是正常的）");
if (!easyflowUser || !easyflowPass) { console.error("\n✗ 帳號或密碼是空的\n"); process.exit(1); }

const cfg = { ...DEFAULTS, email, token, easyflowUser, easyflowPass };

// ── 存之前先驗，不要讓人設定完才發現打錯 ──
console.log("\n檢查中…\n");

process.stdout.write("  ① 網站與授權碼… ");
try {
  const r = await fetch(cfg.appUrl.replace(/\/+$/, "") + "/api/leave/bridge-config", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, token }),
  });
  const d = await r.json();
  if (!d.ok) throw new Error(d.error || `HTTP ${r.status}`);
  console.log("OK");
} catch (e) {
  console.log("失敗");
  console.error("\n✗ " + (e?.message || e) + "\n  email 或授權碼不對，請重跑一次。\n");
  process.exit(1);
}

process.stdout.write("  ② 找瀏覽器… ");
let browserOk = false;
for (const ch of ["msedge", "chrome"]) {
  try {
    const b = await chromium.launch({ channel: ch, headless: false });
    await b.close();
    cfg.browser = ch;
    console.log("OK（用 " + (ch === "msedge" ? "Edge" : "Chrome") + "）");
    browserOk = true;
    break;
  } catch { /* 試下一個 */ }
}
if (!browserOk) {
  console.log("失敗");
  console.error("\n✗ 找不到 Edge 或 Chrome。Windows 內建就有 Edge，請確認沒被移除。\n");
  process.exit(1);
}

process.stdout.write("  ③ 登入 EasyFlow… ");
try {
  const b = await chromium.launch({ channel: cfg.browser, headless: false, slowMo: 250 });
  try {
    const page = await (await b.newContext({ ignoreHTTPSErrors: true })).newPage();
    page.on("dialog", async (d) => { await d.accept(); });
    await page.goto(cfg.easyflowUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(2000);
    const lf = page.frames().find((f) => f.url().includes("EFDBLogin")) || page.mainFrame();
    await lf.fill("#txtName", easyflowUser);
    await lf.fill("#txtPassword", easyflowPass);
    await lf.click("#imgBtnLogin");
    await page.waitForTimeout(7000);
    if (!page.frames().find((f) => f.name() === "banner")) throw new Error("登入沒過");
    console.log("OK");
  } finally { try { await b.close(); } catch { /* ignore */ } }
} catch (e) {
  console.log("失敗");
  console.error("\n✗ 用這組帳密登不進 EasyFlow：" + (e?.message || e));
  console.error("  請確認帳號密碼，然後重跑一次。\n");
  process.exit(1);
}

const file = cfgStore.save(cfg);
rl.close();

console.log(`
==================================================
  設定完成 ✓
==================================================

  設定檔：${file}
  （密碼在裡面是加密的，複製到別台電腦解不開）

  接下來：雙擊「啟動.bat」，然後回網站找 Woby 講話。
  以後每次要用，就先開「啟動.bat」。
`);
