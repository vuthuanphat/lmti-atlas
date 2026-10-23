param(
    [Parameter(Mandatory=$true)][string]$DataDirectory,
    [string]$PackageDirectory = '',
    [string[]]$ProjectId = @(),
    [ValidateRange(0,65535)][int]$Port = 0,
    [string]$AgentSite = '',
    [ValidateSet('external','local')][string]$AgentTarget = 'external',
    [string]$IntegrationConfig = '',
    [switch]$ProjectContent,
    [string[]]$ContentProjectId = @(),
    [string]$LibraryManagementFile = '',
    [switch]$ProjectOperations,
    [string[]]$OperationProjectId = @(),
    [string]$CopyParent = '',
    [string]$BackupParent = '',
    [switch]$AllowLibraryUpgrade,
    [switch]$LogicalHierarchy,
    [string[]]$HierarchyProjectId = @(),
    [string[]]$HierarchyInternalProjectId = @(),
    [switch]$PhysicalHierarchy,
    [string[]]$PhysicalHierarchyProjectId = @(),
    [string[]]$PhysicalHierarchyInternalProjectId = @(),
    [switch]$NoBrowser
)
$ErrorActionPreference = 'Stop'
foreach ($taskLocation in @($DataDirectory,$PackageDirectory,$IntegrationConfig,$CopyParent,$BackupParent,$LibraryManagementFile)) {
    if ($taskLocation.Length -gt 1024 -or $taskLocation -match '[\x00-\x1f\x7f<>"|?*]' -or $taskLocation.Replace('\','/').StartsWith('//')) { throw 'Use local Studio data and package directories; network/device paths are refused before filesystem access.' }
    $taskWithoutDrive = $taskLocation -replace '^[A-Za-z]:[\\/]', ''
    if ($taskWithoutDrive.Contains(':')) { throw 'Alternate data streams and drive-relative paths are refused.' }
}
# Operation grants come only from explicit launcher arguments, never inventory.
if (-not $ProjectOperations -and ($OperationProjectId.Count -or $CopyParent -or $BackupParent -or $AllowLibraryUpgrade)) { throw 'Project operation arguments require ProjectOperations.' }
if ($ProjectOperations -and (-not $CopyParent -or -not $BackupParent -or ($OperationProjectId.Count -eq 0 -and -not $AllowLibraryUpgrade))) { throw 'Specify both existing operation parents and explicit project IDs or library maintenance.' }
if (-not $LogicalHierarchy -and ($HierarchyProjectId.Count -or $HierarchyInternalProjectId.Count)) { throw 'Hierarchy grants require LogicalHierarchy.' }
if ($LogicalHierarchy -and $HierarchyProjectId.Count -eq 0) { throw 'Specify explicit HierarchyProjectId grants.' }
if (-not $PhysicalHierarchy -and ($PhysicalHierarchyProjectId.Count -or $PhysicalHierarchyInternalProjectId.Count)) { throw 'Physical hierarchy grants require PhysicalHierarchy.' }
if ($PhysicalHierarchy -and $PhysicalHierarchyProjectId.Count -eq 0) { throw 'Specify explicit PhysicalHierarchyProjectId grants.' }
function Assert-ProjectIds([string[]]$Ids) {
    if ($Ids.Count -gt 500 -or @($Ids | Select-Object -Unique).Count -ne $Ids.Count) { throw 'Project grants must be unique and bounded.' }
    foreach ($taskId in $Ids) { if ($taskId -cnotmatch '^[A-Za-z][A-Za-z0-9._-]{0,63}$') { throw 'A project grant is invalid.' } }
}
Assert-ProjectIds $ContentProjectId
if ($ProjectContent -and -not $ContentProjectId.Count) { throw 'Specify explicit ContentProjectId grants.' }
if (-not $ProjectContent -and $ContentProjectId.Count) { throw 'ContentProjectId requires ProjectContent.' }
Assert-ProjectIds $ProjectId
Assert-ProjectIds $OperationProjectId
Assert-ProjectIds $HierarchyProjectId
Assert-ProjectIds $HierarchyInternalProjectId
foreach ($taskId in $HierarchyInternalProjectId) {
    if ($HierarchyProjectId -cnotcontains $taskId) { throw 'Internal hierarchy grants must be within explicit hierarchy project grants.' }
}
Assert-ProjectIds $PhysicalHierarchyProjectId
Assert-ProjectIds $PhysicalHierarchyInternalProjectId
foreach ($taskId in $PhysicalHierarchyInternalProjectId) {
    if ($PhysicalHierarchyProjectId -cnotcontains $taskId) { throw 'Internal physical grants must be within explicit physical project grants.' }
}
function Assert-OperationSpelling([string]$Location) {
    if (-not $Location -or $Location.Length -gt 1024 -or $Location -notmatch '^[A-Za-z]:[\\/]' -or
        $Location -match '[\x00-\x1f\x7f<>"|?*]' -or $Location.Substring(2).Contains(':')) { throw 'Operation paths must be clean absolute local paths.' }
    $taskTail = $Location.Substring(3).Replace('\','/')
    if ($taskTail) {
        foreach ($taskPart in $taskTail.Split('/')) {
            if (-not $taskPart -or $taskPart -in @('.','..') -or $taskPart -match '[. ]$' -or
                $taskPart -match '^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)') { throw 'Operation paths contain an unsupported component.' }
        }
    }
}
if ($ProjectOperations -or $LogicalHierarchy -or $PhysicalHierarchy) {
    Assert-OperationSpelling $DataDirectory
    if ($ProjectOperations) { foreach ($taskLocation in @($CopyParent,$BackupParent)) { Assert-OperationSpelling $taskLocation } }
    if ($PackageDirectory) { Assert-OperationSpelling $PackageDirectory }
    if ($IntegrationConfig) { Assert-OperationSpelling $IntegrationConfig }
}
if ($IntegrationConfig -and -not $AgentSite) { throw 'IntegrationConfig requires an explicit AgentSite.' }
if ($AgentSite -and ($ProjectId.Count -ne 1 -or $AgentSite -notmatch '^[A-Za-z][A-Za-z0-9_.-]{0,63}$')) { throw 'Read access requires one explicit ProjectId and a valid AgentSite.' }
function Assert-LocalOwnerPath([string]$Location) {
    # Check parents from the volume down, before resolving a child through them.
    $taskAbsolute = [IO.Path]::GetFullPath($Location)
    $taskVolume = [IO.Path]::GetPathRoot($taskAbsolute)
    $taskCursor = $taskVolume
    $taskSegments = @('') + @($taskAbsolute.Substring($taskVolume.Length) -split '[\\/]' | Where-Object { $_.Length -gt 0 })
    foreach ($taskSegment in $taskSegments) {
        if ($taskSegment) { $taskCursor = Join-Path $taskCursor $taskSegment }
        $taskItem = Get-Item -LiteralPath $taskCursor -Force
        if ($taskItem.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Linked launcher paths are refused before resolution.' }
    }
}
Assert-LocalOwnerPath $DataDirectory
if ($IntegrationConfig) { Assert-LocalOwnerPath $IntegrationConfig }
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskData = (Resolve-Path -LiteralPath $DataDirectory).Path
if (-not (Test-Path -LiteralPath $taskData -PathType Container)) { throw 'Choose an existing Studio data directory.' }
if (-not $PackageDirectory) {
    $PackageDirectory = if (Test-Path -LiteralPath (Join-Path $taskRoot 'bin/lmti-mcp-admin.exe')) { $taskRoot } else { Join-Path $taskRoot 'build/lmti-v0.2.0-alpha.1-windows-x64' }
}
Assert-LocalOwnerPath $PackageDirectory
$taskPackage = (Resolve-Path -LiteralPath $PackageDirectory).Path
if ($ProjectOperations) {
    Assert-OperationSpelling $taskPackage
    $taskParents = @()
    foreach ($taskLocation in @($CopyParent,$BackupParent,$taskData)) {
        Assert-LocalOwnerPath $taskLocation
        $taskFixed = (Resolve-Path -LiteralPath $taskLocation).Path
        if (-not (Test-Path -LiteralPath $taskFixed -PathType Container) -or
            (@($taskFixed -split '[\\/]') -icontains '.lmti') -or
            $taskFixed.Equals($taskPackage,[StringComparison]::OrdinalIgnoreCase) -or
            $taskFixed.StartsWith($taskPackage.TrimEnd('\','/') + '\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Operation data must use existing local directories outside the package and .lmti.' }
        $taskParents += $taskFixed
    }
    if ($taskParents[0].Equals($taskParents[1],[StringComparison]::OrdinalIgnoreCase)) { throw 'Copy and backup parents must differ.' }
    $CopyParent = $taskParents[0]; $BackupParent = $taskParents[1]
}
if ($LogicalHierarchy -or $PhysicalHierarchy) {
    Assert-OperationSpelling $taskPackage
    if ((@($taskData -split '[\\/]') -icontains '.lmti') -or
        $taskData.Equals($taskPackage,[StringComparison]::OrdinalIgnoreCase) -or
        $taskData.StartsWith($taskPackage.TrimEnd('\','/') + '\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Hierarchy data must be outside the package and .lmti.' }
}
& (Join-Path $PSScriptRoot 'test-local-web-package.ps1') -PackageDirectory $taskPackage | Out-Null
$taskNode = (Get-Command node -CommandType Application | Select-Object -First 1).Source
$taskPython = (Get-Command python -CommandType Application | Select-Object -First 1).Source
if ($ProjectOperations -or $LogicalHierarchy -or $PhysicalHierarchy) { foreach ($taskRuntime in @($taskNode,$taskPython)) { Assert-OperationSpelling $taskRuntime; Assert-LocalOwnerPath $taskRuntime } }
if ([version](Get-Item -LiteralPath $taskNode).VersionInfo.ProductVersion -lt [version]'24.0.0') { throw 'Use the trusted Node.js 24 or newer runtime.' }
$taskMain = Join-Path $taskPackage 'apps/web-api/dist/main.js'
if (-not (Test-Path -LiteralPath $taskMain -PathType Leaf)) { throw 'Build and package the local web UI first.' }
$taskConfig = @{
    adminBinary = Join-Path $taskPackage 'bin/lmti-mcp-admin.exe'
    projectBinary = Join-Path $taskPackage 'bin/lmti-project.exe'
    library = Join-Path $taskData 'project-library.sqlite'
    profiles = Join-Path $taskData 'mcp-profiles.sqlite'
    python = $taskPython
    agentEntry = Join-Path $taskPackage 'share/lmti/scripts/lmti-agent-mcp.py'
    configOwner = Join-Path $taskPackage 'share/lmti/scripts/mcp-config-owner.py'
    allowedProjects = @($ProjectId)
    port = $Port
    openBrowser = -not [bool]$NoBrowser
}
foreach ($taskPath in @($taskConfig.adminBinary,$taskConfig.projectBinary,$taskConfig.agentEntry,$taskConfig.configOwner)) {
    if (-not (Test-Path -LiteralPath $taskPath -PathType Leaf)) { throw 'The trusted local web package is incomplete.' }
}
function New-OwnerProcess {
    param([string]$Binary,[string[]]$Arguments)
    $taskStart = [Diagnostics.ProcessStartInfo]::new()
    $taskStart.FileName = $Binary
    $taskStart.Arguments = ($Arguments | ForEach-Object { if ($_ -match '["\r\n]') { throw 'Invalid launcher argument.' }; '"' + $_ + '"' }) -join ' '
    $taskStart.WorkingDirectory = $taskRoot
    $taskStart.UseShellExecute = $false
    $taskStart.CreateNoWindow = $true
    $taskStart.RedirectStandardInput = $true
    $taskStart.RedirectStandardOutput = $true
    $taskStart.RedirectStandardError = $true
    $taskStart.StandardOutputEncoding = [Text.UTF8Encoding]::new($false,$true)
    $taskStart.StandardErrorEncoding = [Text.UTF8Encoding]::new($false,$true)
    $taskStart.EnvironmentVariables.Clear()
    foreach ($taskEnvKey in @('SystemRoot','WINDIR')) { if ([Environment]::GetEnvironmentVariable($taskEnvKey)) { $taskStart.EnvironmentVariables[$taskEnvKey] = [Environment]::GetEnvironmentVariable($taskEnvKey) } }
    [Diagnostics.Process]::Start($taskStart)
}
function Send-OwnerJson {
    param([Diagnostics.Process]$Owner,[string]$Json)
    # Windows PowerShell 5 has no StandardInputEncoding property. Its default
    # writer uses the console code page, so use a separate UTF-8 writer and
    # close that writer (not the unused default writer) to send EOF once.
    $taskWriter=[IO.StreamWriter]::new($Owner.StandardInput.BaseStream,[Text.UTF8Encoding]::new($false))
    try { $taskWriter.NewLine="`n"; $taskWriter.WriteLine($Json); $taskWriter.Flush() }
    finally { $taskWriter.Dispose() }
}
if ($ProjectId.Count -eq 0) {
    # Local operator grants are frozen to the currently registered IDs. No Agent grants.
    $taskCatalog = New-OwnerProcess $taskConfig.adminBinary @('--library',$taskConfig.library,'--profiles',$taskConfig.profiles,'--python',$taskPython,'--entry',$taskConfig.agentEntry,'--binary',$taskConfig.projectBinary)
    Send-OwnerJson $taskCatalog '{"action":"library"}'
    $taskCatalogRead = $taskCatalog.StandardOutput.ReadToEndAsync()
    if (-not $taskCatalog.WaitForExit(10000)) { $taskCatalog.Kill(); throw 'Library inspection timed out.' }
    $taskCatalogText = $taskCatalogRead.GetAwaiter().GetResult()
    if ($taskCatalog.ExitCode -ne 0 -or $taskCatalogText.Length -gt 1048576) { throw 'Library inspection failed.' }
    $taskCatalogValue = $taskCatalogText | ConvertFrom-Json
    if (-not $taskCatalogValue.ok) { throw 'The native library is unavailable.' }
    $taskConfig.allowedProjects = @($taskCatalogValue.items | ForEach-Object { $_.id })
}
if ($LibraryManagementFile) {
    Assert-OperationSpelling $LibraryManagementFile
    Assert-LocalOwnerPath $LibraryManagementFile
    $taskLibraryGrantFile=Get-Item -LiteralPath $LibraryManagementFile
    if ($taskLibraryGrantFile.PSIsContainer -or $taskLibraryGrantFile.Length -gt 12288) { throw 'Use a reviewed library management JSON file within 12 KiB.' }
    $taskConfig.libraryManagement=Get-Content -LiteralPath $taskLibraryGrantFile.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
}
if ($ProjectContent) {
    foreach ($taskId in $ContentProjectId) {
        if ($taskConfig.allowedProjects -cnotcontains $taskId) { throw 'Content edit IDs must be within explicit UI scope.' }
    }
    $taskConfig.projectContent = @{projectIds=@($ContentProjectId)}
}
if ($ProjectOperations) {
    Assert-ProjectIds @($taskConfig.allowedProjects)
    foreach ($taskId in $OperationProjectId) {
        if ($taskConfig.allowedProjects -cnotcontains $taskId) { throw 'Operation project IDs must be within the explicit UI scope.' }
    }
    $taskGuard = Join-Path $taskPackage 'share/lmti/scripts/web-broker-guard.py'
    Assert-LocalOwnerPath $taskGuard
    if (-not (Test-Path -LiteralPath $taskGuard -PathType Leaf)) { throw 'The package is missing its fixed broker guard.' }
    $taskConfig.projectOperations = @{
        copyParent = $CopyParent
        backupParent = $BackupParent
        projectIds = @($OperationProjectId)
        allowLibraryUpgrade = [bool]$AllowLibraryUpgrade
    }
}
if ($LogicalHierarchy) {
    Assert-ProjectIds @($taskConfig.allowedProjects)
    foreach ($taskId in $HierarchyProjectId) {
        if ($taskConfig.allowedProjects -cnotcontains $taskId) { throw 'Hierarchy project IDs must be within the UI scope.' }
    }
    $taskGuard = Join-Path $taskPackage 'share/lmti/scripts/web-broker-guard.py'
    Assert-LocalOwnerPath $taskGuard
    if (-not (Test-Path -LiteralPath $taskGuard -PathType Leaf)) { throw 'The package is missing its fixed broker guard.' }
    $taskConfig.logicalHierarchy = @{
        projects = @($HierarchyProjectId | ForEach-Object { @{projectId=$_;allowInternal=[bool]($HierarchyInternalProjectId -ccontains $_)} })
    }
}
if ($PhysicalHierarchy) {
    Assert-ProjectIds @($taskConfig.allowedProjects)
    foreach ($taskId in $PhysicalHierarchyProjectId) {
        if ($taskConfig.allowedProjects -cnotcontains $taskId) { throw 'Physical hierarchy project IDs must be within the UI scope.' }
    }
    $taskGuard = Join-Path $taskPackage 'share/lmti/scripts/web-broker-guard.py'
    Assert-LocalOwnerPath $taskGuard
    if (-not (Test-Path -LiteralPath $taskGuard -PathType Leaf)) { throw 'The package is missing its fixed broker guard.' }
    $taskConfig.physicalHierarchy = @{
        projects = @($PhysicalHierarchyProjectId | ForEach-Object { @{projectId=$_;allowInternal=[bool]($PhysicalHierarchyInternalProjectId -ccontains $_)} })
    }
}
if ($AgentSite) {
    $taskReadEntry = Join-Path $taskPackage 'share/lmti/scripts/agent-read-owner.py'
    if (-not (Test-Path -LiteralPath $taskReadEntry -PathType Leaf)) { throw 'The package is missing its fixed read owner.' }
    $taskIntegration = $null
    if ($IntegrationConfig) { $taskIntegration = [IO.Path]::GetFullPath($IntegrationConfig) }
    $taskConfig.agentRead = @{
        entry = $taskReadEntry
        projects = @(@{ projectId=$ProjectId[0]; site=$AgentSite; target=$AgentTarget; integrationConfig=$taskIntegration })
    }
}
# Only trusted paths/IDs cross stdin. The service creates the private one-use nonce.
$taskInput = $taskConfig | ConvertTo-Json -Compress -Depth 8
# Include the one LF written below. Refuse before starting a broker, not after it.
if ([Text.Encoding]::UTF8.GetByteCount($taskInput) + 1 -gt 16384) { throw 'Trusted launch configuration exceeds the 16 KiB input limit.' }
$taskProcess = New-OwnerProcess $taskNode @($taskMain)
Send-OwnerJson $taskProcess $taskInput
$taskLaunchRead = $taskProcess.StandardOutput.ReadLineAsync()
if (-not $taskLaunchRead.Wait(10000)) { throw 'Local API startup timed out. No anonymous access was enabled.' }
$taskLaunchLine = $taskLaunchRead.GetAwaiter().GetResult()
if (-not $taskLaunchLine) { throw 'Local API could not start. Check the package and selected data directory.' }
$taskInfo = $taskLaunchLine | ConvertFrom-Json
if ($taskInfo.kind -ne 'lmti-local-api') { throw 'Unexpected launcher response.' }
$taskInfo
