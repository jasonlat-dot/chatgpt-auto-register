param(
  [ValidateSet('Menu', 'Gmail', 'Plan', 'Queue', 'Manual', 'Retry', 'CleanLock', 'Generate', 'Browser', 'RetryMenu', 'Session')]
  [string]$Mode = 'Menu',
  [string]$Email = '',
  [string]$Count = '',
  [string]$Domain = '',
  [ValidateSet('', 'normal', 'incognito')]
  [string]$BrowserMode = '',
  [switch]$ConfirmedNotImported
)
$ErrorActionPreference = 'Stop'
$OutputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $OutputEncoding
[Console]::InputEncoding = $OutputEncoding
Set-Location -LiteralPath $PSScriptRoot
if ($Mode -eq 'Menu') {
  $taskMenuModes = @{ '1' = 'Gmail'; '2' = 'Plan'; '3' = 'Queue'; '4' = 'Manual'; '5' = 'CleanLock'; '6' = 'Generate'; '7' = 'Browser'; '8' = 'RetryMenu'; '9' = 'Session' }
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
    Write-Host '8. 查看失败 / 已停止 / 跳过账号，重新排队'
    Write-Host '9. Session JSON 自动导入：登录 ChatGPT 后读取并导入'
    Write-Host '0. 退出程序'
    Write-Host ''
    $taskMenuSelection = (Read-Host '请输入选项 0 到 9，然后按回车').Trim()
    if ($taskMenuSelection -eq '0') { break }
    if (-not $taskMenuModes.ContainsKey($taskMenuSelection)) {
      Write-Host '选项无效，请输入 0 到 9。' -ForegroundColor Yellow
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
if ($Mode -in @('Generate', 'Browser', 'Retry', 'RetryMenu')) {
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
      $taskRetryArgs = @()
      if ($ConfirmedNotImported) { $taskRetryArgs = @('--confirm-not-imported') }
      & $taskNode.Source --use-env-proxy './runner.mjs' --retry $Email @taskRetryArgs
    }
    'RetryMenu' {
      $taskRetryJson = & $taskNode.Source './runner.mjs' --queue-status --json
      if ($LASTEXITCODE -ne 0) { throw '读取重试列表失败，请查看上方错误。' }
      $taskRetryView = ($taskRetryJson -join "`n") | ConvertFrom-Json
      $taskRetryRows = @($taskRetryView.items | Where-Object { $_.retry -in @('safe', 'review') })
      if ($taskRetryRows.Count -eq 0) {
        Write-Host '没有需要重新排队的账号。待处理账号可直接选择 3 / 4 / 9。'
        return
      }
      Write-Host '以下账号没有自动重试。清理锁不会改变这些状态。'
      for ($taskRetryIndex = 0; $taskRetryIndex -lt $taskRetryRows.Count; $taskRetryIndex++) {
        $taskRetryRow = $taskRetryRows[$taskRetryIndex]
        Write-Host (('{0}. {1} | {2} | 原因：{3}' -f ($taskRetryIndex + 1), $taskRetryRow.email, $taskRetryRow.label, $taskRetryRow.reason))
        Write-Host ('   下一步：' + $taskRetryRow.action)
      }
      Write-Host 'A. 批量重新排队：仅已停止 / 失败 / 跳过；结果待核对及处理中断的保留'
      Write-Host '0. 返回，不改变状态'
      $taskRetryChoice = (Read-Host '输入邮箱前的序号，或 A / 0').Trim()
      if ($taskRetryChoice -eq '0') { return }
      if ($taskRetryChoice.ToUpperInvariant() -eq 'A') {
        & $taskNode.Source './runner.mjs' --retry-all-safe
      } else {
        [int]$taskRetryNumber = 0
        if (-not [int]::TryParse($taskRetryChoice, [ref]$taskRetryNumber) -or $taskRetryNumber -lt 1 -or $taskRetryNumber -gt $taskRetryRows.Count) { throw '序号无效，状态未改变。' }
        $taskRetrySelected = $taskRetryRows[$taskRetryNumber - 1]
        $taskRetryArgs = @()
        if ($taskRetrySelected.retry -eq 'review') {
          Write-Host '先检查后端账号池。已入库的不要重试；只有确认未入库才重新排队。' -ForegroundColor Yellow
          $taskRetryConfirm = (Read-Host '确定未入库请输入“未导入”，其他输入返回').Trim()
          if ($taskRetryConfirm -ne '未导入') { Write-Host '未确认，状态未改变。'; return }
          $taskRetryArgs = @('--confirm-not-imported')
        }
        & $taskNode.Source './runner.mjs' --retry $taskRetrySelected.email @taskRetryArgs
      }
    }
    { $_ -in @('Queue', 'Manual', 'Session') } {
      $taskPreflightJson = & $taskNode.Source './runner.mjs' --queue-status --json
      if ($LASTEXITCODE -ne 0) { throw '读取队列状态失败，请查看上方错误。' }
      $taskPreflightView = ($taskPreflightJson -join "`n") | ConvertFrom-Json
      if ($taskPreflightView.pending_count -eq 0) {
        & $taskNode.Source './runner.mjs' --queue-status
        return
      }
      if ($taskPreflightView.held_count -gt 0) { Write-Host ('另有 ' + $taskPreflightView.held_count + ' 个历史账号未重试，可在菜单 8 查看原因和重新排队。') }

      if ($taskConfig.chatgpt2api_admin_key -is [string] -and $taskConfig.chatgpt2api_admin_key.Trim()) {
        $env:CHATGPT2API_ADMIN_KEY = $taskConfig.chatgpt2api_admin_key.Trim()
      }
      $taskBrowserArgs = @()
      if ($BrowserMode) { $taskBrowserArgs = @('--browser-mode', $BrowserMode) }
      while ($true) {
        $taskSaveInput = $false
        if (-not $env:CHATGPT2API_ADMIN_KEY) {
          $taskSecret = Read-Host '请输入 ChatGPT2API 管理员密钥（输入隐藏；验证通过后保存到本机 config.json；空输入取消）' -AsSecureString
          $taskPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($taskSecret)
          try { $env:CHATGPT2API_ADMIN_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($taskPointer).Trim() }
          finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($taskPointer) }
          if (-not $env:CHATGPT2API_ADMIN_KEY) { Write-Host '已取消，配置未改变。'; return }
          $taskSaveInput = $true
        }
        $taskAuthArgs = @('--check-admin-key', '--candidate-env')
        if ($taskSaveInput) { $taskAuthArgs += '--save-admin-key' }
        & $taskNode.Source --use-env-proxy './runner.mjs' @taskAuthArgs
        $taskAuthResult = $LASTEXITCODE
        if ($taskAuthResult -in @(23, 24)) {
          Write-Host '密钥未通过管理员认证，请重新输入；错误的输入不会保存。' -ForegroundColor Yellow
          $env:CHATGPT2API_ADMIN_KEY = $null
          continue
        }
        if ($taskAuthResult -ne 0) { throw '无法验证后端密钥。请检查服务地址、网络或上方提示；未将网络错误当作密钥错误。' }
        $taskRunArgs = @('--run')
        if ($Mode -eq 'Manual') { $taskRunArgs += '--manual-codes' }
        if ($Mode -eq 'Session') { $taskRunArgs += '--session-import' }
        & $taskNode.Source --use-env-proxy './runner.mjs' @taskRunArgs @taskBrowserArgs
        $taskQueueResult = $LASTEXITCODE
        if ($taskQueueResult -in @(23, 24)) {
          Write-Host '运行中后端密钥失效，请更新密钥后继续；兑换结果待核对的账号不会自动重试。' -ForegroundColor Yellow
          $env:CHATGPT2API_ADMIN_KEY = $null
          continue
        }
        break
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
