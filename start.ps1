param(
  [ValidateSet('Menu', 'Gmail', 'Plan', 'Queue', 'Manual', 'Retry', 'CleanLock', 'Generate', 'Browser')]
  [string]$Mode = 'Menu',
  [string]$Email = '',
  [string]$Count = '',
  [string]$Domain = '',
  [ValidateSet('', 'normal', 'incognito')]
  [string]$BrowserMode = ''
)
$ErrorActionPreference = 'Stop'
$OutputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $OutputEncoding
Set-Location -LiteralPath $PSScriptRoot
if ($Mode -eq 'Menu') {
  $taskMenuModes = @{ '1' = 'Gmail'; '2' = 'Plan'; '3' = 'Queue'; '4' = 'Manual'; '5' = 'CleanLock'; '6' = 'Generate'; '7' = 'Browser' }
  while ($true) {
    Write-Host 'ChatGPT2API - Windows 账号注册队列'
    Write-Host '自动模式遇到人工验证、未知表单或取码失败直接跳过；结束后汇总结果。'
    Write-Host ''
    Write-Host '1. 连接 Gmail：首次进行只读授权'
    Write-Host '2. 预览账号队列和随机资料：不会开始注册'
    Write-Host '3. 全自动运行：需要人工操作则跳过，最后汇总'
    Write-Host '4. 手动接码运行：无需配置 Gmail'
    Write-Host '5. 清理队列锁：只删除失效的锁文件'
    Write-Host '6. 生成邮箱：输入数量和域名，追加到 accounts.txt'
    $taskBrowserLabel = '无痕（默认）'
    $taskBrowserSettings = Join-Path $PSScriptRoot '.local/browser-settings.json'
    if (Test-Path -LiteralPath $taskBrowserSettings) {
      try {
        $taskStoredMode = (Get-Content -LiteralPath $taskBrowserSettings -Raw -Encoding UTF8 | ConvertFrom-Json).mode
        if ($taskStoredMode -eq 'normal') { $taskBrowserLabel = '普通' }
        elseif ($taskStoredMode -eq 'incognito') { $taskBrowserLabel = '无痕' }
        else { $taskBrowserLabel = '设置无效，请重新选择' }
      } catch { $taskBrowserLabel = '设置无效，请重新选择' }
    }
    Write-Host "7. 选择浏览器模式：普通 / 无痕（当前：$taskBrowserLabel）"
    Write-Host '0. 退出程序'
    Write-Host ''
    $taskMenuSelection = (Read-Host '请输入选项 0 到 7，然后按回车').Trim()
    if ($taskMenuSelection -eq '0') { break }
    if (-not $taskMenuModes.ContainsKey($taskMenuSelection)) {
      Write-Host '选项无效，请输入 0 到 7。' -ForegroundColor Yellow
      continue
    }
    try {
      & $PSCommandPath -Mode $taskMenuModes[$taskMenuSelection]
    } catch {
      Write-Host $_.Exception.Message -ForegroundColor Red
    }
    Write-Host ''
    Write-Host '操作已结束，可继续选择其他功能。' -ForegroundColor Cyan
    Write-Host ''
  }
  exit 0
}
if ($Mode -eq 'CleanLock') {
  $taskLockFolder = Join-Path $PSScriptRoot '.local'
  $taskLockPath = Join-Path $taskLockFolder 'queue.lock'
  if (-not (Test-Path -LiteralPath $taskLockPath)) {
    Write-Host '没有发现队列锁文件，无需清理。'
    return
  }
  foreach ($taskLockTarget in @($taskLockFolder, $taskLockPath)) {
    if ((Get-Item -LiteralPath $taskLockTarget -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
      throw '锁路径包含链接，未删除。请检查本程序目录中的 .local/queue.lock。'
    }
  }
  $taskLockText = ([string](Get-Content -LiteralPath $taskLockPath -Raw -Encoding UTF8)).Trim()
  [int]$taskLockPid = 0
  if (-not [int]::TryParse($taskLockText, [ref]$taskLockPid) -or $taskLockPid -le 0) {
    throw '锁文件内容无法识别，未删除。请确认没有其他队列运行，再检查 .local/queue.lock。'
  }
  $taskLockAlive = $false
  try {
    $taskLockProcess = [Diagnostics.Process]::GetProcessById($taskLockPid)
    try { $taskLockAlive = -not $taskLockProcess.HasExited }
    finally { $taskLockProcess.Dispose() }
  } catch [ArgumentException] {
    $taskLockAlive = $false
  } catch {
    throw '无法确认锁所属进程是否已退出，未删除锁文件。'
  }
  if ($taskLockAlive) {
    throw "锁所属进程仍在运行（进程号 $taskLockPid），未删除。请先结束对应的队列任务。"
  }
  if (-not (Test-Path -LiteralPath $taskLockPath)) {
    Write-Host '锁文件已经释放，无需清理。'
    return
  }
  if (([string](Get-Content -LiteralPath $taskLockPath -Raw -Encoding UTF8)).Trim() -ne $taskLockText) {
    throw '锁文件在检查期间发生变化，未删除。请重新选择功能 5 检查。'
  }
  Remove-Item -LiteralPath $taskLockPath -Force
  Write-Host '已清理失效的队列锁。现在可以继续选择功能 1、2、3 或 4。' -ForegroundColor Green
  return
}
if ($Mode -in @('Generate', 'Browser')) {
  $taskConfig = [pscustomobject]@{ proxy = '' }
} else {
  $taskConfig = Get-Content -LiteralPath './config.json' -Raw -Encoding UTF8 | ConvertFrom-Json
}
$taskNode = Get-Command node -ErrorAction Stop
$taskVersion = & $taskNode.Source -p 'process.versions.node'
$taskParts = $taskVersion.Split('.')
if ([int]$taskParts[0] -lt 24 -or ([int]$taskParts[0] -eq 24 -and [int]$taskParts[1] -lt 5)) {
  throw '请安装 Node.js 24.5 或更高版本，再重新打开程序。'
}
$taskPreviousHttp = $env:HTTP_PROXY
$taskPreviousHttps = $env:HTTPS_PROXY
$taskPreviousNoProxy = $env:NO_PROXY
$taskPreviousKey = $env:CHATGPT2API_ADMIN_KEY
try {
  if ($taskConfig.proxy) {
    $env:HTTP_PROXY = $taskConfig.proxy
    $env:HTTPS_PROXY = $taskConfig.proxy
  }
  $env:NO_PROXY = 'localhost,127.0.0.1,::1'
  switch ($Mode) {
    'Gmail' { & $taskNode.Source --use-env-proxy './runner.mjs' --gmail-login }
    'Plan' { & $taskNode.Source --use-env-proxy './runner.mjs' --plan }
    'Generate' {
      if (-not $Count) { $Count = (Read-Host '请输入生成数量（1 到 10000）').Trim() }
      if (-not $Domain) { $Domain = (Read-Host '请输入自有邮箱域名，例如 jasonlat.cc').Trim() }
      & $taskNode.Source --use-env-proxy './runner.mjs' --generate $Count --domain $Domain
    }
    'Browser' {
      if (-not $BrowserMode) {
        Write-Host '1. 普通窗口：按邮箱保存独立的登录状态和浏览器资料'
        Write-Host '2. 无痕窗口：账号结束后销毁会话'
        Write-Host '0. 返回菜单'
        $taskBrowserChoice = (Read-Host '请选择浏览器模式 1 或 2').Trim()
        if ($taskBrowserChoice -eq '0') { return }
        if ($taskBrowserChoice -eq '1') { $BrowserMode = 'normal' }
        elseif ($taskBrowserChoice -eq '2') { $BrowserMode = 'incognito' }
        else { throw '选项无效，浏览器模式未修改。' }
      }
      & $taskNode.Source --use-env-proxy './runner.mjs' --set-browser-mode $BrowserMode
    }
    'Retry' {
      if (-not $Email) { throw '请指定需要重试的邮箱，例如：./start.ps1 Retry -Email name@your-domain.com' }
      & $taskNode.Source --use-env-proxy './runner.mjs' --retry $Email
    }
    { $_ -in @('Queue', 'Manual') } {
      if (-not $env:CHATGPT2API_ADMIN_KEY) {
        $taskSecret = Read-Host '请输入 ChatGPT2API 管理员密钥（输入内容隐藏）' -AsSecureString
        $taskPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($taskSecret)
        try { $env:CHATGPT2API_ADMIN_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($taskPointer) }
        finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($taskPointer) }
      }
      $taskBrowserArgs = @()
      if ($BrowserMode) { $taskBrowserArgs = @('--browser-mode', $BrowserMode) }
      if ($Mode -eq 'Manual') {
        & $taskNode.Source --use-env-proxy './runner.mjs' --run --manual-codes @taskBrowserArgs
      } else {
        & $taskNode.Source --use-env-proxy './runner.mjs' --run @taskBrowserArgs
      }
    }
  }
  $taskResult = $LASTEXITCODE
} finally {
  $env:HTTP_PROXY = $taskPreviousHttp
  $env:HTTPS_PROXY = $taskPreviousHttps
  $env:NO_PROXY = $taskPreviousNoProxy
  $env:CHATGPT2API_ADMIN_KEY = $taskPreviousKey
}
if ($taskResult -ne 0) { throw '任务已停止，请查看上方提示或 README.md 中的处理说明。' }
