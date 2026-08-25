/* EasyFlow（華苓 BPM）的瀏覽器操作。
 *
 * 這裡面每一個選擇器、每一個等待時間，都是實際點過、量過才寫下來的。
 * 動它之前先看清楚註解裡寫的雷。
 */
import { chromium } from "playwright-core";

/* ── 為什麼一定要開「看得見的」瀏覽器 ────────────────────────────────
 * 試過無頭模式（headless），HRMESS 的表單頁會回一個完全空的 body：
 *   <html><head></head><body></body></html>
 * 一個 input 都沒有。公司系統應該有擋。所以只能開真視窗。
 *
 * 附帶好處：填公司的簽核單這種事，本來就該讓人看見在做什麼。
 * ─────────────────────────────────────────────────────────────── */
const HEADLESS = false;

/* slowMo 不能省。EasyFlow 是舊的 frameset + 大量 JS，動作太快會在欄位還沒
 * 掛好時就被點到，症狀是「按鈕找不到」或「假別沒選中」。 */
const SLOW_MO = 250;

/* 表單分頁：banner 上那排按鈕。目前只用到請假申請。
 * 其餘幾個（點名結果／加班調休／補刷卡／不加班原因說明）是同一排的按鈕，
 * id 應該是 tdMenu_2…5，但**還沒實際點過驗證**，要加新單種時請先確認。 */
export const FORMS = {
  leave: { menu: "#tdMenu_1", label: "請假申請" },
};

/* 三顆唯讀查詢按鈕。id 與跳出來的資料頁都是實際點過確認的。 */
export const QUERIES = {
  balance: { label: "可休時數", btn: "#btnDetail", page: "ESSF07_Detail.aspx" },
  history: { label: "請假記錄", btn: "#btnRecord", page: "ESSF07_Record.aspx" },
  punch: { label: "刷卡記錄", btn: "#btnCardRecord", page: "ESSF07_EmpRankRecord.aspx" },
};

/* 登入並開好指定的表單分頁。填單和查詢都從這裡開始。 */
export async function openForm({ cfg, form = "leave", say = () => {}, browserChannel }) {
  const channel = browserChannel || cfg.browser || "msedge";
  const browser = await chromium.launch({ channel, headless: HEADLESS, slowMo: SLOW_MO });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 }, ignoreHTTPSErrors: true });
    const page = await ctx.newPage();
    // EasyFlow 會跳好幾個 alert（例如「事後補假單請載明事由」），不接掉會卡住
    page.on("dialog", async (d) => { say("[系統訊息] " + d.message().slice(0, 90)); await d.accept(); });

    say("登入 EasyFlow…");
    await page.goto(cfg.easyflowUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(2000);
    const lf = page.frames().find((f) => f.url().includes("EFDBLogin")) || page.mainFrame();
    await lf.fill("#txtName", cfg.easyflowUser);
    // 密碼直接填進欄位就好：頁面自己會用 RSA 加密後才送出（hdPublicKeyExponent/hdEncrypted）。
    // 也正是因為這樣，才沒辦法在伺服器端單純 POST 登入。
    await lf.fill("#txtPassword", cfg.easyflowPass);
    await lf.click("#imgBtnLogin");
    await page.waitForTimeout(7000);
    if (!page.frames().find((f) => f.name() === "banner")) {
      throw new Error("登入失敗（帳號密碼錯誤，或公司系統異常）");
    }

    // 只能透過系統自己的 createTab 開單。直接 goto 表單網址會被踢「Session過期」。
    const f = FORMS[form] || FORMS.leave;
    say(`開啟${f.label}單…`);
    await page.frames().find((x) => x.name() === "banner").click(f.menu);
    await page.waitForTimeout(12000);
    const fp = page.frames().find((x) => x.name() === "framePlus");
    if (!fp) throw new Error(`${f.label}單沒有開起來`);
    return { browser, page, fp };
  } catch (e) {
    try { await browser.close(); } catch { /* ignore */ }
    throw e;
  }
}

/* 對話框（假別選擇器、查詢結果）關閉的方法。
 * ⚠️ Escape 沒用，框內也沒有 class 帶 close 的元素 —— 要點框裡那個「×」文字。
 * 沒關掉的話下一顆按鈕會被遮住，點下去沒反應（症狀是 click 逾時）。 */
async function closeDialog(page, fp) {
  try { await fp.getByText("×", { exact: true }).first().click({ force: true, timeout: 3000 }); } catch { /* ignore */ }
  await page.waitForTimeout(1500);
}

/* 填請假單，填完按「計算」就停手。
 * ⚠️ 這個函式永遠不會按存檔／暫存／送簽。送出與否一律由人決定。 */
export async function fillLeave({ cfg, req, say = () => {} }) {
  const { browser, page, fp } = await openForm({ cfg, form: "leave", say });

  // 假別只能用選擇器選，打字會被擋（系統會跳「假別還沒有選喔~」）
  say(`選假別 ${req.code}…`);
  await fp.click("#ESSQJ036_btn_icon", { force: true });
  await page.waitForTimeout(5000);
  const dlg = page.frames().find((f) => f.name() === "dialogIframe" || f.url().includes("F2Single_Simple"));
  if (!dlg) throw new Error("假別選擇器沒有開啟");

  const findRow = () => dlg.$$eval("tr", (trs, c) => {
    for (let i = 0; i < trs.length; i++) {
      const cells = Array.from(trs[i].querySelectorAll("td")).map((td) => (td.innerText || "").trim());
      if (cells.includes(c)) return i;
    }
    return -1;
  }, req.code);

  let idx = await findRow();
  for (let p = 2; idx < 0 && p <= 3; p++) {        // 清單分 3 頁；查詢鈕是隱藏的，只能翻頁
    const link = dlg.locator("a").filter({ hasText: String(p) }).last();
    if (!(await link.count())) break;
    await link.click({ force: true });
    await page.waitForTimeout(3500);
    idx = await findRow();
  }
  if (idx < 0) throw new Error(`清單中找不到假別代碼 ${req.code}`);
  await dlg.locator("tr").nth(idx).click();
  await page.waitForTimeout(4500);
  const gotCode = await fp.inputValue("#ESSQJ036_txt").catch(() => "");
  if (gotCode !== req.code) throw new Error(`假別沒有選中（目前是「${gotCode}」）`);

  say("填日期、時間與原因…");
  for (const [id, v] of [["ESSQJ021_txt", req.start], ["ESSQJ022_txt", req.startT],
                         ["ESSQJ023_txt", req.end], ["ESSQJ024_txt", req.endT],
                         ["ESSQJ026_txt", req.reason || ""]]) {
    await fp.fill("#" + id, v);
  }

  say("計算時數…");
  await fp.click("#btnCount");
  await page.waitForTimeout(5000);
  const hours = await fp.inputValue("#ESSQJ025_txt").catch(() => "");
  const days = await fp.inputValue("#ESSQJ035_txt").catch(() => "");
  const typeName = await fp.inputValue("#ESSQJ020_txt").catch(() => "");
  const shot = await snapForm(page, fp);

  // 時數算不出來就不能說「填好了」。實測：連假的日期（例如 2026/09/25、09/28）
  // 會跳「[輸入時段內不存在需要請假的時間區間]」且時數留空，這種單根本送不出去；
  // 而 2026/09/18 同樣流程就正常算出 8 小時。
  // 瀏覽器刻意留著不關，使用者可以直接改日期再按「計算」。
  if (!hours || !(parseFloat(hours) > 0)) {
    const err = new Error("EasyFlow 算出來是 0 小時，那個時段沒有需要請假的上班時間 —— 可能是假日、國定假日/連假，或那天的班表還沒產生。表單留在畫面上，你可以直接改日期再按「計算」。");
    err.keepBrowser = browser;    // 讓呼叫方知道視窗要留著
    err.shot = shot;
    throw err;
  }

  return { browser, typeName, hours, days, shot };
}

/* 唯讀查詢：點三顆按鈕之一，把跳出來的表格讀成 cols + rows。
 * 完全不碰任何輸入欄位。 */
export async function runQuery({ cfg, kind, say = () => {} }) {
  const meta = QUERIES[kind];
  if (!meta) throw new Error(`未知的查詢類型：${kind}`);
  const { browser, page, fp } = await openForm({ cfg, form: "leave", say });
  try {
    say(`讀取「${meta.label}」…`);
    await fp.click(meta.btn, { force: true });
    await page.waitForTimeout(9000);
    const dlg = page.frames().find((f) => f.url().includes(meta.page));
    if (!dlg) throw new Error(`「${meta.label}」沒有開起來`);

    const table = await dlg.evaluate(() => {
      // 挑列數最多的那個 table：這種舊系統常用 table 排版，直接拿第一個會拿到版面框
      const t = Array.from(document.querySelectorAll("table")).sort((a, b) => b.rows.length - a.rows.length)[0];
      if (!t) return null;
      return Array.from(t.querySelectorAll("tr"))
        .map((tr) => Array.from(tr.querySelectorAll("th,td")).map((td) => (td.innerText || "").trim().replace(/\s+/g, " ")))
        .filter((r) => r.some((c) => c));
    });
    if (!table || table.length < 2) throw new Error(`「${meta.label}」查出來是空的`);

    await closeDialog(page, fp);
    return { label: meta.label, cols: table[0], rows: table.slice(1, 61) };
  } finally {
    // 查詢是唯讀的，看完就關 —— 不像填單要留著讓人送出
    try { await browser.close(); } catch { /* ignore */ }
  }
}

/* 把填好的表單截一張圖，讓使用者在聊天室裡就能核對，不用切視窗。
 * 走 Realtime 傳，不上傳雲端：單子上有姓名/員編/部門，不想讓它變成公開網址。
 * 代價是有大小上限（單則約 256KB），所以壓 JPEG + 只截表單範圍。 */
async function snapForm(page, fp) {
  try {
    // 表單外層 frame 和內層容器各有自己的捲軸，兩個都要捲到頂，
    // 否則最上面那排（填單人/請假人/代理人）會被切掉。
    await fp.evaluate(() => {
      window.scrollTo(0, 0);
      document.documentElement.scrollTop = 0;
      document.body.scrollTop = 0;
      document.querySelectorAll("*").forEach((el) => { if (el.scrollTop) el.scrollTop = 0; });
    });
    await page.waitForTimeout(700);

    const fe = await fp.frameElement();
    // ⚠️ 欄位的 getBoundingClientRect 是「frame 內座標」，但 page.screenshot 的 clip
    // 是「整頁座標」，中間差一個 frame 位移。直接拿來用會裁歪（右半邊整排不見）。
    // 所以要拿 frame 自己的 boundingBox 當原點加回去。
    const fb = await fe.boundingBox();
    const r = await fp.evaluate(() => {
      const els = Array.from(document.querySelectorAll('input[id^="ESSQJ"], textarea[id^="ESSQJ"]'))
        .filter((el) => el.offsetParent !== null);
      if (!els.length) return null;
      let l = 1e9, t = 1e9, rt = 0, b = 0;
      for (const el of els) {
        const c = el.getBoundingClientRect();
        if (!c.width) continue;
        l = Math.min(l, c.left); t = Math.min(t, c.top);
        rt = Math.max(rt, c.right); b = Math.max(b, c.bottom);
      }
      return b > t ? { left: l, top: t, right: rt, bottom: b } : null;
    });

    let buf;
    if (fb && r) {
      const vp = page.viewportSize() || { width: 1500, height: 900 };
      const pad = 34;
      const x = Math.max(0, fb.x + r.left - 110);        // 左邊留出欄位標籤
      const y = Math.max(0, fb.y + r.top - pad * 2);
      buf = await page.screenshot({
        type: "jpeg", quality: 62, timeout: 15000,
        clip: {
          x, y,
          width: Math.min(vp.width - x, fb.x + r.right + pad - x),
          height: Math.min(vp.height - y, fb.y + r.bottom + pad - y),
        },
      });
    } else {
      buf = await fe.screenshot({ type: "jpeg", quality: 62, timeout: 15000 });
    }
    if (buf.length >= 170 * 1024) return "";            // base64 會膨脹約 1.33 倍，留安全邊際
    return "data:image/jpeg;base64," + buf.toString("base64");
  } catch {
    return "";                                          // 截不到不影響填單
  }
}
