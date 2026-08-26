/* 設定檔讀寫。
 *
 * 存在 %APPDATA%\EasyFlowBridge\config.json，**不放在程式目錄**——
 * 這樣更新程式（換一包新的）不會把設定弄掉。
 *
 * 公司密碼用 Windows 內建的 DPAPI 加密（透過 PowerShell，不需要裝任何套件）。
 * DPAPI 綁「這台電腦 + 這個 Windows 帳號」，所以 config.json 被複製到別台電腦
 * 也解不開。這不是萬無一失（同一個帳號登入的程式都能解），但比純文字好太多。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

export const DIR = path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "EasyFlowBridge");
export const FILE = path.join(DIR, "config.json");

const PS = "powershell";
const psArgs = (script) => ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script];

// 加密：回一段很長的 hex（DPAPI 的產物）
export function encrypt(plain) {
  const b64 = Buffer.from(String(plain), "utf8").toString("base64");
  const script =
    `$b=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}'));` +
    `($b | ConvertTo-SecureString -AsPlainText -Force | ConvertFrom-SecureString)`;
  return execFileSync(PS, psArgs(script), { encoding: "utf8", windowsHide: true }).trim();
}

// 解密。換電腦或換 Windows 帳號會失敗 —— 這是刻意的，讓使用者重新設定。
export function decrypt(enc) {
  const script =
    `$s=ConvertTo-SecureString '${String(enc).replace(/'/g, "''")}';` +
    `$p=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s);` +
    `$t=[Runtime.InteropServices.Marshal]::PtrToStringAuto($p);` +
    `[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p);` +
    `[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($t))`;
  const out = execFileSync(PS, psArgs(script), { encoding: "utf8", windowsHide: true }).trim();
  return Buffer.from(out, "base64").toString("utf8");
}

export function exists() {
  return fs.existsSync(FILE);
}

// 只讀不機密的欄位，**不解密密碼**。
// 解密要叫 PowerShell（約半秒），而「開視窗」這件事等不起 —— 但它需要知道
// 使用者選了哪個瀏覽器。所以拆一個輕量版出來。
export function peek() {
  try {
    const r = JSON.parse(fs.readFileSync(FILE, "utf8"));
    return { email: r.email || "", easyflowUser: r.easyflowUser || "", browser: r.browser || "" };
  } catch { return {}; }
}

export function load() {
  const raw = JSON.parse(fs.readFileSync(FILE, "utf8"));
  return { ...raw, easyflowPass: decrypt(raw.easyflowPassEnc) };
}

export function save(cfg) {
  fs.mkdirSync(DIR, { recursive: true });
  const { easyflowPass, ...rest } = cfg;
  const out = { ...rest };
  if (easyflowPass !== undefined) out.easyflowPassEnc = encrypt(easyflowPass);
  fs.writeFileSync(FILE, JSON.stringify(out, null, 2), "utf8");
  // 只有自己讀得到（Windows 上 Node 的 chmod 效果有限，但至少表達意圖）
  try { fs.chmodSync(FILE, 0o600); } catch { /* ignore */ }
  return FILE;
}
