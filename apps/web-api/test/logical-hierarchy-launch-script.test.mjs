import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const launcher=fileURLToPath(new URL('../../../scripts/start-local-web.ps1',import.meta.url));
const powershell=process.env.LMTI_WEB_TEST_POWERSHELL??
  join(process.env.SystemRoot??'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
const quote=value=>"'"+value.replaceAll("'","''")+"'";
const probeTimeoutMs=15000;

test('actual launcher refuses missing, duplicate and widened hierarchy authority before opening any configured path',
  {timeout:120000},t=>{
    assert.equal(process.platform,'win32');
    // The deliberately nonexistent location proves capability validation is
    // performed before path inspection, package execution or broker startup.
    const prefix='& '+quote(launcher)+" -DataDirectory 'C:\\lmti-no-such-controlled-launch-fixture'";
    const cases=[
      [" -HierarchyProjectId @('project')",'Hierarchy grants require LogicalHierarchy.'],
      [" -HierarchyInternalProjectId @('project')",'Hierarchy grants require LogicalHierarchy.'],
      [' -LogicalHierarchy','Specify explicit HierarchyProjectId grants.'],
      [" -LogicalHierarchy -HierarchyProjectId @('project','project')",'Project grants must be unique and bounded.'],
      [" -LogicalHierarchy -HierarchyProjectId @('project') -HierarchyInternalProjectId @('other')",
        'Internal hierarchy grants must be within explicit hierarchy project grants.'],
      [" -LogicalHierarchy -HierarchyProjectId @('invalid project')",'A project grant is invalid.']
    ];
    for(const [index,[args,message]] of cases.entries()) {
      // First-use module progress is not a domain response. Suppress only that
      // noninteractive noise; exact refusal, exit status and empty stdout stay required.
      const script="$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';try { "+prefix+args+
        " } catch { [Console]::Error.Write($_.Exception.Message);exit 7 };exit 9";
      // Hosted Windows exhausted the old 5s subprocess limit before case 1
      // emitted any output. Allow bounded time for the PowerShell probe;
      // the exact denial, exit status and empty stdout assertions stay intact.
      const started=performance.now();
      const run=spawnSync(powershell,['-NoProfile','-NonInteractive','-Command',script],
        {encoding:'utf8',timeout:probeTimeoutMs,windowsHide:true,maxBuffer:8192});
      if(run.status!==7||run.stderr?.trim()!==message||run.stdout!==''){
        const error=run.error?.code;
        const diagnostic={case:index+1,status:run.status,signal:run.signal,
          elapsedMs:Math.round(performance.now()-started),timeoutMs:probeTimeoutMs,
          spawnError:error===undefined?null:['ETIMEDOUT','ENOENT','EACCES','EPERM'].includes(error)?error:'OTHER',
          stdoutBytes:Buffer.byteLength(run.stdout??''),stderrBytes:Buffer.byteLength(run.stderr??''),
          stderrCategory:run.stderr?.trim()===message?'expected_refusal':/CLIXML|Preparing modules for first use/i.test(run.stderr??'')?'powershell_progress':
            /ExecutionPolicy|PSSecurityException|running scripts is disabled|not digitally signed/i.test(run.stderr??'')?'execution_policy':'other'};
        t.diagnostic('LMTI_LAUNCHER_PROBE '+JSON.stringify(diagnostic));
      }
      assert.equal(run.status,7,'The launcher must refuse before starting owners.');
      assert.equal(run.stderr.trim(),message);
      assert.equal(run.stdout,'');
    }
  });
