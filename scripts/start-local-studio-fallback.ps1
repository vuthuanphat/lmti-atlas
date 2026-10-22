param([Parameter(Mandatory=$true)][string]$DataDirectory, [string]$PackageDirectory='')
$ErrorActionPreference='Stop'
foreach ($taskLocation in @($DataDirectory,$PackageDirectory)) {
    if ($taskLocation.Length -gt 1024 -or $taskLocation -match '[\x00-\x1f"]' -or $taskLocation.Replace('\','/').StartsWith('//')) { throw 'Use local Studio data and package directories; network/device paths are refused before filesystem access.' }
}
$taskRoot=Split-Path -Parent $PSScriptRoot
if (-not $PackageDirectory) { $PackageDirectory=if (Test-Path -LiteralPath (Join-Path $taskRoot 'bin/lmti-desktop.exe')) { $taskRoot } else { Join-Path $taskRoot 'build/studio-web03-projection-20261014' } }
$taskPackage=(Resolve-Path -LiteralPath $PackageDirectory).Path
& (Join-Path $PSScriptRoot 'test-local-web-package.ps1') -PackageDirectory $taskPackage | Out-Null
$taskData=(Resolve-Path -LiteralPath $DataDirectory).Path
if (-not (Test-Path -LiteralPath $taskData -PathType Container) -or $taskData -match '["\r\n]') { throw 'Choose a local Studio data directory.' }
$taskPython=(Get-Command python -CommandType Application | Select-Object -First 1).Source
$taskStart=[Diagnostics.ProcessStartInfo]::new()
$taskStart.FileName=Join-Path $taskPackage 'bin/lmti-desktop.exe'
$taskStart.Arguments='--data-directory "'+$taskData+'"'
$taskStart.UseShellExecute=$false
$taskStart.WorkingDirectory=$taskPackage
$taskStart.EnvironmentVariables.Clear()
foreach ($taskKey in @('SystemRoot','WINDIR')) { if ([Environment]::GetEnvironmentVariable($taskKey)) { $taskStart.EnvironmentVariables[$taskKey]=[Environment]::GetEnvironmentVariable($taskKey) } }
$taskStart.EnvironmentVariables['LMTI_STUDIO_PYTHON_BINARY']=$taskPython
$taskStart.EnvironmentVariables['LMTI_STUDIO_AGENT_ENTRY']=Join-Path $taskPackage 'share/lmti/scripts/lmti-agent-mcp.py'
$taskStart.EnvironmentVariables['LMTI_STUDIO_MCP_CONFIG_OWNER']=Join-Path $taskPackage 'share/lmti/scripts/mcp-config-owner.py'
$taskStart.EnvironmentVariables.Remove('LMTI_STUDIO_ALLOW_LESSON_REVIEW')
$taskStart.EnvironmentVariables.Remove('LMTI_STUDIO_ALLOW_IMPACT_REVIEW')
$taskStart.EnvironmentVariables.Remove('LMTI_STUDIO_ALLOW_GOOGLE_DRIVE')
[Diagnostics.Process]::Start($taskStart) | Select-Object Id,ProcessName
