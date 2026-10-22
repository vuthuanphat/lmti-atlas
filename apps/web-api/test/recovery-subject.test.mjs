import test from 'node:test';
import assert from 'node:assert/strict';
import { checkedRecoverySubject, checkedRecoveryEntries, canonicalRecoveryJson, recoveryDigest } from '../dist/recovery-subject.js';
import { strictJson } from '../dist/security.js';

const base=()=>({version:1,kind:'legacy',action:'profile_save',projectId:'fixture',
  grantId:'a'.repeat(64),target:{path:'C:/controlled/Original.sqlite',identity:{schema:2,uuid:'typed-native-identity'}}});
const entry=(id='11111111-1111-4111-8111-111111111111',subject=base())=>({id,subject});
test('subject codec copies/freezes original values without path or Unicode normalization',()=>{
  const value=base(),accepted=checkedRecoverySubject(value);
  value.target.path='C:/replacement.sqlite';value.target.identity.schema=1;
  assert.equal(accepted.target.path,'C:/controlled/Original.sqlite');
  assert.equal(accepted.target.identity.schema,2);
  assert.ok(Object.isFrozen(accepted));assert.ok(Object.isFrozen(accepted.target.identity));
  const unicode=checkedRecoverySubject({...base(),target:{name:'e\u0301',path:'C:/Ü/Ä.sqlite'}});
  assert.equal(unicode.target.name,'e\u0301');assert.equal(unicode.target.path,'C:/Ü/Ä.sqlite');
});
test('outer keys, kind/action/project relationships and grants are exact',()=>{
  for(const delta of [
    {extra:true},{version:2},{kind:'arbitrary'},{action:'logical-hierarchy-commit'},
    {projectId:null},{projectId:'../outside'},{grantId:'A'.repeat(64)},{grantId:'a'.repeat(63)},
    {target:[]},{target:null},
  ])assert.throws(()=>checkedRecoverySubject({...base(),...delta}),{code:'INVALID_INPUT'});
  for(const action of ['library-upgrade-v1','library-upgrade-v2']) {
    assert.equal(checkedRecoverySubject({...base(),kind:'project_operations',action,projectId:null}).projectId,null);
    assert.throws(()=>checkedRecoverySubject({...base(),kind:'project_operations',action}),{code:'INVALID_INPUT'});
  }
  for(const action of ['copy-prepare','activation-prepare','activation-activate','activation-abandon'])
    assert.equal(checkedRecoverySubject({...base(),kind:'project_operations',action}).action,action);
  assert.equal(checkedRecoverySubject({...base(),kind:'logical_hierarchy',action:'logical-hierarchy-commit'}).kind,'logical_hierarchy');
});
test('no getter, toJSON, prototype, symbol, sparse or unsupported value is executed',()=>{
  let ran=false;
  const getter={};Object.defineProperty(getter,'field',{enumerable:true,get(){ran=true;return 'no';}});
  const custom=Object.create({inherited:true});custom.field=1;
  const hidden={};Object.defineProperty(hidden,'hidden',{value:1,enumerable:false});
  const symbol={};symbol[Symbol('private')]=1;
  const holes=[];holes.length=2;
  const arrayExtra=[1];arrayExtra.extra=2;
  for(const target of [
    getter,custom,hidden,symbol,{x:undefined},{x:()=>1},{x:1n},{x:NaN},{x:Infinity},
    {x:1.5},{x:Number.MAX_SAFE_INTEGER+1},{x:new Date()},{x:holes},{x:arrayExtra},
    {toJSON(){ran=true;return {};}},
  ])assert.throws(()=>checkedRecoverySubject({...base(),target}),{code:'INVALID_INPUT'});
  assert.equal(ran,false);
  for(const reserved of ['__proto__','prototype','constructor'])
    assert.throws(()=>checkedRecoverySubject({...base(),target:JSON.parse(`{"${reserved}":1}`)}),{code:'INVALID_INPUT'});
});
test('wire duplicates and invalid Unicode cannot enter the subject boundary',()=>{
  const duplicate=JSON.stringify(base()).replace('"version":1','"version":1,"version":1');
  assert.throws(()=>strictJson(Buffer.from(duplicate)),{code:'INVALID_INPUT'});
  assert.throws(()=>strictJson(Buffer.from([0xc0,0xaf])),{code:'INVALID_INPUT'});
  for(const bad of ['\ud800','\udfff','a\ud800b']) {
    assert.throws(()=>checkedRecoverySubject({...base(),target:{bad}}),{code:'INVALID_INPUT'});
    assert.throws(()=>checkedRecoverySubject({...base(),target:{[bad]:'key'}}),{code:'INVALID_INPUT'});
  }
});
test('canonical UTF-8 scalar ordering matches fixed helper and safe integer framing',()=>{
  // Code-point order differs from UTF-16 for U+E000 and supplementary U+10000.
  assert.equal(canonicalRecoveryJson({'2':2,'10':10,'\u{10000}':'supplementary','\ue000':'bmp'}),
    '{"10":10,"2":2,"":"bmp","𐀀":"supplementary"}');
  assert.equal(canonicalRecoveryJson({z:-0,a:Number.MAX_SAFE_INTEGER}), '{"a":9007199254740991,"z":0}');
  assert.equal(canonicalRecoveryJson({path:'C:\\original\\file',text:'a\nb'}),'{"path":"C:\\\\original\\\\file","text":"a\\nb"}');
});
test('per-subject collections/depth/string/byte limits fail before retention',()=>{
  for(const target of [
    {x:'x'.repeat(8193)},{x:Array(257).fill(0)},Object.fromEntries(Array.from({length:129},(_,i)=>[`p${i}`,i])),
    {a:'a'.repeat(8192),b:'b'.repeat(8192),c:'c'.repeat(8192),d:'d'.repeat(8192)},
  ])assert.throws(()=>checkedRecoverySubject({...base(),target}),{code:'LIMIT_EXCEEDED'});
  let target={leaf:true};for(let i=0;i<17;i++)target={child:target};
  assert.throws(()=>checkedRecoverySubject({...base(),target}),{code:'LIMIT_EXCEEDED'});
  assert.ok(checkedRecoverySubject({...base(),target:{a:'a'.repeat(7900),b:'b'.repeat(7900),c:'c'.repeat(7900)}}));
});
test('entry IDs are canonical, sorted, unique and preserve independent original targets',()=>{
  const one=entry(),two=entry('22222222-2222-4222-8222-222222222222',{...base(),target:{path:'other'}});
  assert.equal(recoveryDigest([one,two]),recoveryDigest([two,one]));
  assert.deepEqual(checkedRecoveryEntries([two,one]).map(e=>e.id),[one.id,two.id]);
  assert.notEqual(recoveryDigest([one]),recoveryDigest([two]));
  for(const id of ['00000000-0000-0000-0000-000000000000','AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA','../outside','123'])
    assert.throws(()=>checkedRecoveryEntries([entry(id)]),{code:'INVALID_INPUT'});
  assert.throws(()=>checkedRecoveryEntries([one,one]),{code:'INVALID_INPUT'});
  assert.throws(()=>checkedRecoveryEntries([{...one,extra:1}]),{code:'INVALID_INPUT'});
  assert.throws(()=>checkedRecoveryEntries(Array(33).fill(one)),{code:'LIMIT_EXCEEDED'});
});
test('entry union limit includes UUID and subject framing',()=>{
  const large={...base(),target:{a:'a'.repeat(7900),b:'b'.repeat(7900),c:'c'.repeat(7900),d:'d'.repeat(7900)}};
  const entries=Array.from({length:8},(_,i)=>entry(`${String(i+1).padStart(8,'0')}-1111-4111-8111-111111111111`,large));
  assert.equal(checkedRecoveryEntries(entries.slice(0,7)).length,7);
  assert.throws(()=>checkedRecoveryEntries(entries),{code:'LIMIT_EXCEEDED'});
});
