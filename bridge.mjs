#!/usr/bin/env node
/* 命令列版（給 mprocs / 開發用）。一般使用者請開「EasyFlow 橋接.exe」，那個有視窗介面。 */
import * as cfgStore from "./config.mjs";
import { startBridge } from "./core.mjs";

const die = (s) => { console.error("\n✗ " + s + "\n"); process.exit(1); };

if (!cfgStore.exists()) die("還沒設定過。請先開「EasyFlow 橋接.exe」設定，或執行 node setup.mjs。");

let cfg;
try {
  cfg = cfgStore.load();
} catch (e) {
  die("設定讀不出來：" + (e?.message || e) +
      "\n  換了電腦或換了 Windows 帳號的話，密碼就解不開了（這是刻意的）。請重新設定。");
}

const ICON = { ok: "✓", err: "✗", warn: "⚠", task: "▶", info: " " };

let bridge;
try {
  bridge = await startBridge({
    cfg,
    onLog: ({ text, kind }) => console.log("  " + (ICON[kind] || " ") + " " + text),
    onState: ({ status }) => { if (status === "duplicate") setTimeout(() => process.exit(1), 500); },
  });
} catch (e) {
  die(String(e?.message || e));
}

console.log("");
console.log("  使用者：" + cfg.email + "　｜　EasyFlow 帳號：" + cfg.easyflowUser);
console.log("  ⚠ 只會「把單填好」，永遠不會替你按送出");
console.log("  （Ctrl+C 結束）");
console.log("");

process.on("SIGINT", async () => { await bridge?.stop(); process.exit(0); });
