param(
  [string]$TaskName = "Obaflix - Sincronizar catalogos a cada 5 horas",
  [switch]$RunNow
)

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$runner = Join-Path $PSScriptRoot "run-local-syncs.ps1"
$powerShellExe = Join-Path $PSHOME "powershell.exe"

if (-not (Test-Path -LiteralPath $runner)) {
  throw "Executor não encontrado: $runner"
}

$actionArguments = "-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$runner`""
$action = New-ScheduledTaskAction -Execute $powerShellExe -Argument $actionArguments -WorkingDirectory $projectRoot
$trigger = New-ScheduledTaskTrigger `
  -Once `
  -At (Get-Date).AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Hours 5)
$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -DontStopIfGoingOnBatteries `
  -AllowStartIfOnBatteries `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Hours 4 -Minutes 30)

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Description "Executa MegaFrix, Popular/TMDB, WebCine e SuperFlix localmente, sem usar Vercel Cron." `
  -Force | Out-Null

if ($RunNow) {
  Start-ScheduledTask -TaskName $TaskName
}

$task = Get-ScheduledTask -TaskName $TaskName
$info = Get-ScheduledTaskInfo -TaskName $TaskName
[PSCustomObject]@{
  TaskName = $task.TaskName
  State = $task.State
  NextRunTime = $info.NextRunTime
  LastRunTime = $info.LastRunTime
  LastTaskResult = $info.LastTaskResult
}

