import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const repo=fileURLToPath(new URL('../../../',import.meta.url));
const quote=value=>"'"+value.replaceAll("'","''")+"'";
test('actual launcher and doctor pipes preserve UTF-8 JSON under Windows PowerShell 5',{timeout:45000},async t=>{
  assert.equal(process.platform,'win32');
  const root=await mkdtemp(join(tmpdir(),'lmti-utf8-pipe-'));
  t.after(async()=>{assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep));await rm(root,{recursive:true,force:true});});
  const payload=JSON.stringify({label:'Thư mục đã cấp phép',path:'D:/dữ-liệu/dự-án',id:'project'}),expected=join(root,'expected.json'),probe=join(root,'probe.mjs');
  await writeFile(expected,payload+'\n','utf8');
  await writeFile(probe,`import{readFileSync}from'node:fs';let chunks=[];for await(const b of process.stdin)chunks.push(b);const bytes=Buffer.concat(chunks),expected=readFileSync(process.argv[2]);let label='';try{label=JSON.parse(bytes.toString('utf8')).label}catch{};process.stdout.write(JSON.stringify({matches:bytes.equals(expected),label}));`,'utf8');
  for(const file of ['start-local-web.ps1','test-local-web-package.ps1']){
    const ps=process.env.LMTI_WEB_TEST_POWERSHELL??join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe');
    // Execute only the actual private helper ASTs. No launch preflight is
    // bypassed in a product run; this isolated child checks byte transport.
    const script=`$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';function Load-Helper([string]$Path,[string]$Name){$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile($Path,[ref]$tokens,[ref]$errors);if($errors.Count){throw 'Parse failed'};$helperNodes=@($ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $Name},$true));if($helperNodes.Count -ne 1){throw 'Expected exact helper'};return $helperNodes[0].Extent.Text};. ([ScriptBlock]::Create((Load-Helper ${quote(join(repo,'scripts/start-local-web.ps1'))} 'New-OwnerProcess')));. ([ScriptBlock]::Create((Load-Helper ${quote(join(repo,'scripts',file))} 'Send-OwnerJson')));$taskRoot=${quote(root)};$value=[IO.File]::ReadAllText(${quote(expected)},[Text.Encoding]::UTF8).TrimEnd([char]10);$p=New-OwnerProcess ${quote(process.execPath)} @(${quote(probe)},${quote(expected)});Send-OwnerJson $p $value;$output=$p.StandardOutput.ReadToEnd()|ConvertFrom-Json;if(-not $p.WaitForExit(15000)){throw 'Child did not close'};if($p.ExitCode -ne 0 -or -not $output.matches -or $output.label -ne ($value|ConvertFrom-Json).label){throw 'UTF-8 boundary mismatch'};[Console]::Write('utf8-ok')`;
    const run=spawnSync(ps,['-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8',timeout:20000,windowsHide:true,maxBuffer:4096});
    assert.equal(run.status,0,`${file}: ${run.error?.code??'child refused'}; stderr suppressed`);assert.equal(run.stdout,'utf8-ok');assert.equal(run.stderr,'');
  }
});
