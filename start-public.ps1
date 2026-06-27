$ErrorActionPreference = "Stop"

$projectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$node = "C:\Users\jaesk\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
$ngrok = Join-Path $projectDir "tools\ngrok.exe"

Set-Location $projectDir

$portOwner = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue |
  Select-Object -First 1 -ExpandProperty OwningProcess

if ($portOwner) {
  Stop-Process -Id $portOwner -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 600
}

$oldNgrok = Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine -like "*ngrok.exe*http*3000*" }

foreach ($proc in $oldNgrok) {
  Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
}

Start-Process -FilePath $node -ArgumentList "server.js" -WorkingDirectory $projectDir -WindowStyle Hidden
Start-Sleep -Seconds 2

$job = Start-Job -ScriptBlock {
  Set-Location "C:\codex\song"
  .\tools\ngrok.exe http 3000
}

Start-Sleep -Seconds 8

$publicUrl = $null
try {
  $tunnels = Invoke-RestMethod -Uri "http://127.0.0.1:4040/api/tunnels"
  $publicUrl = ($tunnels.tunnels | Where-Object { $_.proto -eq "https" } | Select-Object -First 1).public_url
} catch {
  Write-Host "ngrok 還沒準備好，請等幾秒再試。"
}

Write-Host ""
Write-Host "Spotify 歌詞翻譯器已啟動"
Write-Host "電腦網址: http://127.0.0.1:3000"

if ($publicUrl) {
  Write-Host "手機/外網固定網址: $publicUrl"
  Start-Process $publicUrl
} else {
  Write-Host "外網網址讀取失敗。"
}

Write-Host ""
Write-Host "保持這個視窗開著。要關閉服務時，直接關掉這個視窗即可。"
while ($true) {
  Start-Sleep -Seconds 3600
}
