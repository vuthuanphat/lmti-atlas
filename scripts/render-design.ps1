param(
    [string]$Package = 'build/studio-design',
    [string]$Output = 'build/design-review',
    [ValidateSet('en', 'vi')][string]$Language = 'en',
    [string[]]$Screens = @(),
    [ValidateSet('1100x800', '1280x720', '1440x900')][string]$Viewport = '1440x900',
    [ValidateSet('1', '1.25', '1.5', '2')][string]$Scale = '1',
    [ValidateSet('windows', 'offscreen')][string]$Platform = 'windows'
)
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskPrefix = $taskRoot.TrimEnd('\') + '\'
$taskPackage = [IO.Path]::GetFullPath((Join-Path $taskRoot $Package))
$taskOutput = [IO.Path]::GetFullPath((Join-Path $taskRoot $Output))
foreach ($taskPath in @($taskPackage, $taskOutput)) {
    if (-not $taskPath.StartsWith($taskPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Render paths must stay within the workspace.'
    }
}
$taskBinary = Join-Path $taskPackage 'bin/lmti-desktop.exe'
if (-not (Test-Path -LiteralPath $taskBinary -PathType Leaf)) { throw 'Build/install the native package first.' }
$taskBinaryHash = (Get-FileHash -LiteralPath $taskBinary -Algorithm SHA256).Hash
New-Item -ItemType Directory -Path $taskOutput -Force | Out-Null
$taskManifest = Get-Content -LiteralPath (Join-Path $taskRoot 'docs/design/2026-10-12-ai-ui/manifest.json') -Raw -Encoding utf8 | ConvertFrom-Json
$taskPages = @($taskManifest.pages)
if ($Screens.Count) {
    foreach ($taskScreen in $Screens) {
        if ($taskScreen -notin $taskPages.id) { throw "Unknown screen: $taskScreen" }
    }
    $taskPages = @($taskPages | Where-Object { $_.id -in $Screens })
}
$taskOldPlatform = $env:QT_QPA_PLATFORM
$taskOldPlugin = $env:QT_PLUGIN_PATH
$taskOldScale = $env:QT_SCALE_FACTOR
$taskOldScreenScale = $env:QT_SCREEN_SCALE_FACTORS
$taskOldFontDirectory = $env:QT_QPA_FONTDIR
$taskOldNode = $env:LMTI_STUDIO_NODE_BINARY
$taskOldCli = $env:LMTI_STUDIO_CLI
$taskResults = @()
try {
    $env:QT_QPA_PLATFORM = $Platform
    $env:QT_PLUGIN_PATH = Join-Path $taskPackage 'plugins'
    if ($Platform -eq 'offscreen') {
        # The production package needs Windows only; simulation uses the trusted
        # matching Qt SDK's test platform plugin, never a downloaded plugin.
        $taskTestPlugins = Join-Path $taskRoot '.tools/qt/6.12.0/msvc2022_64/plugins'
        if (-not (Test-Path -LiteralPath (Join-Path $taskTestPlugins 'platforms/qoffscreen.dll') -PathType Leaf)) {
            throw 'The matching local Qt SDK offscreen plugin is required for DPI simulation.'
        }
        $env:QT_PLUGIN_PATH = $taskTestPlugins
        $taskFontDirectory = Join-Path $env:WINDIR 'Fonts'
        if (-not (Test-Path -LiteralPath $taskFontDirectory -PathType Container)) {
            throw 'Local Windows fonts are required for readable DPI simulation.'
        }
        $env:QT_QPA_FONTDIR = $taskFontDirectory
    }
    $env:QT_SCALE_FACTOR = $Scale
    $env:QT_SCREEN_SCALE_FACTORS = '1'
    $env:LMTI_STUDIO_NODE_BINARY = (Get-Command node -ErrorAction Stop).Source
    $env:LMTI_STUDIO_CLI = (Resolve-Path -LiteralPath (Join-Path $taskRoot 'packages/cli/dist/index.js')).Path
    foreach ($taskPage in $taskPages) {
        $taskImage = Join-Path $taskOutput ($taskPage.id + '-' + $Language + '.png')
        $taskStarted = [DateTime]::UtcNow
        $taskProcess = Start-Process -FilePath $taskBinary -ArgumentList @('--render-screen', ('"' + $taskImage + '"'), $taskPage.id, $Language, $Viewport) -WorkingDirectory $taskRoot -WindowStyle Hidden -PassThru
        if (-not $taskProcess.WaitForExit(45000)) {
            # This handle belongs to the disposable render process created above.
            Stop-Process -Id $taskProcess.Id
            $taskExit = -1
        } else {
            $taskProcess.WaitForExit()
            $taskExit = $taskProcess.ExitCode
        }
        $taskInfo = Get-Item -LiteralPath $taskImage -ErrorAction SilentlyContinue
        $taskSuccess = $taskExit -eq 0 -and $taskInfo -and $taskInfo.LastWriteTimeUtc -ge $taskStarted
        $taskCapture = $null
        if ($taskSuccess -and (Test-Path -LiteralPath ($taskImage + '.json') -PathType Leaf)) {
            $taskCapture = Get-Content -LiteralPath ($taskImage + '.json') -Raw -Encoding utf8 | ConvertFrom-Json
        }
        $taskDimensions = $Viewport.Split('x')
        $taskForm = $taskPage.id -in @('25-create-project', '26-edit-work-validation')
        $taskSizeMatched = $taskCapture -and ($taskForm -or
            ($taskCapture.logicalWidth -eq [int]$taskDimensions[0] -and $taskCapture.logicalHeight -eq [int]$taskDimensions[1]))
        $taskScaleNumber = [double]::Parse($Scale, [Globalization.CultureInfo]::InvariantCulture)
        # QT_SCALE_FACTOR multiplies the Windows monitor's native DPR. Offscreen
        # has a 1x base and can verify exact 100/125/150/200% simulated ratios.
        $taskScaleMatched = $taskCapture -and ($Platform -eq 'windows' -or
            [Math]::Abs($taskCapture.devicePixelRatio - $taskScaleNumber) -lt 0.01)
        $taskSuccess = $taskSuccess -and $taskSizeMatched -and $taskScaleMatched
        $taskResults += [pscustomobject]@{
            Screen = $taskPage.id
            Language = $Language
            Image = $taskImage
            ExitCode = $taskExit
            Success = [bool]$taskSuccess
            PackageHash = $taskBinaryHash
            Viewport = $Viewport
            RequestedScaleMultiplier = $Scale
            Capture = $taskCapture
            RenderedAt = $taskStarted.ToString('o')
            State = $(if ($taskPage.id -match '^1[789]-|^20-') { 'Populated disposable source via owning adapter; review grant unchanged' } else { 'Synthetic native project' })
        }
        Write-Output "$($taskPage.id): $taskSuccess"
    }
} finally {
    $env:QT_QPA_PLATFORM = $taskOldPlatform
    $env:QT_PLUGIN_PATH = $taskOldPlugin
    $env:QT_SCALE_FACTOR = $taskOldScale
    $env:QT_SCREEN_SCALE_FACTORS = $taskOldScreenScale
    $env:QT_QPA_FONTDIR = $taskOldFontDirectory
    $env:LMTI_STUDIO_NODE_BINARY = $taskOldNode
    $env:LMTI_STUDIO_CLI = $taskOldCli
}
$taskResults | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $taskOutput ('render-results-' + $Language + '.json')) -Encoding utf8
if (@($taskResults | Where-Object { -not $_.Success }).Count) { throw 'Some native renders failed; inspect render-results.' }
