$ErrorActionPreference = 'Stop'
$workspace = Split-Path -Parent $PSScriptRoot
$servicePort = if ($env:TALENT_PORT) { [int]$env:TALENT_PORT } else { 4173 }
$serverAddress = "http://127.0.0.1:$servicePort"
Add-Type -AssemblyName System.Net.Http
function Get-TalentStatus {
    $httpHandler = [System.Net.Http.HttpClientHandler]::new()
    $httpHandler.UseProxy = $false
    $httpClient = [System.Net.Http.HttpClient]::new($httpHandler)
    $httpClient.Timeout = [TimeSpan]::FromSeconds(2)
    try { $httpClient.GetStringAsync("$serverAddress/api/status").GetAwaiter().GetResult() | ConvertFrom-Json }
    finally { $httpClient.Dispose() }
}
try {
    $running = Get-TalentStatus
    if ($running.application -eq 'talent-hub') { Start-Process $serverAddress; exit }
} catch {}
$venvPython = Join-Path $workspace '.venv/Scripts/python.exe'
if (Test-Path -LiteralPath $venvPython) { $pythonPath = $venvPython }
else {
    $pythonPath = (Get-Command python -ErrorAction Stop).Source
    & $pythonPath -c 'import sys; sys.exit(0 if sys.version_info >= (3,12) else 1)'
    if ($LASTEXITCODE -ne 0) { throw '请先安装 Python 3.12 或更高版本，并添加到 PATH。' }
    & $pythonPath -m venv (Join-Path $workspace '.venv')
    $pythonPath = $venvPython
    & $pythonPath -m pip install -r (Join-Path $workspace 'requirements.txt')
    if ($LASTEXITCODE -ne 0) { throw '依赖安装失败，请检查网络或配置离线 wheels。' }
}
& $pythonPath -c 'import docx,pypdf,pypdfium2,PIL'
if ($LASTEXITCODE -ne 0) { throw '依赖缺失，请使用 requirements.txt 安装所需包。' }
$serverProcess = Start-Process -FilePath $pythonPath -ArgumentList @('"' + (Join-Path $workspace 'server.py') + '"') -WorkingDirectory $workspace -WindowStyle Hidden -PassThru
$runtimeDirectory = Join-Path $workspace '.runtime'
New-Item -ItemType Directory -Force -Path $runtimeDirectory | Out-Null
Set-Content -LiteralPath (Join-Path $runtimeDirectory 'server.pid') -Value $serverProcess.Id -Encoding ascii
for ($attempt=0; $attempt -lt 30; $attempt++) {
    Start-Sleep -Milliseconds 300
    try {
        $status = Get-TalentStatus
        if ($status.application -eq 'talent-hub') { Start-Process $serverAddress; exit }
    } catch {}
    if ($serverProcess.HasExited) { throw '共享服务未能启动，请在终端运行 .venv\Scripts\python.exe server.py 查看错误。' }
}
throw "启动超时，请检查 $servicePort 端口。"
