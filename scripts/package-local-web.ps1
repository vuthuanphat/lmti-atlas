param(
    [string]$NativePackage = 'build/studio-projection-native-20261014',
    [string]$AdminPackage = 'build/studio-projection-native-20261014',
    [string]$AuditAclHelper = 'build/audit-acl/bin/lmti-audit-acl.exe',
    [string]$OutputDirectory = 'build/studio-web03-projection-20261014',
    [switch]$SkipWebBuild
)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskBuildRoot = [IO.Path]::GetFullPath((Join-Path $taskRoot 'build')) + [IO.Path]::DirectorySeparatorChar
function Resolve-BuildPath([string]$Relative) {
    if ([IO.Path]::IsPathRooted($Relative)) { throw 'Choose a repository-relative build path.' }
    $taskPath = [IO.Path]::GetFullPath((Join-Path $taskRoot $Relative))
    if (-not $taskPath.StartsWith($taskBuildRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Package paths must stay inside build/.' }
    return $taskPath
}
$taskNative = Resolve-BuildPath $NativePackage
$taskAdmin = Resolve-BuildPath $AdminPackage
$taskAuditAclHelper = Resolve-BuildPath $AuditAclHelper
$taskOutput = Resolve-BuildPath $OutputDirectory
if (Test-Path -LiteralPath $taskOutput) { throw 'Choose a fresh package directory; existing packages are preserved.' }
foreach ($taskPath in @((Join-Path $taskNative 'bin/lmti-desktop.exe'), (Join-Path $taskAdmin 'bin/lmti-mcp-admin.exe'), $taskAuditAclHelper)) {
    if (-not (Test-Path -LiteralPath $taskPath -PathType Leaf)) { throw 'Build the trusted native packages first.' }
}
if ((Get-Item -LiteralPath $taskAuditAclHelper).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Linked audit ACL helper refused.' }
for ($taskAclPath = (Get-Item -LiteralPath $taskAuditAclHelper).Directory; $null -ne $taskAclPath; $taskAclPath = $taskAclPath.Parent) {
    if ($taskAclPath.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Linked audit ACL helper path refused.' }
}
foreach ($taskSource in @($taskNative,$taskAdmin)) {
    if (Get-ChildItem -LiteralPath $taskSource -Recurse -Force | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }) { throw 'Package inputs must not contain links.' }
}
if (-not $SkipWebBuild) {
    Push-Location $taskRoot
    try { & corepack pnpm web:build; if ($LASTEXITCODE -ne 0) { throw 'Web build failed.' } } finally { Pop-Location }
}
New-Item -ItemType Directory -Path $taskOutput | Out-Null
foreach ($taskFolder in @('bin','plugins','share')) { Copy-Item -LiteralPath (Join-Path $taskNative $taskFolder) -Destination $taskOutput -Recurse }
foreach ($taskBinary in @('lmti-mcp-admin.exe','lmti-project.exe')) { Copy-Item -LiteralPath (Join-Path $taskAdmin "bin/$taskBinary") -Destination (Join-Path $taskOutput 'bin') }
Copy-Item -LiteralPath $taskAuditAclHelper -Destination (Join-Path $taskOutput 'bin/lmti-audit-acl.exe')
New-Item -ItemType Directory -Path (Join-Path $taskOutput 'apps/web-api'),(Join-Path $taskOutput 'apps/web-ui'),(Join-Path $taskOutput 'scripts') | Out-Null
Copy-Item -LiteralPath (Join-Path $taskRoot 'apps/web-api/dist') -Destination (Join-Path $taskOutput 'apps/web-api') -Recurse
Copy-Item -LiteralPath (Join-Path $taskRoot 'apps/web-api/package.json') -Destination (Join-Path $taskOutput 'apps/web-api')
Copy-Item -LiteralPath (Join-Path $taskRoot 'apps/web-ui/dist') -Destination (Join-Path $taskOutput 'apps/web-ui') -Recurse
foreach ($taskScript in @('lmti-agent-mcp.py','mcp-config-owner.py','agent-read-owner.py','web-broker-guard.py')) { Copy-Item -LiteralPath (Join-Path $taskRoot "scripts/$taskScript") -Destination (Join-Path $taskOutput 'share/lmti/scripts') }
# Refresh Python sources after native installation; include all integrated adapters.
$taskPythonSource = Join-Path $taskRoot 'python/src'
if (Get-ChildItem -LiteralPath $taskPythonSource -Recurse -Force | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }) { throw 'Linked Python sources refused.' }
foreach ($taskPythonFile in (Get-ChildItem -LiteralPath $taskPythonSource -Recurse -File -Filter '*.py')) {
    if ($taskPythonFile.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Linked Python source refused.' }
    $taskRelative = $taskPythonFile.FullName.Substring($taskPythonSource.Length + 1)
    $taskDestination = Join-Path (Join-Path $taskOutput 'share/lmti/python/src') $taskRelative
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $taskDestination) | Out-Null
    Copy-Item -LiteralPath $taskPythonFile.FullName -Destination $taskDestination
}
& node (Join-Path $taskRoot 'scripts/build-agent-knowledge-owner.mjs') (Join-Path $taskOutput 'share/lmti/knowledge-owner')
if ($LASTEXITCODE -ne 0) { throw 'Knowledge owner bundle failed.' }
& node (Join-Path $taskRoot 'scripts/build-agent-mapping-owner.mjs') (Join-Path $taskOutput 'share/lmti/mapping-owner')
if ($LASTEXITCODE -ne 0) { throw 'Mapping owner bundle failed.' }
foreach ($taskScript in @('start-local-web.ps1','start-local-studio-fallback.ps1','test-local-web-package.ps1')) { Copy-Item -LiteralPath (Join-Path $taskRoot "scripts/$taskScript") -Destination (Join-Path $taskOutput 'scripts') }
$taskReadme = [IO.File]::ReadAllText((Join-Path $taskRoot 'docs/local-web.md'))
$taskReadme = $taskReadme.Replace('](plans/', '](share/lmti/plans/').Replace('](benchmarks/', '](share/lmti/benchmarks/')
[IO.File]::WriteAllText((Join-Path $taskOutput 'README.md'), $taskReadme, [Text.UTF8Encoding]::new($false))
foreach ($taskDocument in @('plans/2026-10-19-integrated-mvp.md','benchmarks/2026-10-14-web-local-baseline.md')) {
    $taskDocumentTarget = Join-Path (Join-Path $taskOutput 'share/lmti') $taskDocument
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $taskDocumentTarget) | Out-Null
    Copy-Item -LiteralPath (Join-Path (Join-Path $taskRoot 'docs') $taskDocument) -Destination $taskDocumentTarget
}
$taskLicenseFolder=Join-Path $taskOutput 'share/lmti/third-party/web'
New-Item -ItemType Directory -Force -Path $taskLicenseFolder | Out-Null
foreach ($taskName in @('react','react-dom')) {
    Copy-Item -LiteralPath (Join-Path $taskRoot "apps/web-ui/node_modules/$taskName/LICENSE") -Destination (Join-Path $taskLicenseFolder "$taskName-LICENSE.txt")
}
$taskReactDom=(Resolve-Path -LiteralPath (Join-Path $taskRoot 'apps/web-ui/node_modules/react-dom')).Path
$taskScheduler=Join-Path (Split-Path -Parent $taskReactDom) 'scheduler/LICENSE'
if (-not (Test-Path -LiteralPath $taskScheduler)) {
    $taskScheduler=Join-Path $taskRoot 'node_modules/.pnpm/scheduler@0.28.0/node_modules/scheduler/LICENSE'
}
Copy-Item -LiteralPath $taskScheduler -Destination (Join-Path $taskLicenseFolder 'scheduler-LICENSE.txt')
foreach ($taskReleaseDocument in @('LICENSE','THIRD-PARTY-NOTICES.txt')) {
    Copy-Item -LiteralPath (Join-Path $taskRoot $taskReleaseDocument) -Destination $taskOutput
}
Copy-Item -LiteralPath (Join-Path $taskRoot 'docs/releases/v0.2.0-alpha.1.md') -Destination (Join-Path $taskOutput 'RELEASE-NOTES.md')
$taskQtNotices = Join-Path $taskRoot 'docs/third-party/qt'
if (-not (Test-Path -LiteralPath $taskQtNotices -PathType Container)) { throw 'Prepare the matching Qt license/source inventory before packaging.' }
Copy-Item -LiteralPath $taskQtNotices -Destination (Join-Path $taskOutput 'share/lmti/third-party') -Recurse
Copy-Item -LiteralPath (Join-Path $taskQtNotices 'QT-SOURCE.md') -Destination $taskOutput
foreach ($taskInventory in @('dependencies.json','build-dependencies.cdx.json')) {
    Copy-Item -LiteralPath (Join-Path $taskRoot "docs/third-party/$taskInventory") -Destination (Join-Path $taskOutput 'share/lmti/third-party')
}
$taskReleaseVersion = (Get-Content -LiteralPath (Join-Path $taskRoot 'package.json') -Raw | ConvertFrom-Json).version
$taskReleaseCommit = (& git -C $taskRoot rev-parse HEAD)
if ($LASTEXITCODE -ne 0 -or $taskReleaseCommit -cnotmatch '^[a-f0-9]{40}$') { throw 'A source commit is required for release provenance.' }
[IO.File]::WriteAllText((Join-Path $taskOutput 'release.json'), (@{ schema='lmti.release.v1'; version=$taskReleaseVersion; sourceCommit=$taskReleaseCommit; pythonVersion='0.2.0a1'; nativeVersion='0.2.0'; platform='windows-x64'; publication='local-candidate' } | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
# Bytecode is runtime-generated and must never be publisher-hashed. A native
# package may have been exercised before web packaging and contain old caches.
foreach ($taskCache in (Get-ChildItem -LiteralPath $taskOutput -Recurse -File -Filter '*.pyc')) {
    $taskCachePath = [IO.Path]::GetFullPath($taskCache.FullName)
    if (-not $taskCachePath.StartsWith($taskOutput + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Cache path escaped the fresh package.' }
    Remove-Item -LiteralPath $taskCachePath -Force
}
$taskManifest = @(Get-ChildItem -LiteralPath $taskOutput -File -Recurse -Force | Sort-Object FullName | ForEach-Object {
    @{ file = $_.FullName.Substring($taskOutput.Length + 1).Replace('\','/'); sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash }
})
[IO.File]::WriteAllText((Join-Path $taskOutput 'manifest.json'), (@{ schema='lmti.local-web.package.v1'; requires=@('Windows x64','Node.js >=24','Python >=3.11','Compatible MSVC runtime'); files=$taskManifest } | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
[pscustomobject]@{ Package=$taskOutput; Launcher=Join-Path $taskOutput 'scripts/start-local-web.ps1'; QtFallback=Join-Path $taskOutput 'scripts/start-local-studio-fallback.ps1' }
