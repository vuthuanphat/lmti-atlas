param([Parameter(Mandatory=$true)][string]$DataDirectory,[Parameter(Mandatory=$true)][string]$PackageDirectory)
$ErrorActionPreference='Stop'
# Private test fixture caller validated both local paths. Only the fixed publisher
# launcher runs; no command from the benchmark document or browser is executed.
$taskLaunch=& (Join-Path $PackageDirectory 'scripts/start-local-web.ps1') -DataDirectory $DataDirectory -PackageDirectory $PackageDirectory -NoBrowser
$taskLaunch | ConvertTo-Json -Compress
