param([switch]$PrintLaunchInfo)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskPackage = Join-Path $taskRoot 'build/studio-ui-fix-20261012'
if (-not (Test-Path -LiteralPath (Join-Path $taskPackage 'bin/lmti-desktop.exe') -PathType Leaf)) {
    $taskPackage = Join-Path $taskRoot 'build/studio-design-20261012-ee28c7de'
}
$taskData = Join-Path $taskPackage 'review-data'
if (-not (Test-Path -LiteralPath (Join-Path $taskPackage 'bin/lmti-desktop.exe') -PathType Leaf)) {
    throw 'The isolated design review package has not been installed.'
}
if ($PrintLaunchInfo) {
    if (-not (Test-Path -LiteralPath $taskData -PathType Container)) {
        throw 'The isolated review data directory has not been prepared.'
    }
} else {
    New-Item -ItemType Directory -Path $taskData -Force | Out-Null
}
$taskInfo = & (Join-Path $PSScriptRoot 'start-studio-ui.ps1') -PackageDirectory $taskPackage -DataDirectory $taskData -Demo -PrintLaunchInfo
if ($PrintLaunchInfo) { $taskInfo; return }
$taskOldNode = $env:LMTI_STUDIO_NODE_BINARY
$taskOldCli = $env:LMTI_STUDIO_CLI
$taskOldReview = $env:LMTI_STUDIO_ALLOW_LESSON_REVIEW
try {
    $env:LMTI_STUDIO_NODE_BINARY = (Get-Command node -CommandType Application -ErrorAction Stop).Source
    $env:LMTI_STUDIO_CLI = Join-Path $taskRoot 'packages/cli/dist/index.js'
    $env:LMTI_STUDIO_ALLOW_LESSON_REVIEW = '0'
    Start-Process -FilePath $taskInfo.Desktop -ArgumentList @('--data-directory', ('"' + $taskData + '"'), '--demo') -WorkingDirectory $taskRoot -WindowStyle Normal
} finally {
    $env:LMTI_STUDIO_NODE_BINARY = $taskOldNode
    $env:LMTI_STUDIO_CLI = $taskOldCli
    $env:LMTI_STUDIO_ALLOW_LESSON_REVIEW = $taskOldReview
}
