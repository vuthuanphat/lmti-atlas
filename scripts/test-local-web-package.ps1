param([string]$PackageDirectory='')
$ErrorActionPreference='Stop'
function Send-OwnerJson {
    param([Diagnostics.Process]$Owner,[string]$Json)
    # Avoid the legacy console code page on Windows PowerShell 5.
    $taskWriter=[IO.StreamWriter]::new($Owner.StandardInput.BaseStream,[Text.UTF8Encoding]::new($false))
    try { $taskWriter.NewLine="`n"; $taskWriter.WriteLine($Json); $taskWriter.Flush() }
    finally { $taskWriter.Dispose() }
}
$taskRoot=Split-Path -Parent $PSScriptRoot
if (-not $PackageDirectory) {
    $PackageDirectory=if (Test-Path -LiteralPath (Join-Path $taskRoot 'bin/lmti-mcp-admin.exe')) { $taskRoot } else { Join-Path $taskRoot 'build/studio-web03-projection-20261014' }
}
if ($PackageDirectory.Length -gt 1024 -or $PackageDirectory -match '[\x00-\x1f"]' -or $PackageDirectory.Replace('\','/').StartsWith('//')) { throw 'Choose a local package directory; network/device paths are refused.' }
$taskPackage=(Resolve-Path -LiteralPath $PackageDirectory).Path
$taskNode=(Get-Command node -CommandType Application | Select-Object -First 1).Source
$taskPython=(Get-Command python -CommandType Application | Select-Object -First 1).Source
$taskDoctor=Join-Path $taskPackage 'apps/web-api/dist/doctor.js'
if (-not (Test-Path -LiteralPath $taskDoctor -PathType Leaf)) { throw 'Package doctor is missing. Build a current package.' }
foreach ($taskLocation in @($taskNode,$taskPython,$taskDoctor)) {
    if ($taskLocation.Length -gt 1024 -or $taskLocation -match '[\x00-\x1f"]' -or $taskLocation.Replace('\','/').StartsWith('//')) { throw 'Use trusted local runtimes.' }
    for ($taskAncestor=$taskLocation; $taskAncestor; $taskAncestor=Split-Path -Parent $taskAncestor) {
        if ((Get-Item -LiteralPath $taskAncestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Runtime/package links are refused.' }
    }
}
$taskStart=[Diagnostics.ProcessStartInfo]::new()
$taskStart.FileName=$taskNode
# Fixed module receives paths on stdin; no shell/path interpolation or inherited env.
$taskStart.Arguments='--input-type=module -e "import{pathToFileURL}from ''node:url'';process.stdin.setEncoding(''utf8'');let s='''';for await(const b of process.stdin){s+=b;if(s.length>4096)process.exit(1)}try{const c=JSON.parse(s);const{inspectPackage}=await import(pathToFileURL(c.doctor));process.stdout.write(JSON.stringify(await inspectPackage(c.package,c.python)))}catch{process.stderr.write(''Package/runtime check failed. Verify trusted Node 24+, Python 3.11+ x64, native runtime and package integrity.'');process.exitCode=1}"'
$taskStart.WorkingDirectory=$taskPackage
$taskStart.UseShellExecute=$false
$taskStart.CreateNoWindow=$true
$taskStart.RedirectStandardInput=$true
$taskStart.RedirectStandardOutput=$true
$taskStart.RedirectStandardError=$true
$taskStart.StandardOutputEncoding=[Text.UTF8Encoding]::new($false,$true)
$taskStart.StandardErrorEncoding=[Text.UTF8Encoding]::new($false,$true)
$taskStart.EnvironmentVariables.Clear()
foreach ($taskKey in @('SystemRoot','WINDIR')) { if ([Environment]::GetEnvironmentVariable($taskKey)) { $taskStart.EnvironmentVariables[$taskKey]=[Environment]::GetEnvironmentVariable($taskKey) } }
$taskProcess=[Diagnostics.Process]::Start($taskStart)
Send-OwnerJson $taskProcess (@{doctor=$taskDoctor;package=$taskPackage;python=$taskPython}|ConvertTo-Json -Compress)
$taskOutput=$taskProcess.StandardOutput.ReadToEndAsync(); $taskErrors=$taskProcess.StandardError.ReadToEndAsync()
if (-not $taskProcess.WaitForExit(30000)) { $taskProcess.Kill(); throw 'Package check timed out; no Studio operation was started.' }
$taskText=$taskOutput.GetAwaiter().GetResult()
if ($taskProcess.ExitCode -ne 0 -or $taskText.Length -gt 16384) { throw 'Package/runtime check failed. Verify trusted Node 24+, Python 3.11+ x64, native runtime and package integrity.' }
$taskResult=$taskText|ConvertFrom-Json
if ($taskResult.kind -ne 'lmti-local-web-doctor' -or -not $taskResult.ok) { throw 'Unexpected package check response.' }
$taskResult
