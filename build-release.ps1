# 打包成給同事的壓縮檔。
#
# 裡面包一份 portable Node（同事不用裝 Node.js），但**不包瀏覽器**——
# 我們用 playwright-core 驅動電腦上現成的 Edge/Chrome，所以不需要那 150MB 的 Chromium。
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
if ($LASTEXITCODE -ne 0) { throw "npm install 失敗" }
Pop-Location

Write-Host "== 複製程式檔 =="
foreach ($f in @("bridge.mjs", "easyflow.mjs", "config.mjs", "setup.mjs", "package.json", "README.md", "啟動.bat", "首次設定.bat")) {
  Copy-Item (Join-Path $root $f) -Destination $stage
}
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
Write-Host "解壓後雙擊「首次設定.bat」即可。"
