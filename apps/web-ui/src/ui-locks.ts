export type ChildLockKey = 'agent'|'hierarchy'|'physical'|'operations';
export type ChildLocks = Readonly<Record<ChildLockKey,boolean>>;
export const emptyChildLocks:ChildLocks=Object.freeze({agent:false,hierarchy:false,physical:false,operations:false});
// Each child owns exactly one entry. A release can never erase a sibling lease.
export function updateChildLock(locks:ChildLocks,key:ChildLockKey,locked:boolean):ChildLocks {
  if(!Object.hasOwn(emptyChildLocks,key)||typeof locked!=='boolean')throw new Error('Invalid lock update');
  return locks[key]===locked?locks:{...locks,[key]:locked};
}
export function hasChildLock(locks:ChildLocks,except?:ChildLockKey):boolean {
  return (Object.keys(emptyChildLocks) as ChildLockKey[]).some(key=>key!==except&&locks[key]);
}
