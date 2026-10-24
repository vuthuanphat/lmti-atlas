param(
    [string]$WorkspaceDirectory='',
    [string]$PackageDirectory='',
    [ValidateSet('demo','empty')][string]$Mode='demo',
    [string]$ProjectId='my-project',
    [string]$ProjectName='My project',
    [ValidateRange(1,8)][int]$ProjectFolderCount=4,
    [switch]$EnableMaintenance,
    [switch]$NonInteractive,
    [switch]$NoLaunch
)
$ErrorActionPreference='Stop'
$taskRoot=Split-Path -Parent $PSScriptRoot
if (-not $PackageDirectory) {
    $PackageDirectory=if (Test-Path -LiteralPath (Join-Path $taskRoot 'bin/lmti-project.exe')) { $taskRoot } else { Join-Path $taskRoot 'build/lmti-v0.2.0-alpha.1-windows-x64' }
}
if (-not $NonInteractive) {
    Write-Host 'LMTI local workspace setup / Thiet lap workspace local'
    Write-Host 'Creates a NEW isolated workspace. Existing folders and source files are preserved.'
    if (-not $WorkspaceDirectory) { $WorkspaceDirectory=Read-Host 'Absolute path for a NEW workspace folder' }
    if (-not $PSBoundParameters.ContainsKey('Mode')) {
        $taskMode=Read-Host 'Start with demo or empty project? [demo]'
        if ($taskMode) {
            if ($taskMode -notin @('demo','empty')) { throw 'Choose demo or empty.' }
            $Mode=$taskMode
        }
    }
    if ($Mode -eq 'empty') {
        if (-not $PSBoundParameters.ContainsKey('ProjectId')) { $taskId=Read-Host 'Project ID [my-project]'; if ($taskId) { $ProjectId=$taskId } }
        if (-not $PSBoundParameters.ContainsKey('ProjectName')) { $taskName=Read-Host 'Project name [My project]'; if ($taskName) { $ProjectName=$taskName } }
    }
    if (-not $EnableMaintenance) {
        $taskMaintenance=Read-Host 'Grant explicit library schema maintenance? This affects the whole NEW library. [y/N]'
        if ($taskMaintenance -eq 'y') { $EnableMaintenance=$true }
    }
}
if (-not $WorkspaceDirectory) { throw 'Specify WorkspaceDirectory as a new absolute local folder.' }
if ($Mode -eq 'demo') { $ProjectId='factory-monitor'; $ProjectName='Factory Monitor' }
Write-Host ('Workspace: '+$WorkspaceDirectory)
Write-Host ('Project: '+$ProjectId+' / '+$ProjectName+' ('+$Mode+')')
Write-Host 'Grants: this project content only; library metadata and source folders inside this workspace.'
Write-Host 'Approved empty source folders (one distinct folder per linked project):'
for ($taskFolderIndex=1; $taskFolderIndex -le $ProjectFolderCount; $taskFolderIndex++) {
    $taskFolderName=if ($taskFolderIndex -eq 1) { 'source' } else { 'source-'+$taskFolderIndex }
    Write-Host ('  '+$WorkspaceDirectory.TrimEnd('\','/')+'\'+$taskFolderName)
}
if ($EnableMaintenance) { Write-Host 'Additional explicit grant: library schema maintenance only. Every upgrade still requires preview and confirmation.' }
Write-Host 'No Agent, hierarchy, project-copy or activation grants. No runtime installation or policy changes.'
if (-not $NonInteractive) {
    $taskConfirmation=Read-Host 'Create this fresh workspace with the grants above? Type CREATE'
    if ($taskConfirmation -cne 'CREATE') { Write-Host 'Setup cancelled; no workspace was created.'; return }
}
# Doctor validates the publisher package and installed runtimes before creation.
& (Join-Path $PSScriptRoot 'test-local-web-package.ps1') -PackageDirectory $PackageDirectory | Out-Null
$taskPackage=(Resolve-Path -LiteralPath $PackageDirectory).Path
$taskHelper=Join-Path $PSScriptRoot 'workspace-profile.mjs'
$taskNode=(Get-Command node -CommandType Application | Select-Object -First 1).Source
$taskStart=[Diagnostics.ProcessStartInfo]::new()
$taskStart.FileName=$taskNode
if ($taskHelper -match '["\r\n]') { throw 'Use a trusted local package path.' }
$taskStart.Arguments='"'+$taskHelper+'"'
$taskStart.WorkingDirectory=$taskPackage
$taskStart.UseShellExecute=$false; $taskStart.CreateNoWindow=$true
$taskStart.RedirectStandardInput=$true; $taskStart.RedirectStandardOutput=$true; $taskStart.RedirectStandardError=$true
$taskStart.StandardOutputEncoding=[Text.UTF8Encoding]::new($false,$true)
$taskStart.StandardErrorEncoding=[Text.UTF8Encoding]::new($false,$true)
$taskStart.EnvironmentVariables.Clear()
foreach ($taskKey in @('SystemRoot','WINDIR')) { if ([Environment]::GetEnvironmentVariable($taskKey)) { $taskStart.EnvironmentVariables[$taskKey]=[Environment]::GetEnvironmentVariable($taskKey) } }
$taskRequest=@{action='create';packageDirectory=$taskPackage;workspaceDirectory=$WorkspaceDirectory;mode=$Mode;projectId=$ProjectId;projectName=$ProjectName;projectFolderCount=$ProjectFolderCount;enableMaintenance=[bool]$EnableMaintenance}|ConvertTo-Json -Compress
if ([Text.Encoding]::UTF8.GetByteCount($taskRequest)+1 -gt 16384) { throw 'Workspace request exceeds the local input limit.' }
$taskProcess=[Diagnostics.Process]::Start($taskStart)
$taskOutput=$taskProcess.StandardOutput.ReadToEndAsync(); $taskErrors=$taskProcess.StandardError.ReadToEndAsync()
$taskWriter=[IO.StreamWriter]::new($taskProcess.StandardInput.BaseStream,[Text.UTF8Encoding]::new($false))
try { $taskWriter.NewLine="`n"; $taskWriter.WriteLine($taskRequest); $taskWriter.Flush() } finally { $taskWriter.Dispose() }
if (-not $taskProcess.WaitForExit(60000)) { throw 'Setup is still running. Preserve its folder and inspect before starting another setup. No operation was repeated.' }
$taskText=$taskOutput.GetAwaiter().GetResult()
if ($taskProcess.ExitCode -ne 0 -or $taskText.Length -gt 16384) {
    $taskCode='WORKSPACE_UNAVAILABLE'
    try { $taskError=$taskErrors.GetAwaiter().GetResult()|ConvertFrom-Json; if ($taskError.code -in @('INVALID_INPUT','SCOPE_DENIED','OWNER_UNAVAILABLE','LIMIT_EXCEEDED','CONFIG_CHANGED','WORKSPACE_EXISTS')) { $taskCode=$taskError.code } } catch {}
    throw ('Workspace setup refused ['+$taskCode+']. Preserve any partial folder; use a new path after inspection. Existing data was not overwritten.')
}
$taskResult=$taskText|ConvertFrom-Json
if ($taskResult.kind -ne 'lmti-local-workspace' -or -not $taskResult.profilePath) { throw 'Unexpected workspace setup response.' }
Write-Host 'Workspace created. Reopen it later using Open-LMTI.cmd inside that workspace.'
if ($NoLaunch) { $taskResult; return }
& (Join-Path $PSScriptRoot 'open-local-workspace.ps1') -WorkspaceFile $taskResult.profilePath
