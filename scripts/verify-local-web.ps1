param(
    [string]$PackageDirectory='build/lmti-v0.2.0-alpha.1-windows-x64',
    [string]$NativeBuildDirectory='build/native'
)
$ErrorActionPreference='Stop'
$taskRoot=Split-Path -Parent $PSScriptRoot
function Resolve-LocalVerificationPath([string]$Location) {
    if ($Location.Length -gt 1024 -or $Location -match '[\x00-\x1f"]' -or $Location.Replace('\','/').StartsWith('//')) { throw 'Verification uses local trusted paths; network/device paths are refused.' }
    $taskLocation=if ([IO.Path]::IsPathRooted($Location)) { $Location } else { Join-Path $taskRoot $Location }
    $taskResolved=(Resolve-Path -LiteralPath $taskLocation).Path
    for ($taskAncestor=$taskResolved; $taskAncestor; $taskAncestor=Split-Path -Parent $taskAncestor) {
        if ((Get-Item -LiteralPath $taskAncestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Verification runtime/build links are refused.' }
    }
    return $taskResolved
}
$taskPackage=Resolve-LocalVerificationPath $PackageDirectory
$taskNative=Resolve-LocalVerificationPath $NativeBuildDirectory
$taskNode=Resolve-LocalVerificationPath ((Get-Command node -CommandType Application|Select-Object -First 1).Source)
$taskPython=Resolve-LocalVerificationPath ((Get-Command python -CommandType Application|Select-Object -First 1).Source)
$taskProducer=Resolve-LocalVerificationPath (Join-Path $taskNative 'bin/Release/lmti-mcp-profile-tests.exe')
$taskBindingProducer=Resolve-LocalVerificationPath (Join-Path $taskNative 'bin/Release/lmti-mcp-binding-identity-tests.exe')
$taskWriteAdmin=Resolve-LocalVerificationPath (Join-Path $taskNative 'bin/Release/lmti-project-operation-write-test-admin.exe')
$taskBuildPrefix=[IO.Path]::GetFullPath((Join-Path $taskRoot 'build'))+[IO.Path]::DirectorySeparatorChar
foreach($taskLocation in @($taskPackage,$taskNative)) { if(-not $taskLocation.StartsWith($taskBuildPrefix,[StringComparison]::OrdinalIgnoreCase)) { throw 'Use synthetic build/package directories inside repository build/.' } }
$taskEvidence=Join-Path $taskRoot ('build/web-verification-'+[Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $taskEvidence|Out-Null
$taskTemporary=Join-Path $taskEvidence 'temporary'
New-Item -ItemType Directory -Path $taskTemporary|Out-Null
$taskEnvironment=@{
    # Some Windows hosts expose TEMP through an 8.3 alias. Fixtures must use
    # canonical owned paths so positive controls reach the real boundary.
    TEMP=$taskTemporary;TMP=$taskTemporary
    LMTI_WEB_TEST_PYTHON=$taskPython;LMTI_WEB_TEST_PACKAGE=$taskPackage
    LMTI_WEB_TEST_PRODUCER=$taskProducer
    LMTI_WEB_TEST_BINDING_PRODUCER=$taskBindingProducer
    LMTI_WEB_TEST_CONFIG_OWNER=(Join-Path $taskPackage 'share/lmti/scripts/mcp-config-owner.py')
    LMTI_WEB_TEST_AGENT_OWNER=(Join-Path $taskPackage 'share/lmti/scripts/agent-read-owner.py')
    LMTI_WEB_TEST_BROKER_GUARD=(Join-Path $taskPackage 'share/lmti/scripts/web-broker-guard.py')
    LMTI_WEB_TEST_ADMIN=(Join-Path $taskPackage 'bin/lmti-mcp-admin.exe')
    LMTI_WEB_TEST_PROJECT_BINARY=(Join-Path $taskPackage 'bin/lmti-project.exe')
    LMTI_WEB_TEST_HIERARCHY_ADMIN=(Join-Path $taskPackage 'bin/lmti-mcp-admin.exe')
    LMTI_WEB_TEST_UPGRADE_WRITE_ADMIN=$taskWriteAdmin
    LMTI_WEB_TEST_POWERSHELL=(Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe')
    LMTI_WEB_TEST_TMP=$taskTemporary
    LMTI_WORKSPACE_TEST_UI_ROOT=(Join-Path $taskRoot 'apps/web-ui')
    LMTI_STRUCTURE_TEST_UI_ROOT=(Join-Path $taskRoot 'apps/web-ui')
    LMTI_HIERARCHY_TEST_UI_ROOT=(Join-Path $taskRoot 'apps/web-ui')
    LMTI_OPERATIONS_TEST_UI_ROOT=(Join-Path $taskRoot 'apps/web-ui')
}
$taskPrevious=@{}
$taskReport=[ordered]@{schema='lmti.local-web.verification.v1';allSelectedChecksPassed=$false;checks=@();
    externalAcceptance=@('actual Cursor','provider OAuth/reachability','independent operator','clean Windows run','browser feature coverage and pilot')}
function Invoke-VerificationNode([string]$Name,[string[]]$Arguments) {
    $taskLog=Join-Path $taskEvidence ($Name+'.log')
    $taskSavedPreference=$ErrorActionPreference
    try { $ErrorActionPreference='Continue'; & $taskNode @Arguments *> $taskLog; $taskStatus=$LASTEXITCODE }
    finally { $ErrorActionPreference=$taskSavedPreference }
    $taskReport.checks+=@{name=$Name;passed=($taskStatus -eq 0);exitCode=$taskStatus;log=($Name+'.log')}
    if($taskStatus -ne 0) {
        # Hosted runners are disposable. Emit only TAP test names/locations,
        # never assertion payloads, session URLs or raw fixture output.
        Get-Content -LiteralPath $taskLog | Where-Object {
            $_ -match '^\s*(not ok [0-9]+ - |failureType: |location: )'
        } | Select-Object -First 40 | Write-Output
        throw ('Verification failed at '+$Name+'; inspect its bounded synthetic log.')
    }
}
Push-Location $taskRoot
try {
    foreach($taskKey in $taskEnvironment.Keys) { $taskPrevious[$taskKey]=[Environment]::GetEnvironmentVariable($taskKey); [Environment]::SetEnvironmentVariable($taskKey,$taskEnvironment[$taskKey]) }
    $taskDoctor=& (Join-Path $PSScriptRoot 'test-local-web-package.ps1') -PackageDirectory $taskPackage
    $taskDoctor|ConvertTo-Json -Depth 5|Set-Content -LiteralPath (Join-Path $taskEvidence 'doctor.json') -Encoding UTF8
    $taskReport.checks+=@{name='package-runtime-integrity';passed=[bool]$taskDoctor.ok;files=$taskDoctor.integrity.files;log='doctor.json'}
    # Fresh builders need the same explicit DLL/plugin layout as the product.
    # Keep test executables in this disposable copy, never the publisher package.
    $taskRuntime=Join-Path $taskEvidence 'runtime'
    New-Item -ItemType Directory -Path $taskRuntime|Out-Null
    Copy-Item -LiteralPath (Join-Path $taskPackage 'bin'),(Join-Path $taskPackage 'plugins') -Destination $taskRuntime -Recurse
    Copy-Item -LiteralPath $taskProducer,$taskBindingProducer,$taskWriteAdmin -Destination (Join-Path $taskRuntime 'bin')
    [Environment]::SetEnvironmentVariable('LMTI_WEB_TEST_PRODUCER',(Join-Path $taskRuntime 'bin/lmti-mcp-profile-tests.exe'))
    [Environment]::SetEnvironmentVariable('LMTI_WEB_TEST_BINDING_PRODUCER',(Join-Path $taskRuntime 'bin/lmti-mcp-binding-identity-tests.exe'))
    [Environment]::SetEnvironmentVariable('LMTI_WEB_TEST_UPGRADE_WRITE_ADMIN',(Join-Path $taskRuntime 'bin/lmti-project-operation-write-test-admin.exe'))
    Invoke-VerificationNode -Name 'ui' -Arguments @('--test','--test-reporter=tap','--test-concurrency=1','apps/web-ui/test/*.test.mjs')
    Invoke-VerificationNode -Name 'api' -Arguments @('--test','--test-reporter=tap','--test-concurrency=1','apps/web-api/test/*.test.mjs')
    $taskReport.allSelectedChecksPassed=$true
} finally {
    foreach($taskKey in $taskPrevious.Keys) { [Environment]::SetEnvironmentVariable($taskKey,$taskPrevious[$taskKey]) }
    Pop-Location
    $taskReport|ConvertTo-Json -Depth 6|Set-Content -LiteralPath (Join-Path $taskEvidence 'verification.json') -Encoding UTF8
}
[pscustomobject]@{ChecksPassed=$taskReport.allSelectedChecksPassed;Evidence=$taskEvidence;ExternalAcceptanceComplete=$false}
