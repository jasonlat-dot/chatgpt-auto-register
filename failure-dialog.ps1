param(
  [string]$Email = '',
  [string]$Reason = '',
  [ValidateRange(1, 60)][int]$TimeoutSeconds = 15,
  [ValidateSet('', 'manual', 'skip')][string]$TestChoice = '',
  [switch]$TestHidden
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
$taskDialog = New-Object System.Windows.Forms.Form
$taskDialog.Text = '验证码获取失败'
$taskDialog.ClientSize = New-Object System.Drawing.Size(610, 245)
$taskDialog.StartPosition = 'CenterScreen'
$taskDialog.FormBorderStyle = 'FixedDialog'
$taskDialog.MaximizeBox = $false
$taskDialog.MinimizeBox = $false
$taskDialog.TopMost = $true
$taskDialog.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 10)
$taskDialog.Tag = 'skip'

$taskDetails = New-Object System.Windows.Forms.Label
$taskDetails.SetBounds(22, 18, 566, 96)
$taskDetails.Text = "当前账号：$Email`r`n`r`n$Reason"
$taskDialog.Controls.Add($taskDetails)
$taskCountdown = New-Object System.Windows.Forms.Label
$taskCountdown.SetBounds(22, 120, 566, 40)
$taskDialog.Controls.Add($taskCountdown)

$taskManual = New-Object System.Windows.Forms.Button
$taskManual.Text = '手工输入验证码'
$taskManual.SetBounds(22, 180, 220, 42)
$taskManual.Add_Click({ $taskDialog.Tag = 'manual'; $taskDialog.Close() })
$taskDialog.Controls.Add($taskManual)
$taskSkip = New-Object System.Windows.Forms.Button
$taskSkip.Text = '跳过，处理下一个'
$taskSkip.SetBounds(270, 180, 240, 42)
$taskSkip.Add_Click({ $taskDialog.Tag = 'skip'; $taskDialog.Close() })
$taskDialog.Controls.Add($taskSkip)
$taskDialog.AcceptButton = $taskSkip
$taskDialog.CancelButton = $taskSkip

$taskClock = New-Object System.Diagnostics.Stopwatch
$taskTimer = New-Object System.Windows.Forms.Timer
$taskTimer.Interval = 100
$taskCountdown.Text = "$TimeoutSeconds 秒内未选择，将跳过当前账号并处理下一个。"
$taskTimer.Add_Tick({
  $taskRemaining = [Math]::Max(0, [Math]::Ceiling($TimeoutSeconds - $taskClock.Elapsed.TotalSeconds))
  $taskCountdown.Text = "$taskRemaining 秒内未选择，将跳过当前账号并处理下一个。"
  if ($TestChoice -and $taskClock.Elapsed.TotalMilliseconds -ge 250) {
    if ($TestChoice -eq 'manual') { $taskManual.PerformClick() } else { $taskSkip.PerformClick() }
  } elseif ($taskRemaining -le 0) {
    $taskDialog.Tag = 'skip'
    $taskDialog.Close()
  }
})
if ($TestHidden) { $taskDialog.Opacity = 0; $taskDialog.ShowInTaskbar = $false }
$taskDialog.Add_Shown({ $taskClock.Start(); $taskTimer.Start() })
$taskDialog.Add_FormClosed({ $taskTimer.Stop() })
try {
  [void]$taskDialog.ShowDialog()
  $taskChoice = [string]$taskDialog.Tag
} finally {
  $taskTimer.Dispose()
  $taskDialog.Dispose()
}
Write-Output $taskChoice
