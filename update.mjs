/* 自動更新。
 *
 * 為什麼要有：每出一版就要叫同事去 GitHub 重新下載、解壓縮、覆蓋，太麻煩，
 * 而且一定會有人停在舊版（實際發生過 —— 有人跑的還是三個版本前的程式）。
 *
 * 流程：
 *   ① 開機時（和之後每 6 小時）問一次 GitHub 的 releases API，比對版本
 *   ② 有新版就在視窗上顯示一條橫幅，使用者按「立即更新」才動作
 *   ③ 下載 ZIP → 解壓到暫存 → 檢查解出來的東西是完整的
 *   ④ 產生一支 updater.bat，交給它「等橋接關掉 → 覆蓋檔案 → 重新啟動」
 *   ⑤ 橋接自己退場
 *
 * ⚠️ 為什麼要由外面的 .bat 來覆蓋，而不是自己覆蓋自己：
 * 我們是被 node\node.exe 執行中的，Windows 不讓你覆蓋正在執行的 exe。
 * 所以一定要先讓自己死掉，才有辦法整包蓋過去。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFile } from "node:child_process";

const REPO = "TTY1224/EasyFlow_Bridge";
const API = `https://api.github.com/repos/${REPO}/releases/latest`;
const ASSET = "EasyFlow-Bridge-win.zip";
// ZIP 裡最外層是這個資料夾（build-release.ps1 壓的是整個資料夾）
const INNER = "EasyFlow-Bridge";

const TMP = path.join(os.tmpdir(), "efbridge-update");

/* 版本比大小。"v2.4.0" / "2.4.0" 都吃。 */
export function cmpVer(a, b) {
  const p = (v) => String(v || "").replace(/^v/i, "").split(".").map((x) => parseInt(x, 10) || 0);
  const [x, y] = [p(a), p(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0) ? 1 : -1;
  }
  return 0;
}

/* 問 GitHub 最新版是哪一版。失敗就回 null —— 檢查更新失敗不該吵使用者。 */
export async function checkLatest(currentVersion) {
  try {
    const r = await fetch(API, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "EasyFlowBridge" },
      signal: AbortSignal.timeout(12000),
    });
    if (!r.ok) return null;
    const j = await r.json();
    const tag = String(j?.tag_name || "");
    const asset = (j?.assets || []).find((a) => a?.name === ASSET);
    if (!tag || !asset?.browser_download_url) return null;
    // ⚠️ 下載網址一定要是這個 repo 的 release，不然等於讓別人塞東西進來
    if (!String(asset.browser_download_url).startsWith(`https://github.com/${REPO}/releases/download/`)) return null;
    return {
      version: tag.replace(/^v/i, ""),
      url: asset.browser_download_url,
      notes: String(j?.body || "").slice(0, 1500),
      newer: cmpVer(tag, currentVersion) > 0,
    };
  } catch {
    return null;    // 沒網路、GitHub 掛了、被限流 —— 都當作沒有新版
  }
}

const ps = (script) => new Promise((res, rej) => {
  execFile("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (e, so, se) => (e ? rej(new Error(se || e.message)) : res(so)));
});

/* 下載 + 解壓 + 檢查。回傳解出來的資料夾路徑。 */
export async function download(url, onProgress = () => {}) {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  const zip = path.join(TMP, ASSET);

  onProgress("下載中…");
  const r = await fetch(url, { signal: AbortSignal.timeout(180000) });
  if (!r.ok) throw new Error(`下載失敗（HTTP ${r.status}）`);
  const total = Number(r.headers.get("content-length") || 0);
  const chunks = [];
  let got = 0, lastPct = -1;
  for await (const c of r.body) {
    chunks.push(c);
    got += c.length;
    const pct = total ? Math.floor((got / total) * 100) : 0;
    if (total && pct !== lastPct && pct % 5 === 0) { lastPct = pct; onProgress(`下載中… ${pct}%`); }
  }
  fs.writeFileSync(zip, Buffer.concat(chunks));
  if (fs.statSync(zip).size < 1024 * 1024) throw new Error("下載到的檔案不完整");

  onProgress("解壓縮…");
  await ps(`Expand-Archive -LiteralPath '${zip}' -DestinationPath '${TMP}' -Force`);

  // 解出來要有完整的東西才敢覆蓋（半包蓋上去比不更新更慘）
  const src = path.join(TMP, INNER);
  for (const need of ["app.mjs", "core.mjs", "easyflow.mjs", "ui.html", "package.json",
                      path.join("node", "node.exe"), "EasyFlow_bridge.vbs"]) {
    if (!fs.existsSync(path.join(src, need))) throw new Error(`更新檔不完整（少了 ${need}）`);
  }
  return src;
}

/* 產生 updater 並交給它接手，然後自己退場。
 *
 * ⚠️ 兩個踩過的坑：
 * ① **不要用 `tasklist | find` 等自己死掉**。實際發生過：更新按下去之後，
 *    畫面上就卡著一個標題是 find "104064" 的小黑窗，永遠不動 ——
 *    find 在等 stdin，而那個 pipe 在這種啟動方式下不會如預期關掉。
 *    改成叫 PowerShell 等（一支程式、沒有 pipe，行為單純）。
 * ② **不要跳出小黑窗**。spawn 加 detached 之後 windowsHide 壓不住 cmd 的主控台，
 *    所以改成跟主程式一樣的做法：寫一支 .vbs，用 wscript 隱藏執行（視窗樣式 0）。
 *
 * 另外**不要在 .bat 裡刪掉自己所在的資料夾** —— cmd 是邊執行邊讀檔的。
 * 暫存夾交給下一次 download() 開頭清掉就好。
 */
export function handOff({ src, dst, pid, onLog = () => {} }) {
  const bat = path.join(TMP, "updater.bat");
  const vbs = path.join(TMP, "updater.vbs");

  // ⚠️ .bat 一律純 ASCII：中文寫進去，換一個 codepage 就變亂碼甚至跑掉
  const lines = [
    "@echo off",
    "rem EasyFlow bridge updater - generated automatically, safe to delete",
    "rem wait for the bridge process to exit (max 30s), then swap the files",
    `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$i=0; while ((Get-Process -Id ${pid} -ErrorAction SilentlyContinue) -and ($i -lt 30)) { Start-Sleep -Seconds 1; $i++ }"`,
    "rem /E keeps extra files the user may have put there; /IS overwrites same-size files",
    `robocopy "${src}" "${dst}" /E /IS /R:3 /W:1 /NFL /NDL /NJH /NJS /NP >nul`,
    "if errorlevel 8 goto failed",
    `start "" wscript.exe "${path.join(dst, "EasyFlow_bridge.vbs")}"`,
    "exit /b 0",
    "",
    ":failed",
    `echo Update failed. Please download it again from https://github.com/${REPO}/releases`,
    "pause",
  ];
  fs.writeFileSync(bat, lines.join("\r\n"), "ascii");

  // 視窗樣式 0 ＝ 完全隱藏（跟主程式的啟動器同一招）
  fs.writeFileSync(vbs,
    'Set sh = CreateObject("WScript.Shell")\r\n'
    + `sh.Run """${bat}""", 0, False\r\n`, "ascii");

  onLog("交給更新程式，視窗會自己關掉再開起來…");
  // detached：這支要活得比我久
  spawn("wscript.exe", [vbs], { detached: true, stdio: "ignore" }).unref();
}
