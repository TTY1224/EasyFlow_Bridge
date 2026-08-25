/* 設定的檢查步驟。CLI 精靈（setup.mjs）和視窗介面（app.mjs）共用，
   不要讓兩邊各寫一份，否則一定會走鐘。 */
import { chromium } from "playwright-core";

// 授權碼對不對（順便確認連得到網站）
export async function checkToken({ appUrl, email, token }) {
  const r = await fetch(appUrl.replace(/\/+$/, "") + "/api/leave/bridge-config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, token }),
  });
  const d = await r.json().catch(() => null);
  if (!d) throw new Error(`網站回了看不懂的東西（HTTP ${r.status}）`);
  if (!d.ok) throw new Error(d.error || `HTTP ${r.status}`);
  return d;
}

// 找一個能用的瀏覽器。回 "msedge" 或 "chrome"。
export async function findBrowser() {
  for (const ch of ["msedge", "chrome"]) {
    try {
      const b = await chromium.launch({ channel: ch, headless: false });
      await b.close();
      return ch;
    } catch { /* 試下一個 */ }
  }
  throw new Error("找不到 Edge 或 Chrome。Windows 內建就有 Edge，請確認沒被移除。");
}

// 這組公司帳密登不登得進去。登完就關，什麼都不做。
export async function checkLogin({ easyflowUrl, easyflowUser, easyflowPass, browser }) {
  const b = await chromium.launch({ channel: browser || "msedge", headless: false, slowMo: 250 });
  try {
    const page = await (await b.newContext({ ignoreHTTPSErrors: true })).newPage();
    page.on("dialog", async (d) => { await d.accept(); });
    await page.goto(easyflowUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(2000);
    const lf = page.frames().find((f) => f.url().includes("EFDBLogin")) || page.mainFrame();
    await lf.fill("#txtName", easyflowUser);
    await lf.fill("#txtPassword", easyflowPass);
    await lf.click("#imgBtnLogin");
    await page.waitForTimeout(7000);
    if (!page.frames().find((f) => f.name() === "banner")) {
      throw new Error("帳號或密碼不對（EasyFlow 沒讓我們進去）");
    }
    return true;
  } finally {
    try { await b.close(); } catch { /* ignore */ }
  }
}
