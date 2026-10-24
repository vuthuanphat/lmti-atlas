param([Parameter(Mandatory=$true)][string]$WorkspaceFile,[string[]]$ProjectId=@(),[switch]$GrantProjectContent,[switch]$ValidateOnly)
$ErrorActionPreference='Stop'
if ($GrantProjectContent -and -not $ProjectId.Count) { throw 'GrantProjectContent requires explicit registered ProjectId selection.' }
$taskRoot=Split-Path -Parent $PSScriptRoot
$taskHelper=Join-Path $PSScriptRoot 'workspace-profile.mjs'
$taskNodeCommand=Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $taskNodeCommand) { throw 'Node.js is missing. Install trusted Node.js 24+ x64 from nodejs.org, then reopen this console.' }
$taskNode=$taskNodeCommand.Source
$taskStart=[Diagnostics.ProcessStartInfo]::new()
$taskStart.FileName=$taskNode
if ($taskHelper -match '["\r\n]') { throw 'Use a trusted local package path.' }
$taskStart.Arguments='"'+$taskHelper+'"'
$taskStart.WorkingDirectory=$taskRoot
$taskStart.UseShellExecute=$false; $taskStart.CreateNoWindow=$true
$taskStart.RedirectStandardInput=$true; $taskStart.RedirectStandardOutput=$true; $taskStart.RedirectStandardError=$true
$taskStart.StandardOutputEncoding=[Text.UTF8Encoding]::new($false,$true)
$taskStart.StandardErrorEncoding=[Text.UTF8Encoding]::new($false,$true)
$taskStart.EnvironmentVariables.Clear()
foreach ($taskKey in @('SystemRoot','WINDIR')) { if ([Environment]::GetEnvironmentVariable($taskKey)) { $taskStart.EnvironmentVariables[$taskKey]=[Environment]::GetEnvironmentVariable($taskKey) } }
$taskRequestValue=@{action='open';profilePath=$WorkspaceFile}
if ($PSBoundParameters.ContainsKey('ProjectId')) { $taskRequestValue.projectIds=@($ProjectId) }
if ($GrantProjectContent) { $taskRequestValue.grantProjectContent=$true }
$taskRequest=$taskRequestValue|ConvertTo-Json -Compress
if ([Text.Encoding]::UTF8.GetByteCount($taskRequest)+1 -gt 16384) { throw 'Workspace request exceeds the local input limit.' }
$taskProcess=[Diagnostics.Process]::Start($taskStart)
$taskOutput=$taskProcess.StandardOutput.ReadToEndAsync(); $taskErrors=$taskProcess.StandardError.ReadToEndAsync()
$taskWriter=[IO.StreamWriter]::new($taskProcess.StandardInput.BaseStream,[Text.UTF8Encoding]::new($false))
try { $taskWriter.NewLine="`n"; $taskWriter.WriteLine($taskRequest); $taskWriter.Flush() } finally { $taskWriter.Dispose() }
if (-not $taskProcess.WaitForExit(60000)) { throw 'Workspace validation timed out. No web session was started.' }
$taskText=$taskOutput.GetAwaiter().GetResult()
if ($taskProcess.ExitCode -ne 0 -or $taskText.Length -gt 16384) {
    $taskCode='WORKSPACE_UNAVAILABLE'
    try { $taskError=$taskErrors.GetAwaiter().GetResult()|ConvertFrom-Json; if ($taskError.code -in @('INVALID_INPUT','SCOPE_DENIED','OWNER_UNAVAILABLE','LIMIT_EXCEEDED','CONFIG_CHANGED','WORKSPACE_EXISTS')) { $taskCode=$taskError.code } } catch {}
    throw ('Workspace open refused ['+$taskCode+']. Restore the exact trusted package/profile or inspect the saved workspace. No session or migration was started.')
}
$taskInfo=$taskText|ConvertFrom-Json
if ($taskInfo.kind -ne 'lmti-local-workspace-open' -or $taskInfo.version -ne 1) { throw 'Unexpected workspace validation response.' }
& (Join-Path $PSScriptRoot 'test-local-web-package.ps1') -PackageDirectory $taskInfo.packageDirectory | Out-Null
if ($ValidateOnly) { $taskInfo; return }
$taskArgs=@{DataDirectory=$taskInfo.dataDirectory;PackageDirectory=$taskInfo.packageDirectory;ProjectId=@($taskInfo.selectedProjectIds);LibraryManagementFile=$taskInfo.libraryManagementFile;Interactive=$true}
if ($taskInfo.contentProjectIds.Count) { $taskArgs.ProjectContent=$true; $taskArgs.ContentProjectId=@($taskInfo.contentProjectIds) }
if ($taskInfo.enableMaintenance) {
    $taskArgs.ProjectOperations=$true; $taskArgs.AllowLibraryUpgrade=$true
    $taskArgs.CopyParent=$taskInfo.copyParent; $taskArgs.BackupParent=$taskInfo.backupParent
}
Write-Host 'Opening the workspace with saved grants and the explicit project selection shown below.'
Write-Host ('Selected project scope: '+(@($taskInfo.selectedProjectIds) -join ', '))
Write-Host ('Content edit scope: '+(@($taskInfo.contentProjectIds) -join ', '))
Write-Host 'Keep this operator console open. O opens a fresh private tab; Q drains and stops. Never repeat an interrupted write.'
& $taskInfo.launcher @taskArgs
