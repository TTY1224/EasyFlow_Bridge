# 打包成給同事的壓縮檔。
#
# 產物：EasyFlow-Bridge-win.zip，解壓後只要點「EasyFlow 橋接.vbs」。
#
# 裡面包一份 portable Node（同事不用裝 Node.js），但**不包瀏覽器**——
# 介面和 EasyFlow 操作都用電腦上現成的 Edge/Chrome，所以不需要那 150MB 的 Chromium。
#
# ⚠️ 為什麼啟動器是 .vbs 而不是 .exe：
#    Windows 11 的 Smart App Control 預設開啟，會擋掉所有沒有程式碼簽章的 exe
#    （實測就是這樣，訊息是「應用程式已被防止開啟此檔案」）。自己編的 exe 一定沒
#    簽章，除非花錢買憑證。.vbs 是交給 Windows 內建、微軟自己簽章的 wscript.exe
#    執行，所以不會被擋，而且一樣看不到小黑窗（Run 的視窗樣式給 0）。
#
# 用法： powershell -ExecutionPolicy Bypass -File build-release.ps1

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$out = Join-Path $root "_release"
$stage = Join-Path $out "EasyFlow-Bridge"
$nodeVer = "v22.14.0"          # 只要是 20 以上都可以

Write-Host "== 清空輸出目錄 =="
if (Test-Path $out) { Remove-Item $out -Recurse -Force }
New-Item -ItemType Directory -Path $stage -Force | Out-Null

Write-Host "== 安裝正式依賴（不含 devDependencies）=="
Push-Location $root
npm install --omit=dev --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { Pop-Location; throw "npm install 失敗" }
Pop-Location

Write-Host "== 複製程式檔 =="
$files = @(
  "開始使用.bat",         # 使用者唯一要點的東西（第一次）
  "EasyFlow_bridge.vbs",  # 實際的隱藏啟動器，由上面那支叫起來
  "app.mjs",             # 視窗介面
  "ui.html",
  "logo.png",
  "bridge.mjs",      # 命令列版（進階／mprocs 用）
  "core.mjs",
  "easyflow.mjs",
  "config.mjs",
  "verify.mjs",
  "setup.mjs",
  "package.json",
  "README.md"
)
foreach ($f in $files) { Copy-Item (Join-Path $root $f) -Destination $stage }
Copy-Item (Join-Path $root "node_modules") -Destination (Join-Path $stage "node_modules") -Recurse

Write-Host "== 下載 portable Node $nodeVer =="
$nodeZip = Join-Path $out "node.zip"
$nodeDir = Join-Path $stage "node"
Invoke-WebRequest -Uri "https://nodejs.org/dist/$nodeVer/node-$nodeVer-win-x64.zip" -OutFile $nodeZip
Expand-Archive -Path $nodeZip -DestinationPath $out -Force
New-Item -ItemType Directory -Path $nodeDir -Force | Out-Null
# 只要 node.exe，其他（npm、docs、headers）同事都用不到，省幾十 MB
Copy-Item (Join-Path $out "node-$nodeVer-win-x64\node.exe") -Destination $nodeDir
Remove-Item $nodeZip -Force
Remove-Item (Join-Path $out "node-$nodeVer-win-x64") -Recurse -Force

Write-Host "== 壓縮 =="
$zip = Join-Path $out "EasyFlow-Bridge-win.zip"
Compress-Archive -Path $stage -DestinationPath $zip -Force

$mb = [math]::Round((Get-Item $zip).Length / 1MB, 1)
Write-Host ""
Write-Host "完成： $zip  ($mb MB)" -ForegroundColor Green
Write-Host "解壓後點「開始使用.bat」就好（它會解除下載封鎖並在桌面放捷徑）。"
