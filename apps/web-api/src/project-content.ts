import {contentCollections,type ContentChange,type ContentCollection,type ContentPage,type ContentRecord} from './project-content-contract.js';
import {exact,requireThat} from './security.js';

export function collection(value:unknown):ContentCollection {
  requireThat(typeof value==='string'&&contentCollections.some(c=>c.id===value));return value as ContentCollection;
}
export function contentRecord(id:ContentCollection,value:unknown,remove=false):ContentRecord {
  const definition=contentCollections.find(c=>c.id===id)!;
  const fields=remove?definition.fields.filter(f=>f.id==='id'):definition.fields;
  const o=exact(value,fields.map(f=>f.id));
  for(const field of fields){
    const v=o[field.id];
    if(field.type==='boolean')requireThat(typeof v==='boolean');
    else if(field.type==='number')requireThat(typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<=Number.MAX_SAFE_INTEGER-1);
    else {
      requireThat(typeof v==='string'&&Buffer.byteLength(v)<=8192&&!/[\x00-\x1f\x7f]/.test(v));
      if('options' in field)requireThat((field.options as readonly string[]).includes(v));
    }
  }
  requireThat(typeof o.id==='string'&&/^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(o.id));
  return o as ContentRecord;
}
export function contentQuery(value:unknown){
  const o=exact(value,['collection','offset','limit']);
  requireThat(Number.isSafeInteger(o.offset)&&Number(o.offset)>=0&&Number(o.offset)<=50000&&Number.isSafeInteger(o.limit)&&Number(o.limit)>=1&&Number(o.limit)<=100);
  return {collection:collection(o.collection),offset:o.offset as number,limit:o.limit as number};
}
export function contentChange(value:unknown):ContentChange {
  const o=exact(value,['collection','operation','expectedRevision','record']),id=collection(o.collection);
  requireThat(['add','update','remove'].includes(String(o.operation))&&Number.isSafeInteger(o.expectedRevision)&&Number(o.expectedRevision)>=1&&Number(o.expectedRevision)<=Number.MAX_SAFE_INTEGER-1);
  requireThat(id!=='project'||o.operation==='update');
  return {collection:id,operation:o.operation as ContentChange['operation'],expectedRevision:o.expectedRevision as number,record:contentRecord(id,o.record,o.operation==='remove')};
}
export function contentResponse(value:unknown,mode:'read'|'review'|'commit',id:ContentCollection):ContentPage|{collection:ContentCollection;revision:number;before:ContentRecord|null;after:ContentRecord|null;deviceActions:false}{
  const o=exact(value,mode==='read'?['ok','schema','collection','revision','items','total','nextOffset']:['ok','schema','collection','revision','before','after','deviceActions']);
  requireThat(o.ok===true&&o.schema==='lmti.project.content.v1'&&o.collection===id&&Number.isSafeInteger(o.revision)&&Number(o.revision)>=1,'OWNER_UNAVAILABLE');
  if(mode==='read'){
    requireThat(Array.isArray(o.items)&&o.items.length<=100&&Number.isSafeInteger(o.total)&&Number(o.total)>=0&&Number(o.total)<=50000&&
      (o.nextOffset===null||(Number.isSafeInteger(o.nextOffset)&&Number(o.nextOffset)>0&&Number(o.nextOffset)<Number(o.total))),'OWNER_UNAVAILABLE');
    return {collection:id,revision:o.revision as number,items:(o.items as unknown[]).map(v=>contentRecord(id,v)),total:o.total as number,nextOffset:o.nextOffset as number|null};
  }
  requireThat(o.deviceActions===false,'OWNER_UNAVAILABLE');
  return {collection:id,revision:o.revision as number,before:o.before===null?null:contentRecord(id,o.before),after:o.after===null?null:contentRecord(id,o.after),deviceActions:false};
}
