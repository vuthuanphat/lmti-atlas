param(
    [string]$PackageDirectory = '',
    [string]$DataDirectory = '',
    [string]$ProjectFile = '',
    [switch]$Demo,
    [switch]$AllowLessonReview,
    [switch]$AllowImpactReview,
    [switch]$AllowGoogleDrive,
    [switch]$PrintLaunchInfo
)
$ErrorActionPreference = 'Stop'
$taskRepoRoot = Split-Path -Parent $PSScriptRoot
if (-not $PackageDirectory) {
    foreach ($taskCandidate in @('build\studio-mcp-verified-20261013', 'build\studio-mcp-20261013', 'build\studio-simple-20261013', 'build\studio-drive-20261013', 'build\studio-impact-20261013', 'build\studio-ui-fix-20261012', 'build\studio-design', 'build\studio-ui-v2', 'build\studio-ui')) {
        $taskCandidatePath = Join-Path $taskRepoRoot $taskCandidate
        if (Test-Path -LiteralPath (Join-Path $taskCandidatePath 'bin\lmti-desktop.exe') -PathType Leaf) {
            $PackageDirectory = $taskCandidatePath
            break
        }
    }
    if (-not $PackageDirectory) { throw 'Build and package Studio first.' }
}
if (-not $DataDirectory) {
    $taskExistingData = Join-Path $taskRepoRoot 'build\studio-ui\data'
    if (Test-Path -LiteralPath $taskExistingData -PathType Container) { $DataDirectory = $taskExistingData }
}
if ($DataDirectory) { $DataDirectory = (Resolve-Path -LiteralPath $DataDirectory).Path }
if ($ProjectFile) {
    if ($Demo) { throw 'Choose a saved project or Demo, not both.' }
    $ProjectFile = (Resolve-Path -LiteralPath $ProjectFile).Path
    if (-not (Test-Path -LiteralPath $ProjectFile -PathType Leaf)) { throw 'Choose a saved project file.' }
}
$taskPackageRoot = (Resolve-Path -LiteralPath $PackageDirectory).Path
$taskDesktop = Join-Path $taskPackageRoot 'bin\lmti-desktop.exe'
$taskCli = Join-Path $taskRepoRoot 'packages\cli\dist\index.js'
if (-not (Test-Path -LiteralPath $taskDesktop -PathType Leaf)) { throw 'Build and package Studio first.' }
if (-not (Test-Path -LiteralPath $taskCli -PathType Leaf)) { throw 'Build the TypeScript CLI first.' }
$taskNode = (Get-Command node -CommandType Application -ErrorAction Stop).Source
$taskPython = (Get-Command python -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$taskAgentEntry = Join-Path $taskPackageRoot 'share\lmti\scripts\lmti-agent-mcp.py'
$taskConfigOwner = Join-Path $taskPackageRoot 'share\lmti\scripts\mcp-config-owner.py'
if (-not (Test-Path -LiteralPath $taskAgentEntry -PathType Leaf)) { $taskAgentEntry = Join-Path $taskRepoRoot 'scripts\lmti-agent-mcp.py' }
if (-not (Test-Path -LiteralPath $taskConfigOwner -PathType Leaf)) { $taskConfigOwner = Join-Path $taskRepoRoot 'scripts\mcp-config-owner.py' }
$taskNodeVersion = [version](Get-Item -LiteralPath $taskNode).VersionInfo.ProductVersion
if ($taskNodeVersion.Major -lt 24) { throw 'Studio integrations require a trusted Node.js 24 or newer runtime.' }
$taskArguments = @()
$taskDriveClient = $env:LMTI_GOOGLE_CLIENT_ID
$taskDriveClientFile = Join-Path $taskPackageRoot 'share\lmti\google-drive-client.json'
if (Test-Path -LiteralPath $taskDriveClientFile -PathType Leaf) {
    if ((Get-Item -LiteralPath $taskDriveClientFile).Length -gt 4096) { throw 'Invalid publisher Google Drive configuration.' }
    $taskDriveConfig = Get-Content -LiteralPath $taskDriveClientFile -Raw | ConvertFrom-Json
    if (@($taskDriveConfig.PSObject.Properties.Name).Count -ne 1 -or $taskDriveConfig.clientId -isnot [string]) { throw 'Invalid publisher Google Drive configuration.' }
    $taskDriveClient = $taskDriveConfig.clientId
}
if ($taskDriveClient -and $taskDriveClient -cnotmatch '^[A-Za-z0-9][A-Za-z0-9_-]{0,199}\.apps\.googleusercontent\.com$') { throw 'Invalid publisher Google Drive configuration.' }
$taskDriveEnabled = [bool]$AllowGoogleDrive -or [bool]$taskDriveClient
if ($DataDirectory) { $taskArguments += @('--data-directory', $DataDirectory) }
if ($Demo) { $taskArguments += '--demo' }
if ($ProjectFile) { $taskArguments += $ProjectFile }
if ($PrintLaunchInfo) {
    [pscustomobject]@{
        Package = $taskPackageRoot
        Desktop = $taskDesktop
        DesktopHash = (Get-FileHash -LiteralPath $taskDesktop -Algorithm SHA256).Hash
        DataDirectory = $DataDirectory
        Arguments = $taskArguments
        LessonReview = [bool]$AllowLessonReview
        ImpactReview = [bool]$AllowImpactReview
        GoogleDrive = $taskDriveEnabled
        GoogleDriveConfigured = [bool]$taskDriveClient
    }
    return
}
$taskPreviousNode = $env:LMTI_STUDIO_NODE_BINARY
$taskPreviousCli = $env:LMTI_STUDIO_CLI
$taskPreviousReview = $env:LMTI_STUDIO_ALLOW_LESSON_REVIEW
$taskPreviousImpactReview = $env:LMTI_STUDIO_ALLOW_IMPACT_REVIEW
$taskPreviousDrive = $env:LMTI_STUDIO_ALLOW_GOOGLE_DRIVE
$taskPreviousClient = $env:LMTI_GOOGLE_CLIENT_ID
$taskPreviousPython = $env:LMTI_STUDIO_PYTHON_BINARY
$taskPreviousAgentEntry = $env:LMTI_STUDIO_AGENT_ENTRY
$taskPreviousConfigOwner = $env:LMTI_STUDIO_MCP_CONFIG_OWNER
try {
    $env:LMTI_STUDIO_PYTHON_BINARY = $taskPython
    $env:LMTI_STUDIO_AGENT_ENTRY = $taskAgentEntry
    $env:LMTI_STUDIO_MCP_CONFIG_OWNER = $taskConfigOwner
    $env:LMTI_STUDIO_NODE_BINARY = $taskNode
    $env:LMTI_STUDIO_CLI = $taskCli
    $env:LMTI_STUDIO_ALLOW_LESSON_REVIEW = if ($AllowLessonReview) { '1' } else { '0' }
    $env:LMTI_STUDIO_ALLOW_IMPACT_REVIEW = if ($AllowImpactReview) { '1' } else { '0' }
    $env:LMTI_STUDIO_ALLOW_GOOGLE_DRIVE = if ($taskDriveEnabled) { '1' } else { '0' }
    $env:LMTI_GOOGLE_CLIENT_ID = $taskDriveClient
    & $taskDesktop @taskArguments
} finally {
    $env:LMTI_STUDIO_PYTHON_BINARY = $taskPreviousPython
    $env:LMTI_STUDIO_AGENT_ENTRY = $taskPreviousAgentEntry
    $env:LMTI_STUDIO_MCP_CONFIG_OWNER = $taskPreviousConfigOwner
    $env:LMTI_STUDIO_NODE_BINARY = $taskPreviousNode
    $env:LMTI_STUDIO_CLI = $taskPreviousCli
    $env:LMTI_STUDIO_ALLOW_LESSON_REVIEW = $taskPreviousReview
    $env:LMTI_STUDIO_ALLOW_IMPACT_REVIEW = $taskPreviousImpactReview
    $env:LMTI_STUDIO_ALLOW_GOOGLE_DRIVE = $taskPreviousDrive
    $env:LMTI_GOOGLE_CLIENT_ID = $taskPreviousClient
}
