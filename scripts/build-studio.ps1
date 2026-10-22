param(
    [string]$QtRoot = '',
    [string]$CMake = '',
    [string]$Configuration = 'Release',
    [string]$BuildDirectory = 'build\native',
    [string]$InstallDirectory = 'build\studio',
    [string]$GoogleDriveClientFile = ''
)
$ErrorActionPreference = 'Stop'
if ($Configuration -notin @('Release', 'Debug')) { throw 'Use Release or Debug.' }
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $QtRoot) { $QtRoot = Join-Path $repoRoot '.tools\qt\6.12.0\msvc2022_64' }
$QtRoot = (Resolve-Path -LiteralPath $QtRoot).Path
if (-not (Test-Path -LiteralPath (Join-Path $QtRoot 'lib\cmake\Qt6\Qt6Config.cmake'))) {
    throw 'Configure a trusted Qt 6.12 or newer MSVC x64 SDK path.'
}
if (-not $CMake) {
    $command = Get-Command cmake -ErrorAction SilentlyContinue
    if ($command) { $CMake = $command.Source }
    else { $CMake = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\2022\BuildTools\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe' }
}
$CMake = (Resolve-Path -LiteralPath $CMake).Path
function Resolve-StudioOutput {
    param([string]$RelativePath)
    if ([IO.Path]::IsPathRooted($RelativePath)) { throw 'Use a build directory relative to this repository.' }
    $taskOutput = [IO.Path]::GetFullPath((Join-Path $repoRoot $RelativePath))
    $taskBuildRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot 'build')) + [IO.Path]::DirectorySeparatorChar
    if (-not $taskOutput.StartsWith($taskBuildRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Studio build and package directories must remain inside build/.'
    }
    return $taskOutput
}
$nativeBuild = Resolve-StudioOutput $BuildDirectory
$studioInstall = Resolve-StudioOutput $InstallDirectory
$taskDriveConfig = $null
if ($GoogleDriveClientFile) {
    $taskDriveConfigPath = (Resolve-Path -LiteralPath $GoogleDriveClientFile).Path
    if ((Get-Item -LiteralPath $taskDriveConfigPath).Length -gt 4096) { throw 'Invalid publisher Google Drive configuration.' }
    $taskDriveConfig = Get-Content -LiteralPath $taskDriveConfigPath -Raw | ConvertFrom-Json
    if (@($taskDriveConfig.PSObject.Properties.Name).Count -ne 1 -or $taskDriveConfig.clientId -isnot [string] -or
        $taskDriveConfig.clientId -cnotmatch '^[A-Za-z0-9][A-Za-z0-9_-]{0,199}\.apps\.googleusercontent\.com$') {
        throw 'Publisher configuration must contain only an installed-application clientId. Never package tokens or secrets.'
    }
}
if ($nativeBuild -eq $studioInstall) { throw 'Use separate build and package directories.' }
$temporaryDirectory = Join-Path $repoRoot '.tools\tmp'
New-Item -ItemType Directory -Force -Path $temporaryDirectory | Out-Null
$env:TEMP = $temporaryDirectory
$env:TMP = $temporaryDirectory
$env:MSBUILDDISABLENODEREUSE = '1'

function Invoke-StudioCMake {
    param([string[]]$Arguments, [string]$FailureMessage)
    # Windows PowerShell can turn native stderr warnings into terminating
    # NativeCommandError records when callers redirect output. Preserve stderr
    # and gate each child process on its actual exit code instead.
    $taskSavedErrorAction = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        & $CMake @Arguments
        $taskCMakeExit = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $taskSavedErrorAction
    }
    if ($taskCMakeExit -ne 0) { throw "$FailureMessage Exit code: $taskCMakeExit" }
}

Invoke-StudioCMake -Arguments @('-S', $repoRoot, '-B', $nativeBuild, '-G', 'Visual Studio 17 2022', '-A', 'x64', "-DCMAKE_PREFIX_PATH=$QtRoot", "-DCMAKE_INSTALL_PREFIX=$studioInstall") -FailureMessage 'CMake configuration failed.'
Invoke-StudioCMake -Arguments @('--build', $nativeBuild, '--config', $Configuration, '--parallel', '4', '--', '/nr:false') -FailureMessage 'Native build failed.'
Invoke-StudioCMake -Arguments @('--install', $nativeBuild, '--config', $Configuration) -FailureMessage 'Local packaging failed.'
# Source CLI resolution deliberately uses one trusted, fixed helper location.
# CMake's integrated build emits this helper under the chosen native build root.
$taskSourceAclDirectory = Resolve-StudioOutput 'build/audit-acl/bin'
New-Item -ItemType Directory -Force -Path $taskSourceAclDirectory | Out-Null
foreach ($taskAclDirectory in @((Join-Path $repoRoot 'build'), (Split-Path -Parent $taskSourceAclDirectory), $taskSourceAclDirectory)) {
    if ((Get-Item -LiteralPath $taskAclDirectory -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Linked source helper directory refused.' }
}
$taskBuiltAcl = Join-Path $nativeBuild 'bin/lmti-audit-acl.exe'
$taskSourceAcl = Join-Path $taskSourceAclDirectory 'lmti-audit-acl.exe'
if ((Get-Item -LiteralPath $taskBuiltAcl).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Linked built helper refused.' }
if ((Test-Path -LiteralPath $taskSourceAcl) -and ((Get-Item -LiteralPath $taskSourceAcl).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Linked source helper refused.' }
if ([IO.Path]::GetFullPath($taskBuiltAcl) -ine [IO.Path]::GetFullPath($taskSourceAcl)) {
    # Unlink an existing output first, so an unexpected hardlink is not overwritten.
    if (Test-Path -LiteralPath $taskSourceAcl) { Remove-Item -LiteralPath $taskSourceAcl -Force }
    [IO.File]::Copy($taskBuiltAcl, $taskSourceAcl, $false)
}
if ($taskDriveConfig) {
    $taskConfigOutput = Join-Path $studioInstall 'share\lmti\google-drive-client.json'
    [IO.File]::WriteAllText($taskConfigOutput, (@{ clientId = $taskDriveConfig.clientId } | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
}
Write-Output (Join-Path $studioInstall 'bin\lmti-desktop.exe')
