$ErrorActionPreference = 'Stop'
$workspace = Split-Path -Parent $PSScriptRoot
$pidFile = Join-Path $workspace '.runtime/server.pid'
if (-not (Test-Path -LiteralPath $pidFile)) {
    Write-Output '未找到此目录启动的后台服务。前台启动的服务请在原终端按 Ctrl+C 停止。'
    exit
}
$serviceProcessId = [int](Get-Content -LiteralPath $pidFile -Raw).Trim()
$processInfo = Get-CimInstance Win32_Process -Filter "ProcessId=$serviceProcessId" -ErrorAction SilentlyContinue
$serverPath = Join-Path $workspace 'server.py'
if ($processInfo -and $processInfo.CommandLine -and $processInfo.CommandLine.IndexOf($serverPath, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
    Stop-Process -Id $serviceProcessId
    Write-Output 'Talent Hub 服务已停止。'
} elseif ($processInfo) {
    throw '进程与此项目不匹配，未停止该进程。'
}
Remove-Item -LiteralPath $pidFile
