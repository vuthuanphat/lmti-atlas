import { isAbsolute } from 'node:path';
import { exact, requireThat } from './security.js';

// Shared private native identity codec. Validation never grants or opens a path.
export interface LibraryIdentity {
  readonly schema:1|2|3; readonly canonicalPath:string;
  readonly uuid:string|null; readonly generation:number|null; readonly digest:string;
}
export function checkedNativeOperationPath(v:unknown,empty=false):string {
  if(empty&&v==='')return '';
  requireThat(typeof v==='string'&&v.length>0&&v.length<=1024&&!/[\x00-\x1f\x7f]/.test(v));
  const s=v,p=s.replaceAll('\\','/');
  requireThat(isAbsolute(s)&&!p.startsWith('//')&&!p.replace(/^[A-Za-z]:/,'').includes(':'));
  const parts=p.replace(/^[A-Za-z]:\//,'').replace(/^\//,'').split('/');
  requireThat(parts.every((part,i)=>part===''?parts.length===1&&i===0:part!=='.'&&part!=='..'&&!/[. ]$/.test(part)&&
    !/["<>|?*]/.test(part)&&!/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)));
  return s; // Qt owns Unicode case folding; never invent a second canonical key.
}
export function checkedNativeOperationIdentityPath(v:unknown):string {
  const s=checkedNativeOperationPath(v);requireThat(!s.includes('\\'));return s;
}
export function checkedNativeOperationLibrary(v:unknown):LibraryIdentity {
  const o=exact(v,['schema','canonicalPath','uuid','generation','digest']);
  requireThat(o.schema===1||o.schema===2||o.schema===3);
  requireThat(typeof o.digest==='string'&&o.digest.length===64&&/^[0-9a-f]{64}$/.test(o.digest));
  if(o.schema===1)requireThat(o.uuid===null&&o.generation===null);
  else {
    requireThat(typeof o.uuid==='string'&&o.uuid.length===36&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(o.uuid)&&
      o.uuid!=='00000000-0000-0000-0000-000000000000');
    requireThat(typeof o.generation==='number'&&Number.isSafeInteger(o.generation)&&o.generation>=1);
  }
  return {schema:o.schema,canonicalPath:checkedNativeOperationIdentityPath(o.canonicalPath),
    uuid:o.schema===1?null:o.uuid as string,generation:o.schema===1?null:o.generation as number,digest:o.digest};
}
