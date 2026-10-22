import { createHash } from 'node:crypto';
import { exact, requireThat } from './security.js';

/** Private coordination metadata. Only the owning service decodes target fields. */
export type RecoveryJson = null|boolean|number|string|readonly RecoveryJson[]|
  {readonly [key:string]:RecoveryJson};
export interface RecoverySubject {
  readonly version:1;
  readonly kind:'legacy'|'logical_hierarchy'|'physical_hierarchy'|'project_operations';
  readonly action:string;
  readonly projectId:string|null;
  readonly grantId:string;
  readonly target:{readonly [key:string]:RecoveryJson};
}
export interface RecoveryEntry { readonly id:string; readonly subject:RecoverySubject }
export const recoveryLimits = Object.freeze({
  subjectBytes:32*1024, entries:32, entriesBytes:240*1024,
  depth:16, collection:256, objectKeys:128, stringBytes:8192, nodes:8192,
});
const actions = Object.freeze({
  legacy:['profile_save','desired_proposal','client_apply','client_restore'],
  logical_hierarchy:['logical-hierarchy-commit'],
  physical_hierarchy:['physical-hierarchy-commit'],
  project_operations:['copy-prepare','library-upgrade-v1','library-upgrade-v2',
    'activation-prepare','activation-activate','activation-abandon'],
});
const digestPattern = /^[0-9a-f]{64}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const identifier = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;
const reserved = new Set(['__proto__','prototype','constructor']);
// UTF-8 lexicographic order is Unicode scalar order, matching the fixed helper.
const sortedKeys = (value:object) => Object.keys(value).sort((a,b) => Buffer.compare(Buffer.from(a),Buffer.from(b)));
function text(value:string):void {
  requireThat(Buffer.byteLength(value,'utf8') <= recoveryLimits.stringBytes,'LIMIT_EXCEEDED');
  for (let i=0;i<value.length;i++) {
    const n=value.charCodeAt(i);
    if (n>=0xd800 && n<=0xdbff) {
      requireThat(i+1<value.length && value.charCodeAt(i+1)>=0xdc00 && value.charCodeAt(i+1)<=0xdfff);
      i++;
    } else requireThat(n<0xdc00 || n>0xdfff);
  }
}
function copyJson(value:unknown,depth:number,budget:{left:number},maxDepth:number):RecoveryJson {
  requireThat(depth<=maxDepth && --budget.left>=0,'LIMIT_EXCEEDED');
  if (value===null || typeof value==='boolean') return value;
  if (typeof value==='string') { text(value); return value; }
  if (typeof value==='number') { requireThat(Number.isSafeInteger(value)); return Object.is(value,-0)?0:value; }
  requireThat(typeof value==='object' && value!==null);
  requireThat(Object.getOwnPropertySymbols(value).length===0);
  const descriptors=Object.getOwnPropertyDescriptors(value);
  if (Array.isArray(value)) {
    requireThat(Object.getPrototypeOf(value)===Array.prototype);
    requireThat(value.length<=recoveryLimits.collection,'LIMIT_EXCEEDED');
    requireThat(Object.keys(descriptors).length===value.length+1);
    const result:RecoveryJson[]=[];
    for(let index=0;index<value.length;index++) {
      const property=descriptors[String(index)];
      requireThat(property && property.enumerable && Object.hasOwn(property,'value'));
      result.push(copyJson(property.value,depth+1,budget,maxDepth));
    }
    return Object.freeze(result);
  }
  requireThat(Object.getPrototypeOf(value)===Object.prototype || Object.getPrototypeOf(value)===null);
  const keys=Object.keys(descriptors);
  requireThat(keys.length<=recoveryLimits.objectKeys,'LIMIT_EXCEEDED');
  const result:Record<string,RecoveryJson>=Object.create(null);
  for(const key of sortedKeys(descriptors)) {
    text(key); requireThat(!reserved.has(key));
    const property=descriptors[key];
    requireThat(property.enumerable && Object.hasOwn(property,'value'));
    result[key]=copyJson(property.value,depth+1,budget,maxDepth);
  }
  return Object.freeze(result);
}
function encode(value:RecoveryJson):string {
  if (value===null || typeof value!=='object') return JSON.stringify(value);
  if (Array.isArray(value)) return '['+value.map(encode).join(',')+']';
  const object=value as {readonly [key:string]:RecoveryJson};
  return '{'+sortedKeys(object).map(key=>JSON.stringify(key)+':'+encode(object[key])).join(',')+'}';
}
/** No toJSON/getter execution, path folding, locale sorting or lossy Unicode. */
export function canonicalRecoveryJson(value:unknown):string {
  return encode(copyJson(value,0,{left:65536},24));
}
export function checkedRecoverySubject(value:unknown):RecoverySubject {
  const copied=copyJson(value,0,{left:recoveryLimits.nodes},recoveryLimits.depth);
  const o=exact(copied,['version','kind','action','projectId','grantId','target']);
  requireThat(o.version===1 && typeof o.kind==='string' && Object.hasOwn(actions,o.kind));
  const kind=o.kind as RecoverySubject['kind'];
  requireThat(typeof o.action==='string' && actions[kind].includes(o.action));
  const maintenance=o.action==='library-upgrade-v1' || o.action==='library-upgrade-v2';
  requireThat(maintenance ? o.projectId===null : typeof o.projectId==='string' && identifier.test(o.projectId));
  requireThat(typeof o.grantId==='string' && digestPattern.test(o.grantId));
  requireThat(o.target!==null && typeof o.target==='object' && !Array.isArray(o.target));
  requireThat(Buffer.byteLength(encode(copied))<=recoveryLimits.subjectBytes,'LIMIT_EXCEEDED');
  return copied as unknown as RecoverySubject;
}
export function checkedRecoveryEntries(value:unknown):readonly RecoveryEntry[] {
  requireThat(Array.isArray(value) && value.length<=recoveryLimits.entries,'LIMIT_EXCEEDED');
  // Check array descriptors too; neither sparse entries nor accessors are metadata.
  requireThat(Object.getPrototypeOf(value)===Array.prototype && Object.getOwnPropertySymbols(value).length===0);
  const descriptors=Object.getOwnPropertyDescriptors(value);
  requireThat(Object.keys(descriptors).length===value.length+1);
  const ids=new Set<string>(),result:RecoveryEntry[]=[];
  for(let index=0;index<value.length;index++) {
    const property=descriptors[String(index)];
    requireThat(property && property.enumerable && Object.hasOwn(property,'value'));
    const entry=copyJson(property.value,0,{left:recoveryLimits.nodes+8},recoveryLimits.depth+2);
    const o=exact(entry,['id','subject']);
    requireThat(typeof o.id==='string' && uuidPattern.test(o.id) &&
      o.id!=='00000000-0000-0000-0000-000000000000' && !ids.has(o.id));
    ids.add(o.id);
    result.push(Object.freeze({id:o.id,subject:checkedRecoverySubject(o.subject)}));
  }
  result.sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
  requireThat(Buffer.byteLength(canonicalRecoveryJson(result))<=recoveryLimits.entriesBytes,'LIMIT_EXCEEDED');
  return Object.freeze(result);
}
/** Digest of the complete sorted entry set, including UUID and subject framing. */
export function recoveryDigest(entries:readonly RecoveryEntry[]):string {
  return createHash('sha256').update(canonicalRecoveryJson(checkedRecoveryEntries(entries)),'utf8').digest('hex');
}
