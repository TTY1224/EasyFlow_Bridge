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

/* 等到條件成立（或逾時）。
 *
 * 這支系統每一步都要等它跑完，本來全用固定 sleep（開單 13 秒、存檔 13 秒…），
 * 一個人加起來 55 秒以上、8 個人要 8 分鐘。但那些數字是抓「最壞情況」，
 * 平常 2~3 秒就好。改成輪詢條件之後大部分步驟都是秒級完成。
 *
 * fn 回 truthy 就結束；丟例外當成「還沒好」（frame 重載時讀欄位會炸，很正常）。 */
async function until(fn, { timeout = 30000, step = 250, page = null } = {}) {
  const t0 = Date.now();
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch { /* 還沒好，再等 */ }
    if (Date.now() - t0 > timeout) return null;
    if (page) await page.waitForTimeout(step);
    else await new Promise((r) => setTimeout(r, step));
  }
}

/* 表單清單。
 *
 * ⚠️ 不要用 banner 上那排快捷按鈕（#tdMenu_1…）—— **那排是每個人自己排的**，
 * 同事的「請假申請」不一定在上面。要走左邊功能樹的正規路徑。
 *
 * 左邊那棵樹（frame「contents1」）上每個表單都是這種連結：
 *   javascript:createTab('../../../EPI/EPIE001/EPIE001.aspx?FormID=ESSF07',
 *                        'ESSF07','請假申請(ESSF07)','107')
 * createTab 是系統自己的導覽函式，直接呼叫就會開單（實測可行）。
 * 這樣既不依賴個人的快捷列，也不用去展開資料夾。
 *
 * 從樹上實際抓到的表單代號（要加新單種時照抄就好，不用再猜）：
 *   ESSF07  請假申請          ESSF03  補刷卡申請
 *   ESSF06  加班調休申請      ESSF93  不加班原因說明
 *   ESSF50  班次變更          ESSF51  加班計劃申請(多時段多人)
 *   ESSF52C1 班次互換         ESSF17G 銷假申請
 *   ESSF21G 國內、外出差申請單 ESSF01  排班申請
 *   ESSQ07  點名結果（查詢類，路徑是 EPII003 不是 EPIE001）
 *   ESSQ08  請假資料（同上）
 * 表單類走 EPI/EPIE001/EPIE001.aspx，查詢類走 EPI/EPII003/EPII003.aspx。
 * 但**欄位 id 每張單都不一樣**，加新單種還是要自己 dump 一次。
 */
const ESS_MODULE = "AppFormESS";      // 左欄下拉選單「ESS PLUS模組」的 value

export const FORMS = {
  leave: {
    label: "請假申請",
    formId: "ESSF07",
    url: "../../../EPI/EPIE001/EPIE001.aspx?FormID=ESSF07",
    title: "請假申請(ESSF07)",
    // 欄位 id（實際 dump 過）
    f: {
      person: "ESSQJ008",        // 請假人（_txt 工號、_btn_icon 放大鏡）
      personName: "ESSQJ009",
      dept: "ESSQJ015",
      code: "ESSQJ036",          // 假別（只有這張單有）
      startD: "ESSQJ021", startT: "ESSQJ022", endD: "ESSQJ023", endT: "ESSQJ024",
      hours: "ESSQJ025", reason: "ESSQJ026", typeName: "ESSQJ020", days: "ESSQJ035",
    },
  },
  overtime: {
    label: "加班調休申請",
    formId: "ESSF06",
    url: "../../../EPI/EPIE001/EPIE001.aspx?FormID=ESSF06",
    title: "加班調休申請(ESSF06)",
    f: {
      person: "ESSJBDX009",      // 調休人
      personName: "ESSJBDX010",
      dept: "ESSJBDX016",
      code: "",                  // 沒有假別
      startD: "ESSJBDX020", startT: "ESSJBDX021", endD: "ESSJBDX022", endT: "ESSJBDX023",
      hours: "ESSJBDX004", reason: "ESSJBDX024", typeName: "", days: "",
    },
  },
};

/* EasyFlow 外層工具列（在 frame<FormID> 這層，不是 framePlus）。
 * ⚠️ 兩顆長得很像，絕對不要搞錯：
 *    草稿儲存 = btnCreateToolSaveForm      ← 我們只按這顆
 *    傳送     = btnPreCreateToolSendForm   ← 送去簽核，永遠不碰
 */
const BTN_DRAFT = "#MasterPage_btnCreateToolSaveForm";

/* 三顆唯讀查詢按鈕。id 與跳出來的資料頁都是實際點過確認的。 */
export const QUERIES = {
  balance: { label: "可休時數", btn: "#btnDetail", page: "ESSF07_Detail.aspx" },
  history: { label: "請假記錄", btn: "#btnRecord", page: "ESSF07_Record.aspx" },
  punch: { label: "刷卡記錄", btn: "#btnCardRecord", page: "ESSF07_EmpRankRecord.aspx" },
};

/* 開瀏覽器並登入。回傳之後要重複用的東西（page、功能樹 frame）。
 * 拆出來是為了批次代填：一次登入、開很多張單，不要每個人都重登一次。 */
export async function login({ cfg, say = () => {}, browserChannel }) {
  const channel = browserChannel || cfg.browser || "msedge";
  const browser = await chromium.launch({ channel, headless: HEADLESS, slowMo: SLOW_MO });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 }, ignoreHTTPSErrors: true });
    const page = await ctx.newPage();
    // EasyFlow 會跳好幾個 alert（「事後補假單請載明事由」、「表單頁籤已存在要不要重載」…），
    // 不接掉會整個卡住。
    // 順手把訊息留著：時數算不出來的時候，這裡通常就寫了真正的原因
    // （例如「[韋冠羣可供調休時數不足]」），比我們自己猜準得多。
    const notes = { last: "" };
    page.on("dialog", async (d) => {
      const m = d.message().trim();
      say("[系統訊息] " + m.slice(0, 90));
      // 這幾則是每次都會跳的例行提示，不是錯誤原因，不要記
      if (!/頁籤已存在|事後補假單/.test(m)) notes.last = m.replace(/^\[|\]$/g, "");
      await d.accept();
    });

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

    const tree = page.frames().find((x) => x.name() === "contents1");
    if (!tree) throw new Error("找不到左邊的功能樹（contents1）");
    // 切到 ESS PLUS 模組（這些單都在這個模組底下）。已經選好時不會有反應，不算錯。
    try {
      await tree.selectOption("#ddlModule", ESS_MODULE);
      await page.waitForTimeout(4000);
    } catch { /* 沒有這個下拉、或已經選好了 */ }

    return { browser, page, tree, notes };
  } catch (e) {
    try { await browser.close(); } catch { /* ignore */ }
    throw e;
  }
}

/* 開一張空白表單分頁。已經開過同一張時，系統會問「頁籤已存在要不要重載」，
 * dialog handler 會自動接受 —— 所以重複呼叫會重用同一個分頁、內容清空，
 * 分頁不會愈開愈多（實測過）。 */
export async function openFormTab({ page, tree, form = "leave", say = () => {}, prevFp = null }) {
  const f = FORMS[form] || FORMS.leave;
  say(`開啟${f.label}單…`);

  // ⚠️ 一定要從外層 frame 往下找 framePlus。
  // 同時開多張表單分頁時會有多個同名的 framePlus，用 page.frames() 找會抓到別張單。
  const pick = () => {
    const outer = page.frames().find((x) => x.name() === "frame" + f.formId);
    if (!outer) return null;
    const fp = outer.childFrames().find((x) => x.name() === "framePlus")
      || outer.childFrames().flatMap((c) => c.childFrames()).find((x) => x.name() === "framePlus");
    return fp ? { outer, fp } : null;
  };

  // 重開之前先記住舊的 framePlus，等一下要確認拿到的是「新的」那個。
  const beforeFp = prevFp || (pick() ? pick().fp : null);

  // 只能透過系統自己的 createTab 開單。直接 goto 表單網址會被踢「Session過期」。
  await tree.evaluate(({ url, formId, title }) => {
    if (typeof createTab !== "function") throw new Error("這個頁面沒有 createTab");
    createTab(url, formId, title, "107");
  }, { url: f.url, formId: f.formId, title: f.title });

  // ⚠️ 這 3 秒不能省：系統會先問「頁籤已存在要不要重載」（dialog handler 自動接受），
  // 重載才開始。太早去抓 frame 會抓到「還沒被換掉的舊表單」，
  // 之後點放大鏡完全沒反應（症狀：「選人視窗沒有開起來」）。踩過。
  await page.waitForTimeout(3000);

  // 等到「重載後的新 framePlus，而且是一張空白單」。
  // 條件連續成立兩次才算 —— 載入中途讀得到值但馬上又被換掉。
  let lastFp = null;
  let stable = 0;
  const got = await until(async () => {
    const t = pick();
    if (!t || t.fp.isDetached()) { stable = 0; return null; }
    if (beforeFp && t.fp === beforeFp) { stable = 0; return null; }   // 還是舊的，reload 還沒完成
    const person = await t.fp.inputValue(`#${f.f.person}_txt`);
    if (!person) { stable = 0; return null; }
    const hours = await t.fp.inputValue(`#${f.f.hours}_txt`);
    if (hours) { stable = 0; return null; }                            // 上一張單還沒清掉
    if (lastFp === t.fp) stable += 1; else { lastFp = t.fp; stable = 0; }
    return stable >= 2 ? t : null;
  }, { timeout: 45000, step: 400, page });

  if (!got) {
    if (!pick()) throw new Error(`${f.label}單沒有開起來`);
    throw new Error(`${f.label}單一直沒有變成空白表單`);
  }
  return { fp: got.fp, outer: got.outer, form: f };
}

/* 登入並開好指定的表單分頁（單張作業用）。 */
export async function openForm({ cfg, form = "leave", say = () => {}, browserChannel }) {
  const ses = await login({ cfg, say, browserChannel });
  try {
    const t = await openFormTab({ page: ses.page, tree: ses.tree, form, say });
    return { browser: ses.browser, page: ses.page, tree: ses.tree, notes: ses.notes, ...t };
  } catch (e) {
    try { await ses.browser.close(); } catch { /* ignore */ }
    throw e;
  }
}

/* 讀選人視窗目前這一頁的清單。挑列數最多的 table —— 這種舊系統常用 table 排版。 */
function readRowsRaw(dlg) {
  return dlg.evaluate(() => {
    const t = Array.from(document.querySelectorAll("table")).sort((a, b) => b.rows.length - a.rows.length)[0];
    if (!t) return [];
    return Array.from(t.querySelectorAll("tr")).slice(1)
      .map((tr) => Array.from(tr.querySelectorAll("td")).map((td) => (td.innerText || "").trim()))
      .filter((c) => c.length > 2 && /^\d+$/.test(c[0] || ""))
      .map((c) => ({ no: c[0], name: c[1], dep: c[4] || "" }));
  });
}

/* 在「請假人／調休人」的放大鏡視窗裡挑一個人（用姓名比對）。
 *
 * ⚠️ 不要去切「資料查詢條件」那個下拉（ddlSEARCH）。它是 AutoPostBack，
 * 一切換就把打好的關鍵字清掉，查出來會是 0 筆（踩過）。
 * 正確做法就是使用者手動時的做法：清空關鍵字 → 查詢 → 在結果裡找名字（會翻頁）。
 */
async function pickPerson({ page, fp, form, name, say = () => {} }) {
  say(`選人：${name}…`);
  await fp.click(`#${form.f.person}_btn_icon`, { force: true });

  // 等視窗真的可以操作。⚠️ 判斷要用 locator().count() ——
  // 之前用 frame.$() 一直判斷不成立、卡滿 30 秒才逾時（踩過）。
  // 實測用 locator 大概 0.5 秒就好，原本固定等 6 秒都在白等。
  const dlg = await until(async () => {
    const d = page.frames().find((f) => f.name() === "dialogIframe" || f.url().includes("F2Single"));
    if (!d) return null;
    return (await d.locator("#txtSEARCH").count()) ? d : null;
  }, { timeout: 25000, page });
  if (!dlg) throw new Error("選人視窗沒有開起來");

  await dlg.fill("#txtSEARCH", "");
  // 查詢鈕是隱藏的（Playwright 會拒絕點），用 DOM 直接觸發
  await dlg.evaluate(() => document.getElementById("btnSEARCH").click());
  // 剛開的視窗清單是空的，查完才會有東西 —— 等到有兩筆以上就是查回來了（實測 0.5 秒）
  await until(async () => (await readRowsRaw(dlg)).length > 1, { timeout: 25000, page });

  const readRows = () => readRowsRaw(dlg);

  // 一邊翻頁一邊找。**名字完全相符就當場選** —— 不用把所有頁翻完再回頭，
  // 那樣一個人要多花十幾秒（8 個人就差兩分鐘）。
  const seen = [];
  const gotoPage = async (n) => {
    const link = dlg.locator("a").filter({ hasText: String(n) }).last();
    if (!(await link.count())) return false;
    await link.click({ force: true });
    // 翻頁的完成訊號不好判斷（新舊清單可能長得像），所以還是固定等，只是縮短一點
    await page.waitForTimeout(3000);
    return true;
  };

  const selectRow = async (row) => {
    await dlg.locator("tr").filter({ hasText: row.name }).first().dblclick({ force: true });
    // 等表單上的人真的換成他（選人會觸發一輪 postback 重帶部門職位）。實測 0.7 秒。
    await until(async () => (await fp.inputValue(`#${form.f.person}_txt`)) === row.no,
                { timeout: 25000, step: 250, page });
    const gotName = await fp.inputValue(`#${form.f.personName}_txt`).catch(() => "");
    const gotNo = await fp.inputValue(`#${form.f.person}_txt`).catch(() => "");
    if (gotNo !== row.no) throw new Error(`選人沒生效（表單上目前是「${gotNo} ${gotName}」）`);
    return { no: gotNo, name: gotName, dep: row.dep };
  };

  let pageNo = 1;
  for (; pageNo <= 8; pageNo++) {
    const rows = await readRowsRaw(dlg);
    for (const r of rows) if (!seen.some((x) => x.no === r.no)) seen.push(r);

    const exact = rows.filter((r) => r.name === name);
    if (exact.length > 1) {
      throw new Error(`這一頁就有 ${exact.length} 個「${name}」（${exact.map((h) => h.no).join("、")}），請給工號或更完整的資訊`);
    }
    if (exact.length === 1) return selectRow(exact[0]);       // 完全相符 → 當場選，不再翻

    if (!(await gotoPage(pageNo + 1))) break;
  }

  // 沒有完全相符 → 試「名單上的名字包含使用者給的字」（例如「冠羣」→「韋冠羣」）。
  // 這時整份名單已經在 seen 裡了（上面每一頁都收過），可以確認是不是唯一。
  const loose = seen.filter((r) => r.name.includes(name));
  if (loose.length > 1) {
    throw new Error(`「${name}」對到 ${loose.length} 個人（${loose.map((h) => h.name).join("、")}），請給完整的本名`);
  }
  if (!loose.length) {
    // ⚠️ 這個清單是「照登入帳號的權限」給的，不是全公司。
    // 實測：電競行銷部的帳號看不到電競選手部的人。所以最常見的原因不是名字打錯，
    // 而是「這個帳號沒有權限幫這個人上單」—— 訊息一定要講清楚。
    throw new Error(
      `你的 EasyFlow 帳號在選人清單裡看不到「${name}」。`
      + `這個清單是照權限給的（幫選手上單要用戰隊主管的帳號，一般同事的帳號看不到選手）。`
      + `目前看得到的人：${seen.map((r) => r.name).join("、")}`);
  }

  const target = loose[0];
  say(`${name} → ${target.name}（用部分比對）`);

  // 上面已經翻到最後一頁了，要先回第 1 頁再往後找那個人（踩過：不回去一定翻不到）
  await gotoPage(1);
  for (let i = 1; i <= 8; i++) {
    const rows = await readRowsRaw(dlg);
    const hit = rows.find((r) => r.no === target.no);
    if (hit) return selectRow(hit);
    if (!(await gotoPage(i + 1))) break;
  }
  throw new Error(`翻不到「${target.name}」所在的那一頁`);
}

/* 選人視窗沒關掉的話會遮住表單，下一個人就整個做不了事。
   關法跟假別選擇器一樣：點框裡那個「×」（Escape 沒用）。 */
async function closePicker(page, fp) {
  try { await fp.getByText("×", { exact: true }).first().click({ force: true, timeout: 3000 }); } catch { /* 沒開或已經關了 */ }
  await page.waitForTimeout(1500);
}

/* 選假別（只有請假單有）。打字會被擋，只能用選擇器。 */
async function pickLeaveType({ page, fp, form, code }) {
  await fp.click(`#${form.f.code}_btn_icon`, { force: true });
  await page.waitForTimeout(5000);
  const dlg = page.frames().find((f) => f.name() === "dialogIframe" || f.url().includes("F2Single_Simple"));
  if (!dlg) throw new Error("假別選擇器沒有開啟");

  const findRow = () => dlg.$$eval("tr", (trs, c) => {
    for (let i = 0; i < trs.length; i++) {
      const cells = Array.from(trs[i].querySelectorAll("td")).map((td) => (td.innerText || "").trim());
      if (cells.includes(c)) return i;
    }
    return -1;
  }, code);

  let idx = await findRow();
  for (let p = 2; idx < 0 && p <= 3; p++) {        // 清單分 3 頁
    const link = dlg.locator("a").filter({ hasText: String(p) }).last();
    if (!(await link.count())) break;
    await link.click({ force: true });
    await page.waitForTimeout(3500);
    idx = await findRow();
  }
  if (idx < 0) throw new Error(`清單中找不到假別代碼 ${code}`);
  await dlg.locator("tr").nth(idx).click();
  await page.waitForTimeout(4500);
  const got = await fp.inputValue(`#${form.f.code}_txt`).catch(() => "");
  if (got !== code) throw new Error(`假別沒有選中（目前是「${got}」）`);
}

/* 按「草稿儲存」。
 * ⚠️ 只按草稿儲存，永遠不按旁邊那顆「傳送」（那個是送去簽核）。
 * 為什麼要存草稿：表單是同一個分頁，不存的話沒辦法接著填下一個人。 */
async function saveDraft({ page, outer, notes, say = () => {} }) {
  say("草稿儲存…");
  if (notes) notes.last = "";
  await outer.click(BTN_DRAFT, { force: true });
  // 系統存完會跳「儲存成功」的 alert，dialog handler 會接掉並記在 notes.last。
  // 等那句話出現就好，不用死等 13 秒。
  const ok = await until(() => notes && /儲存成功|成功/.test(notes.last || ""), { timeout: 40000, page });
  if (!ok) throw new Error("按了草稿儲存但沒有看到「儲存成功」" + (notes && notes.last ? `（系統說：${notes.last}）` : "，可能沒存進去"));
}

/* 批次代填：一次幫多位同事上同一種單。
 * 每個人都是「重開一張空白表單 → 選人 → 填 → 計算 → 草稿儲存」。
 * 一個人失敗不會中斷其他人，最後回報每個人的結果。 */
export async function fillBatch({ cfg, req, say = () => {}, onEach = () => {} }) {
  const form = FORMS[req.form];
  if (!form) throw new Error(`未知的單別：${req.form}`);

  const results = [];
  let lastFp = null;      // 上一位用的 framePlus，用來確認下一位拿到的是新的
  // 只登入一次，之後每個人重開分頁就好（登入一次要 10 秒，7 個人就差 1 分鐘）
  const ses = await login({ cfg, say });
  const browser = ses.browser;
  try {
    for (let i = 0; i < req.people.length; i++) {
      const name = req.people[i];
      const tag = `(${i + 1}/${req.people.length}) ${name}`;
      let tab = null;
      try {
        if (ses.notes) ses.notes.last = "";      // 上一個人的訊息不要帶到這個人身上
        // 每個人都重開一張空白單（重用同一個分頁，內容會清空）
        tab = await openFormTab({
          page: ses.page, tree: ses.tree, form: req.form, say: () => {},
          prevFp: lastFp,                     // 確認拿到的是重載後的新 frame，不是上一位的
        });
        lastFp = tab.fp;

        const who = await pickPerson({ page: ses.page, fp: tab.fp, form, name, say: (t) => say(`${tag} ${t}`) });

        if (form.f.code && req.code) {
          say(`${tag} 選假別 ${req.code}…`);
          await pickLeaveType({ page: ses.page, fp: tab.fp, form, code: req.code });
        }

        say(`${tag} 填日期與原因…`);
        // ⚠️ 時間沒指定就不要碰那兩個欄位。
        // EasyFlow 會照「那個人的班別」自動帶上班時間 —— 選手是 12:00~22:00、
        // 一般同事是 09:00~18:00。我們自己硬填 09:00~18:00 會把選手的單填錯。
        for (const [key, v] of [["startD", req.start], ["startT", req.startT],
                                ["endD", req.end], ["endT", req.endT], ["reason", req.reason || ""]]) {
          if (key === "startT" || key === "endT") { if (!v) continue; }
          await tab.fp.fill(`#${form.f[key]}_txt`, v);
        }

        say(`${tag} 計算時數…`);
        if (ses.notes) ses.notes.last = "";
        await tab.fp.click("#btnCount");
        // 等時數算出來，或系統跳訊息說算不出來（例如可休時數不足）
        // 上限刻意壓短：算得出來通常 1~3 秒。算不出來的時候（假日、班表沒產生）
        // 系統不一定會跳訊息，欄位就一直空著 —— 等滿 30 秒只是白等。
        await until(async () => {
          const h = await tab.fp.inputValue(`#${form.f.hours}_txt`);
          return (h && parseFloat(h) > 0) || (ses.notes && ses.notes.last);
        }, { timeout: 12000, page: ses.page });
        const hours = await tab.fp.inputValue(`#${form.f.hours}_txt`).catch(() => "");
        // 回報實際用了什麼時間（沒指定的話就是系統照班別帶的），使用者才知道填了什麼
        const usedST = await tab.fp.inputValue(`#${form.f.startT}_txt`).catch(() => "");
        const usedET = await tab.fp.inputValue(`#${form.f.endT}_txt`).catch(() => "");

        // 算不出時數的單根本送不出去，不要存草稿。
        // EasyFlow 通常會用 alert 講原因（可休時數不足、那天沒有上班時段…），有就照抄。
        if (!hours || !(parseFloat(hours) > 0)) {
          const why = ses.notes && ses.notes.last ? ses.notes.last : "";
          throw new Error(why
            ? `算不出時數：${why}`
            : "算出來是 0 小時 —— 那個時段沒有可以計算的上班時間（假日、連假，或班表還沒產生）");
        }

        await saveDraft({ page: ses.page, outer: tab.outer, notes: ses.notes, say: (t) => say(`${tag} ${t}`) });

        const one = { name, no: who.no, dep: who.dep, hours, startT: usedST, endT: usedET, ok: true, error: "" };
        results.push(one);
        onEach(one);
        say(`${tag} ✓ 已存草稿（${usedST}~${usedET}，${hours} 小時）`);
      } catch (e) {
        const msg = String(e && e.message ? e.message : e);
        const one = { name, no: "", dep: "", hours: "", startT: "", endT: "", ok: false, error: msg.slice(0, 200) };
        results.push(one);
        onEach(one);
        say(`${tag} ✗ ${one.error}`);

        // 瀏覽器被關掉了（使用者自己關、或當掉）就不要硬跑 ——
        // 後面每個人都會吐一樣的莫名錯誤，看了只會更困惑。
        if (/has been closed|Target (page|closed)/i.test(msg)) {
          const rest = req.people.slice(i + 1);
          for (const n of rest) {
            const skip = { name: n, no: "", dep: "", hours: "", startT: "", endT: "", ok: false, error: "瀏覽器被關掉了，這位沒有處理到" };
            results.push(skip);
            onEach(skip);
          }
          say(`瀏覽器已經關掉，剩下的 ${rest.length} 位沒跑。請再跑一次。`);
          break;
        }

        // 選人視窗可能還開著，會遮住下一個人的表單 —— 關掉它
        try { await closePicker(ses.page, tab && tab.fp ? tab.fp : null); } catch { /* ignore */ }

        // EasyFlow 的 session 逾時了就不要硬跑下去 —— 後面每個人都會失敗，
        // 而且錯誤訊息會很莫名。直接停下來，把已完成的回報出去，叫人重跑剩下的。
        if (ses.notes && /Session過期|重新登入/.test(ses.notes.last || "")) {
          const rest = req.people.slice(i + 1);
          for (const n of rest) {
            const skip = { name: n, no: "", dep: "", hours: "", ok: false, error: "EasyFlow 連線逾時，這位沒有處理到" };
            results.push(skip);
            onEach(skip);
          }
          say(`EasyFlow 連線逾時，剩下的 ${rest.length} 位沒跑。請再跑一次。`);
          break;
        }
      }
    }
    return { browser, results };
  } catch (e) {
    if (browser) { try { await browser.close(); } catch { /* ignore */ } }
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
  const ses = await openForm({ cfg, form: "leave", say });
  const { browser, page, fp } = ses;

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

  say("填日期與原因…");
  // ⚠️ 時間沒指定就不要碰。EasyFlow 會照那個人的班別帶（選手 12:00~22:00、
  // 一般同事 09:00~18:00），硬填會填錯。
  for (const [id, v] of [["ESSQJ021_txt", req.start], ["ESSQJ022_txt", req.startT],
                         ["ESSQJ023_txt", req.end], ["ESSQJ024_txt", req.endT],
                         ["ESSQJ026_txt", req.reason || ""]]) {
    if ((id === "ESSQJ022_txt" || id === "ESSQJ024_txt") && !v) continue;
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
    const why = ses.notes && ses.notes.last ? ses.notes.last : "";
    const err = new Error(why
      ? `EasyFlow 算不出時數：${why}。表單留在畫面上，你可以直接改再按「計算」。`
      : "EasyFlow 算出來是 0 小時，那個時段沒有需要請假的上班時間 —— 可能是假日、國定假日/連假，或那天的班表還沒產生。表單留在畫面上，你可以直接改日期再按「計算」。");
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
