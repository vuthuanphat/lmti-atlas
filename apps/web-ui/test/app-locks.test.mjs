import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import test from 'node:test';

// Tests the exact pure reducer consumed by App, using the existing installed
// compiler. This does not mount React or claim browser/unmount timing proof.
const uiRoot=process.env.LMTI_OPERATIONS_TEST_UI_ROOT??fileURLToPath(new URL('../',import.meta.url));
const app=createRequire(join(uiRoot,'package.json'));
const {build}=createRequire(app.resolve('vite'))('esbuild');
const bundle=await build({
  entryPoints:[fileURLToPath(new URL('../src/ui-locks.ts',import.meta.url))],
  bundle:true,write:false,format:'cjs',platform:'node',
});
const module={exports:{}};
new Function('require','module','exports',bundle.outputFiles[0].text)(app,module,module.exports);
const {updateChildLock,hasChildLock}=module.exports;
const keys=['agent','hierarchy','physical','operations','content'];
const empty=()=>({agent:false,hierarchy:false,physical:false,operations:false,content:false,library:false});

test('an unlocked sibling callback cannot release the pending hierarchy owner',()=>{
  let locks=updateChildLock(empty(),'hierarchy',true);
  locks=updateChildLock(locks,'agent',false);
  locks=updateChildLock(locks,'operations',false);
  locks=updateChildLock(locks,'physical',false);
  assert.equal(hasChildLock(locks),true);
  assert.equal(hasChildLock(locks,'hierarchy'),false);
  assert.equal(hasChildLock(locks,'agent'),true);
  assert.equal(hasChildLock(locks,'operations'),true);
  assert.equal(hasChildLock(locks,'physical'),true);
});

test('overlapping child owners stay locked through every acquisition and release ordering',()=>{
  const permute=values=>values.length===0?[[]]:values.flatMap(first=>
    permute(values.filter(value=>value!==first)).map(rest=>[first,...rest]));
  const permutations=permute(keys);
  assert.equal(permutations.length,120);
  for(const acquisition of permutations)for(const release of permutations){
    let locks=empty();
    for(const key of acquisition){
      locks=updateChildLock(locks,key,true);
      assert.equal(hasChildLock(locks),true,`acquisition ${key}`);
    }
    for(let index=0;index<release.length;index++){
      const key=release[index];locks=updateChildLock(locks,key,false);
      assert.equal(hasChildLock(locks),index<keys.length-1,`release order ${release.join(',')} index ${index}`);
    }
    assert.deepEqual(locks,empty());
  }
});

test('owner exclusion permits only its own status/recovery controls and never ignores another live owner',()=>{
  for(const owner of keys){
    let locks=updateChildLock(empty(),owner,true);
    assert.equal(hasChildLock(locks,owner),false);
    for(const other of keys.filter(k=>k!==owner)){
      locks=updateChildLock(locks,other,true);
      assert.equal(hasChildLock(locks,owner),true);
      assert.equal(hasChildLock(locks,other),true);
      locks=updateChildLock(locks,other,false);
      assert.equal(hasChildLock(locks,owner),false);
    }
  }
});

test('functional lock transitions do not mutate previously rendered snapshots',()=>{
  const original=Object.freeze(empty());
  const hierarchy=Object.freeze(updateChildLock(original,'hierarchy',true));
  const overlap=Object.freeze(updateChildLock(hierarchy,'operations',true));
  const released=updateChildLock(overlap,'hierarchy',false);
  assert.deepEqual(original,empty());
  assert.deepEqual(hierarchy,{...empty(),hierarchy:true});
  assert.deepEqual(overlap,{...empty(),hierarchy:true,operations:true});
  assert.deepEqual(released,{...empty(),operations:true});
  assert.equal(hasChildLock(released),true);
});

test('duplicate status and cleanup notifications are idempotent without resetting unrelated locks',()=>{
  let locks=updateChildLock(empty(),'operations',true);
  for(let repeat=0;repeat<4;repeat++){
    locks=updateChildLock(locks,'operations',true);
    locks=updateChildLock(locks,'agent',false);
    locks=updateChildLock(locks,'hierarchy',false);
    locks=updateChildLock(locks,'physical',false);
    assert.equal(hasChildLock(locks),true);
  }
  locks=updateChildLock(locks,'operations',false);
  assert.equal(hasChildLock(locks),false);
  locks=updateChildLock(locks,'hierarchy',true);
  locks=updateChildLock(locks,'operations',false);
  assert.equal(hasChildLock(locks),true);
  assert.equal(locks.hierarchy,true);
});

test('physical pending and unknown ownership survives logical cleanup and permits only its own status reads',()=>{
  let locks=updateChildLock(empty(),'physical',true);
  for(const sibling of ['agent','hierarchy','operations']){
    locks=updateChildLock(locks,sibling,false);
    assert.equal(locks.physical,true);
    assert.equal(hasChildLock(locks),true);
    assert.equal(hasChildLock(locks,sibling),true);
    assert.equal(hasChildLock(locks,'physical'),false);
  }
  locks=updateChildLock(locks,'operations',true);
  locks=updateChildLock(locks,'physical',false);
  assert.equal(hasChildLock(locks),true);
  assert.equal(hasChildLock(locks,'operations'),false);
  locks=updateChildLock(locks,'operations',false);
  assert.deepEqual(locks,empty());
});
