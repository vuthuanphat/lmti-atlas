param([ValidateRange(0,65535)][int]$Port = 8781)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskNode = (Get-Command node -CommandType Application -ErrorAction Stop).Source
$taskScript = Join-Path $PSScriptRoot 'web-preview-server.mjs'
$taskLogRoot = Join-Path $taskRoot 'build/web-preview'
New-Item -ItemType Directory -Path $taskLogRoot -Force | Out-Null
$taskRun = [Guid]::NewGuid().ToString('N').Substring(0,8)
$taskOutput = Join-Path $taskLogRoot "$taskRun.stdout.log"
$taskError = Join-Path $taskLogRoot "$taskRun.stderr.log"
$taskProcess = Start-Process -FilePath $taskNode -ArgumentList @(('"' + $taskScript + '"'),$Port) -WorkingDirectory $taskRoot -WindowStyle Hidden -RedirectStandardOutput $taskOutput -RedirectStandardError $taskError -PassThru
for ($taskAttempt = 0; $taskAttempt -lt 50; $taskAttempt++) {
    if ($taskProcess.HasExited) { throw 'Preview could not start. Existing services were not changed. Choose another port.' }
    if ((Test-Path -LiteralPath $taskOutput) -and (Get-Item -LiteralPath $taskOutput).Length -gt 0) {
        $taskInfo = Get-Content -LiteralPath $taskOutput -Encoding UTF8 | Select-Object -First 1 | ConvertFrom-Json
        if ($taskInfo.kind -ne 'lmti-web00-preview') { throw 'Unexpected preview response.' }
        $taskInfo
        return
    }
    Start-Sleep -Milliseconds 100
}
throw 'Preview startup timed out. Check the preview log before launching again.'
