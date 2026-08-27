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
    idPrefix: "ESSQJ",          // 這張單所有欄位 id 的開頭（截圖時用來框出表單範圍）
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
    idPrefix: "ESSJBDX",
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

/* 🚨 真正的送出鈕。按下去表單就進簽核流程，收不回來。
 *
 * 驗證方式：開一張完全空白的請假單按下去，系統依序跳
 *   ① 事後補假單時，請務必於備註欄位載明請假事由。   （例行提示）
 *   ② 是否確定將填寫好的表單傳送出去?               （確認框）
 *   ③ 假別還沒有選喔~                              （被擋下來）
 * 所以這顆確實是送出，而且沒填完的單系統自己會擋。
 *
 * ⚠️ 注意②那個確認框：我們的 dialog handler 會自動按確定。
 * 也就是說**唯一的保護就是「除非使用者明講要送出，否則永遠不呼叫 sendForm()」**。
 * 這支檔案裡只有 sendForm() 會碰它，其他地方一律用 BTN_DRAFT。
 */
const BTN_SEND = "#MasterPage_btnPreCreateToolSendForm";

/* 草稿資料匣。清單上每個儲存格的 onclick 是
 *   LoadBoxItem("ESSF07","EPI/EPIE001/EPIE001.aspx?FormID=ESSF07","Create","AutoNumber","請假申請","2026/08/27 11:34:40")
 * 主旨欄一律是「此欄不需填寫」，所以**只能靠「填表日期時間」辨識是哪一張**。 */
const DRAFT_BOX = { url: "../FormBox/LoadBox.aspx", id: "LoadBox", title: "草稿資料匣", w: "71" };

/* 唯讀查詢。按鈕 id 與跳出來的資料頁都是實際點過確認的。
 * ⚠️ **同一個 id 在不同單上意思不一樣**，不要共用：
 *     請假單(ESSF07) 的 #btnRecord   ＝ 請假記錄
 *     加班調休單(ESSF06) 的 #btnRecord ＝ 可休時數（也就是補休時數）
 * 所以每一種查詢都要記清楚「開哪張單、按哪顆」。 */
export const QUERIES = {
  balance: { label: "可休時數", form: "leave", btn: "#btnDetail", page: "ESSF07_Detail.aspx" },
  history: { label: "請假記錄", form: "leave", btn: "#btnRecord", page: "ESSF07_Record.aspx" },
  punch: { label: "刷卡記錄", form: "leave", btn: "#btnCardRecord", page: "ESSF07_EmpRankRecord.aspx" },
  // 補休（加班換來的假）：欄位有加班時間、每筆調休時間、實際已調休、調休截止日期…
  comp: { label: "補休時數", form: "overtime", btn: "#btnRecord", page: "ESSF06_Record.aspx" },
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
    // 等登入欄位長出來就好（原本固定等 2 秒，實測通常 0.5 秒內）
    const lf = await until(async () => {
      const f = page.frames().find((x) => x.url().includes("EFDBLogin")) || page.mainFrame();
      return (await f.locator("#txtName").count()) ? f : null;
    }, { timeout: 30000, page });
    if (!lf) throw new Error("登入頁沒有出現（公司系統連不上，或網址設錯了）");
    await lf.fill("#txtName", cfg.easyflowUser);
    // 密碼直接填進欄位就好：頁面自己會用 RSA 加密後才送出（hdPublicKeyExponent/hdEncrypted）。
    // 也正是因為這樣，才沒辦法在伺服器端單純 POST 登入。
    await lf.fill("#txtPassword", cfg.easyflowPass);
    await lf.click("#imgBtnLogin");

    /* 原本固定等 7 秒 + 4 秒。改成等真正的完成訊號，但**不能只等 frame 出現** ——
     * ⚠️ 實測：contents1 這個 frame 會先出現，約 3.4 秒後才換成真正的內容。
     * 在那之前呼叫 createTab，等於打在馬上要被丟掉的舊文件上，單子完全開不起來
     * （症狀：「請假申請單沒有開起來」）。踩過，所以這裡要確認樹真的載完。
     * 另外實測：切模組那個下拉**不會 postback**（樹本來就含所有表單連結），
     * 所以切完幾乎立刻就能用，原本那 4 秒也是白等。 */
    const treeReady = (needModule) => until(async () => {
      const f = page.frames().find((x) => x.name() === "contents1");
      if (!f || f.isDetached()) return null;
      const ok = await f.evaluate((m) => {
        if (document.readyState !== "complete") return null;
        const el = document.getElementById("ddlModule");
        if (!el) return null;                                  // 樹還沒長好
        if (m && el.value !== m) return null;                  // 模組還沒切過去
        // eslint-disable-next-line no-undef
        return (!m || typeof createTab === "function") ? true : null;
      }, needModule ? ESS_MODULE : "");
      return ok ? f : null;
    }, { timeout: 45000, step: 300, page });

    let tree = await treeReady(false);
    if (!tree) {
      if (!page.frames().find((f) => f.name() === "banner")) {
        throw new Error("登入失敗（帳號密碼錯誤，或公司系統異常）");
      }
      throw new Error("左邊的功能樹（contents1）一直沒有載完");
    }

    /* ⚠️ 樹載完了還不夠。右邊「放表單分頁」的那幾個 frame（framedefault / framehome）
     * 要再晚 1~2 秒才出現，在那之前呼叫 createTab **不會報錯、但什麼都不會開**。
     * 實測過：回傳一切正常，然後等 20 秒也等不到 frameESSF07。
     * 這是把登入的死等改成輪詢時踩到的坑 —— 沒有這一步，開單一定失敗。 */
    await until(async () => {
      const f = page.frames().find((x) => /^frame(default|home)$/.test(x.name() || ""));
      if (!f || f.isDetached()) return null;
      return await f.evaluate(() => (document.readyState === "complete" ? true : null));
    }, { timeout: 30000, step: 250, page });

    // 切到 ESS PLUS 模組（這些單都在這個模組底下）。已經選好時不會有反應，不算錯。
    try { await tree.selectOption("#ddlModule", ESS_MODULE); } catch { /* 沒有這個下拉、或已經選好了 */ }
    tree = (await treeReady(true)) || tree;

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
  const fire = () => tree.evaluate(({ url, formId, title }) => {
    // eslint-disable-next-line no-undef
    if (typeof createTab !== "function") throw new Error("這個頁面沒有 createTab");
    // eslint-disable-next-line no-undef
    createTab(url, formId, title, "107");
  }, { url: f.url, formId: f.formId, title: f.title });
  await fire();

  // ⚠️ 開過同一張單時這 3 秒不能省：系統會先問「頁籤已存在要不要重載」
  // （dialog handler 自動接受），重載才開始。太早去抓 frame 會抓到「還沒被換掉的舊表單」，
  // 之後點放大鏡完全沒反應（症狀：「選人視窗沒有開起來」）。踩過。
  // 但**第一次開**（beforeFp 是 null）根本不會有那個對話框，那 3 秒是純白等。
  await page.waitForTimeout(beforeFp ? 3000 : 600);

  // 等到「重載後的新 framePlus，而且是一張空白單」。
  // 條件連續成立兩次才算 —— 載入中途讀得到值但馬上又被換掉。
  let lastFp = null;
  let stable = 0;
  let tries = 1;
  let firedAt = Date.now();
  const got = await until(async () => {
    const t = pick();
    if (!t || t.fp.isDetached()) {
      stable = 0;
      /* ⚠️ createTab 偶爾「呼叫成功但什麼都沒開」，而且不會拋錯。
       * 實測過：右邊放表單分頁的那些 frame 還沒準備好時就會這樣，
       * 呼叫回傳一切正常，然後等 20 秒也等不到 frameESSF07。
       * 用哪個訊號判斷「準備好了」都不夠可靠，所以乾脆再叫一次 ——
       * 反正真的開起來了就不會走到這裡。 */
      if (tries < 4 && Date.now() - firedAt > 6000) {
        tries += 1; firedAt = Date.now();
        say(`${f.label}單沒反應，再開一次…`);
        await fire().catch(() => { /* 樹壞了的話下面會逾時報錯 */ });
      }
      return null;
    }
    if (beforeFp && t.fp === beforeFp) { stable = 0; return null; }   // 還是舊的，reload 還沒完成
    const person = await t.fp.inputValue(`#${f.f.person}_txt`);
    if (!person) { stable = 0; return null; }
    const hours = await t.fp.inputValue(`#${f.f.hours}_txt`);
    if (hours) { stable = 0; return null; }                            // 上一張單還沒清掉
    if (lastFp === t.fp) stable += 1; else { lastFp = t.fp; stable = 0; }
    return stable >= 2 ? t : null;
  }, { timeout: 45000, step: 400, page });

  if (!got) {
    if (!pick()) throw new Error(`${f.label}單沒有開起來（試了 ${tries} 次）`);
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
  // 等視窗真的有清單（原本固定等 5 秒，實測 1 秒內就好）
  const dlg = await until(async () => {
    const d = page.frames().find((f) => f.name() === "dialogIframe" || f.url().includes("F2Single_Simple"));
    if (!d || d.isDetached()) return null;
    return (await d.locator("tr").count()) > 2 ? d : null;
  }, { timeout: 25000, page });
  if (!dlg) throw new Error("假別選擇器沒有開啟");

  // 翻頁沒有明確的完成訊號，只能看「清單內容有沒有換掉」
  const peek = () => dlg.evaluate(() => document.body.innerText.slice(0, 400)).catch(() => "");

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
    const was = await peek();
    await link.click({ force: true });
    await until(async () => (await peek()) !== was, { timeout: 9000, step: 250, page });
    idx = await findRow();
  }
  if (idx < 0) throw new Error(`清單中找不到假別代碼 ${code}`);
  await dlg.locator("tr").nth(idx).click();
  // 選完會 postback 把假別帶回表單。等欄位真的變成那個代碼（原本固定等 4.5 秒，實測約 1 秒）。
  // 中途 fp 可能正在重載、讀欄位會炸 —— until 會把例外當成「還沒好」。
  const got = await until(async () => (await fp.inputValue(`#${form.f.code}_txt`)) === code,
                          { timeout: 25000, step: 250, page });
  if (!got) {
    const now = await fp.inputValue(`#${form.f.code}_txt`).catch(() => "");
    throw new Error(`假別沒有選中（目前是「${now}」）`);
  }
}

/* 按「草稿儲存」。
 * ⚠️ 只按草稿儲存，永遠不按旁邊那顆「傳送」（那個是送去簽核）。
 * 為什麼要存草稿：表單是同一個分頁，不存的話沒辦法接著填下一個人。 */
export async function saveDraft({ page, outer, notes, say = () => {} }) {
  say("草稿儲存…");
  if (notes) notes.last = "";
  await outer.click(BTN_DRAFT, { force: true });
  // 系統存完會跳「儲存成功」的 alert，dialog handler 會接掉並記在 notes.last。
  // 等那句話出現就好，不用死等 13 秒。
  const ok = await until(() => notes && /儲存成功|成功/.test(notes.last || ""), { timeout: 40000, page });
  if (!ok) throw new Error("按了草稿儲存但沒有看到「儲存成功」" + (notes && notes.last ? `（系統說：${notes.last}）` : "，可能沒存進去"));
}

/* 🚨 按「傳送」把表單送進簽核流程。**不可逆**。
 * 只有在使用者明確選了「確定發送」時才會走到這裡。 */
export async function sendForm({ page, outer, notes, say = () => {} }) {
  say("傳送…");
  if (notes) notes.last = "";
  await outer.click(BTN_SEND, { force: true });

  // 送出會經過一個「是否確定將填寫好的表單傳送出去?」的確認框（handler 自動接受），
  // 然後才是結果。等到出現「不是那個確認框」的訊息，或表單被收掉為止。
  await until(() => {
    const m = (notes && notes.last) || "";
    return m && !/是否確定|事後補假單/.test(m);
  }, { timeout: 40000, page });

  const msg = (notes && notes.last) || "";
  // 沒填完的單系統會擋（例如「假別還沒有選喔~」），那不是成功
  if (/還沒|不足|不存在|錯誤|失敗|請選|不可|無法/.test(msg)) {
    throw new Error("EasyFlow 擋下來了：" + msg);
  }
  return msg;
}

/* 打開草稿資料匣，回傳目前所有草稿（用「填表日期時間」當識別）。 */
export async function listDrafts({ page, tree, say = () => {} }) {
  say("打開草稿資料匣…");
  const fire = () => tree.evaluate((b) => {
    // eslint-disable-next-line no-undef
    createTab(b.url, b.id, b.title, b.w);
  }, DRAFT_BOX);
  await fire();
  await page.waitForTimeout(1200);

  // ⚠️ 跟開表單一樣：createTab 偶爾呼叫成功但什麼都沒開，不會報錯。
  // 這裡沒開起來的後果是「跑前的草稿清單」變成空的 → 最後數量對不上 → 整批不給送。
  // 實測踩過，所以一樣要會重試。
  let tries = 1;
  let firedAt = Date.now();
  const box = await until(async () => {
    const f = page.frames().find((x) => x.name() === "frameLoadBox" || x.url().includes("LoadBox.aspx"));
    if (f && !f.isDetached()) return f;
    if (tries < 4 && Date.now() - firedAt > 5000) {
      tries += 1; firedAt = Date.now();
      say("草稿資料匣沒反應，再開一次…");
      await fire().catch(() => { /* 下面會逾時報錯 */ });
    }
    return null;
  }, { timeout: 30000, page });
  if (!box) throw new Error(`草稿資料匣沒有開起來（試了 ${tries} 次）`);

  const rows = await until(async () => {
    const r = await box.evaluate(() => {
      // 用「填表日期時間」定位資料表 —— 篩選器那張表也含「主旨」，會抓錯
      const t = Array.from(document.querySelectorAll("table")).find((x) => /填表日期時間/.test(x.innerText));
      if (!t) return null;
      return Array.from(t.querySelectorAll("tr"))
        .map((tr) => Array.from(tr.querySelectorAll("td")).map((td) => (td.innerText || "").trim()))
        .filter((c) => c.length >= 4 && /^\d{4}\/\d{2}\/\d{2}/.test(c[2] || ""))
        .map((c) => ({ subject: c[1], when: c[2], formName: c[3] }));
    });
    return r || null;
  }, { timeout: 25000, page });

  return { box, rows: rows || [] };
}

/* 從草稿匣打開指定的那一張（用填表日期時間比對），回傳表單的 frame。 */
async function openDraft({ page, box, when, say = () => {} }) {
  say(`打開草稿 ${when}…`);
  const cell = box.locator("td").filter({ hasText: when }).first();
  if (!(await cell.count())) throw new Error(`草稿匣裡找不到 ${when} 這張`);
  await cell.click({ force: true });
  await page.waitForTimeout(3000);

  const found = await until(() => {
    const outer = page.frames().find((f) => /^frameESSF/.test(f.name() || ""));
    if (!outer || outer.isDetached()) return null;
    const fp = outer.childFrames().find((f) => f.name() === "framePlus");
    return fp ? { outer, fp } : null;
  }, { timeout: 40000, page });
  if (!found) throw new Error(`草稿 ${when} 打不開`);
  return found;
}

/* 🚨 把指定的幾張草稿送出去。**不可逆**。
 * whens = 填表日期時間的陣列（listDrafts 回傳的那個 when）。 */
export async function sendDrafts({ cfg, whens, say = () => {}, onEach = () => {}, session = null }) {
  const ses = session || await login({ cfg, say });
  const results = [];
  try {
    for (let i = 0; i < whens.length; i++) {
      const when = whens[i];
      const tag = `(${i + 1}/${whens.length})`;
      try {
        const { box } = await listDrafts({ page: ses.page, tree: ses.tree, say: () => {} });
        const { outer } = await openDraft({ page: ses.page, box, when, say: (t) => say(`${tag} ${t}`) });
        const msg = await sendForm({ page: ses.page, outer, notes: ses.notes, say: (t) => say(`${tag} ${t}`) });
        const one = { when, ok: true, error: "", msg };
        results.push(one); onEach(one);
        say(`${tag} ✓ 已送出`);
      } catch (e) {
        const one = { when, ok: false, error: String(e && e.message ? e.message : e).slice(0, 200), msg: "" };
        results.push(one); onEach(one);
        say(`${tag} ✗ ${one.error}`);
      }
    }
    return { browser: ses.browser, results };
  } catch (e) {
    if (!session && ses.browser) { try { await ses.browser.close(); } catch { /* ignore */ } }
    throw e;
  }
}

/* 批次代填：一次幫多位同事上同一種單。
 * 每個人都是「重開一張空白表單 → 選人 → 填 → 計算 → 草稿儲存」。
 * 一個人失敗不會中斷其他人，最後回報每個人的結果。 */
export async function fillBatch({ cfg, req, say = () => {}, onEach = () => {} }) {
  const form = FORMS[req.form];
  if (!form) throw new Error(`未知的單別：${req.form}`);

  const results = [];
  // 每個人的截圖先收在這裡，**全部跑完才一起傳回去**。
  // 為什麼不邊跑邊傳：使用者要的是最後一次看完全部，一張一張跳出來只會洗版；
  // 而且 Realtime 一則訊息有大小上限（約 256KB），人數不固定（7、8、9 位都可能），
  // 全部塞進同一則一定會爆 —— 所以是「最後才傳，但一個人一則」。
  const shots = [];
  let lastFp = null;      // 上一位用的 framePlus，用來確認下一位拿到的是新的
  // 只登入一次，之後每個人重開分頁就好（登入一次要 10 秒，7 個人就差 1 分鐘）
  const ses = await login({ cfg, say });
  const browser = ses.browser;

  // 跑之前先記下草稿匣裡已經有哪些 —— 跑完再看一次，多出來的就是這批。
  // 為什麼要這樣：草稿清單的「主旨」欄一律是「此欄不需填寫」，看不出是誰的，
  // 只能靠「填表日期時間」辨識。用差集才不會誤送到使用者本來就有的舊草稿。
  let before = [];
  try {
    const b = await listDrafts({ page: ses.page, tree: ses.tree, say: () => {} });
    before = b.rows.map((r) => r.when);
  } catch { /* 拿不到就算了，最後只是沒辦法提供「一起送出」 */ }

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

        // 趁表單還填著的時候截圖（存完草稿畫面會被收掉）。截不到就是空字串，不影響上單。
        const shot = await snapForm(ses.page, tab.fp, form);
        if (shot) shots.push({ name, no: who.no, shot });

        await saveDraft({ page: ses.page, outer: tab.outer, notes: ses.notes, say: (t) => say(`${tag} ${t}`) });

        const one = { name, no: who.no, dep: who.dep, hours, startT: usedST, endT: usedET, ok: true, error: "", draft: "" };
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
    // 跑完看看多了哪些草稿，依時間排序後配給「有成功存檔」的人（順序一致）
    try {
      const a = await listDrafts({ page: ses.page, tree: ses.tree, say: () => {} });
      const fresh = a.rows.map((r) => r.when).filter((w) => !before.includes(w)).sort();
      const okOnes = results.filter((r) => r.ok);
      if (fresh.length === okOnes.length) {
        okOnes.forEach((r, i) => { r.draft = fresh[i]; });
      } else {
        // 數量對不上就不要亂配 —— 寧可不給「一起送出」，也不能送錯人的單
        say(`草稿匣多了 ${fresh.length} 張、成功 ${okOnes.length} 位，數量對不上，這批不提供一起送出`);
      }
    } catch { /* 拿不到就沒有 draft 欄位，UI 會自動不顯示送出 */ }

    return { browser, results, shots };
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
  // 單張也可以是加班調休（ESSF06）—— 幫自己填，不用選人（表單預設就是登入的人）。
  const kind = req.form === "overtime" ? "overtime" : "leave";
  const ses = await openForm({ cfg, form: kind, say });
  const { browser, page, fp } = ses;
  const form = FORMS[kind];

  if (form.f.code) {
    // 假別只能用選擇器選，打字會被擋（系統會跳「假別還沒有選喔~」）
    say(`選假別 ${req.code}…`);
    await pickLeaveType({ page, fp, form, code: req.code });
  }

  say("填日期與原因…");
  // ⚠️ 時間沒指定就不要碰。EasyFlow 會照那個人的班別帶（選手 12:00~22:00、
  // 一般同事 09:00~18:00），硬填會填錯。
  for (const [key, v] of [["startD", req.start], ["startT", req.startT],
                          ["endD", req.end], ["endT", req.endT], ["reason", req.reason || ""]]) {
    if ((key === "startT" || key === "endT") && !v) continue;
    await fp.fill(`#${form.f[key]}_txt`, v);
  }

  say("計算時數…");
  if (ses.notes) ses.notes.last = "";
  await fp.click("#btnCount");
  // 等時數算出來，或系統跳訊息說算不出來（原本固定等 5 秒）。
  // 上限壓短：算得出來通常 1~3 秒；算不出來時系統不一定會講話，欄位就一直空著。
  await until(async () => {
    const h = await fp.inputValue(`#${form.f.hours}_txt`);
    return (h && parseFloat(h) > 0) || (ses.notes && ses.notes.last);
  }, { timeout: 12000, page });
  const hours = await fp.inputValue(`#${form.f.hours}_txt`).catch(() => "");
  // 天數/假別名稱只有請假單有，加班調休單沒有這兩個欄位
  const days = form.f.days ? await fp.inputValue(`#${form.f.days}_txt`).catch(() => "") : "";
  const typeName = form.f.typeName
    ? await fp.inputValue(`#${form.f.typeName}_txt`).catch(() => "")
    : form.label;
  const shot = await snapForm(page, fp, form);

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
    err.session = { page, outer: ses.outer, notes: ses.notes };
    err.shot = shot;
    throw err;
  }

  // page / outer / notes 一起回傳：填完之後使用者要選「確定發送 / 儲存草稿 / 取消」，
  // 那些操作都要在這張還開著的表單上做。
  return { browser, page, outer: ses.outer, notes: ses.notes, typeName, hours, days, shot };
}

/* 唯讀查詢：點三顆按鈕之一，把跳出來的表格讀成 cols + rows。
 * 完全不碰任何輸入欄位。 */
export async function runQuery({ cfg, kind, say = () => {} }) {
  const meta = QUERIES[kind];
  if (!meta) throw new Error(`未知的查詢類型：${kind}`);
  const { browser, page, fp } = await openForm({ cfg, form: meta.form || "leave", say });
  try {
    say(`讀取「${meta.label}」…`);
    await fp.click(meta.btn, { force: true });
    // 等結果表格真的長出來（原本固定等 9 秒）
    const dlg = await until(async () => {
      const d = page.frames().find((f) => f.url().includes(meta.page));
      if (!d || d.isDetached()) return null;
      return (await d.locator("tr").count()) > 1 ? d : null;
    }, { timeout: 30000, page });
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
async function snapForm(page, fp, form) {
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
    // ⚠️ 欄位 id 的開頭每張單不一樣（請假 ESSQJ、加班調休 ESSJBDX）。
    // 寫死 ESSQJ 的話，批次代填那張加班調休單會一個欄位都框不到、整張截歪。
    const r = await fp.evaluate((pfx) => {
      const els = Array.from(document.querySelectorAll(`input[id^="${pfx}"], textarea[id^="${pfx}"]`))
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
    }, (form && form.idPrefix) || "ESSQJ");

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
