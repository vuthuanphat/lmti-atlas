import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const launcher=fileURLToPath(new URL('../../../scripts/start-local-web.ps1',import.meta.url));
const powershell=process.env.LMTI_WEB_TEST_POWERSHELL??
  join(process.env.SystemRoot??'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
const quote=value=>"'"+value.replaceAll("'","''")+"'";

test('actual launcher refuses missing, duplicate and widened hierarchy authority before opening any configured path',
  {timeout:30000},()=>{
    assert.equal(process.platform,'win32');
    // The deliberately nonexistent location proves capability validation is
    // performed before path inspection, package execution or broker startup.
    const prefix='& '+quote(launcher)+" -DataDirectory 'C:\\lmti-no-such-controlled-launch-fixture'";
    for(const [args,message] of [
      [" -HierarchyProjectId @('project')",'Hierarchy grants require LogicalHierarchy.'],
      [" -HierarchyInternalProjectId @('project')",'Hierarchy grants require LogicalHierarchy.'],
      [' -LogicalHierarchy','Specify explicit HierarchyProjectId grants.'],
      [" -LogicalHierarchy -HierarchyProjectId @('project','project')",'Project grants must be unique and bounded.'],
      [" -LogicalHierarchy -HierarchyProjectId @('project') -HierarchyInternalProjectId @('other')",
        'Internal hierarchy grants must be within explicit hierarchy project grants.'],
      [" -LogicalHierarchy -HierarchyProjectId @('invalid project')",'A project grant is invalid.']
    ]) {
      const script="$ErrorActionPreference='Stop';try { "+prefix+args+
        " } catch { [Console]::Error.Write($_.Exception.Message);exit 7 };exit 9";
      const run=spawnSync(powershell,['-NoProfile','-NonInteractive','-Command',script],
        {encoding:'utf8',timeout:5000,windowsHide:true,maxBuffer:8192});
      assert.equal(run.status,7,'The launcher must refuse before starting owners.');
      assert.equal(run.stderr.trim(),message);
      assert.equal(run.stdout,'');
    }
  });
