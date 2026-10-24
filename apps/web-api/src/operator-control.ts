import type {LaunchConfig} from './owners.js';
import {ApiError,exact,record,strictJson} from './security.js';
import {startApiLifecycle} from './lifecycle.js';

export class OperatorInputError extends Error {
  constructor() { super('Invalid local operator input.'); }
}
export type StartupCode='PORT_IN_USE'|'PORT_UNAVAILABLE'|'BROWSER_UNAVAILABLE'|'INVALID_OPERATOR_INPUT'|'OWNER_UNAVAILABLE'|'SCOPE_DENIED'|'CONFIG_CHANGED'|'INVALID_INPUT'|'STARTUP_FAILED';
export function startupCode(error:unknown):StartupCode {
  if(error instanceof OperatorInputError)return 'INVALID_OPERATOR_INPUT';
  if(error instanceof ApiError&&['OWNER_UNAVAILABLE','SCOPE_DENIED','CONFIG_CHANGED','INVALID_INPUT'].includes(error.code))return error.code as StartupCode;
  const code=error&&typeof error==='object'?(error as {code?:unknown}).code:undefined;
  if(code==='EADDRINUSE')return 'PORT_IN_USE';
  if(code==='EACCES')return 'PORT_UNAVAILABLE';
  if(code==='BROWSER_UNAVAILABLE')return 'BROWSER_UNAVAILABLE';
  return 'STARTUP_FAILED';
}

/** Only the inherited operator pipe carries commands; never HTTP or a file. */
export async function* operatorFrames(input:AsyncIterable<Uint8Array|string>):AsyncGenerator<Buffer> {
  let line:Buffer[]=[],size=0,first=true;
  for await(const chunk of input) {
    const bytes=typeof chunk==='string'?Buffer.from(chunk,'utf8'):Buffer.from(chunk);
    let start=0;
    for(let i=0;i<bytes.length;i++) {
      if(bytes[i]===13)throw new OperatorInputError();
      if(bytes[i]!==10)continue;
      const part=bytes.subarray(start,i);size+=part.length;
      if(size===0||size>(first?16383:255))throw new OperatorInputError();
      line.push(part);yield Buffer.concat(line,size);
      first=false;line=[];size=0;start=i+1;
    }
    if(start<bytes.length){const part=bytes.subarray(start);size+=part.length;if(size>(first?16383:255))throw new OperatorInputError();line.push(part);}
  }
  if(size)throw new OperatorInputError();
}
interface OperatorApi {
  origin:string;
  issueLaunch():string;
  close():Promise<void>;
  isIdle():boolean;
}
interface OperatorDependencies {
  start(config:LaunchConfig):Promise<OperatorApi>;
  open(url:string):Promise<void>;
  report(value:Record<string,unknown>):void;
}
export async function runOperatorSession(input:AsyncIterable<Uint8Array|string>,deps:OperatorDependencies):Promise<void> {
  const frames=operatorFrames(input);
  let stop:(()=>Promise<void>)|undefined;
  try {
    const first=await frames.next();
    if(first.done)throw new OperatorInputError();
    let config:LaunchConfig;
    try{config=record(strictJson(first.value)) as unknown as LaunchConfig;}catch{throw new OperatorInputError();}
    const api=await deps.start(config);
    stop=await startApiLifecycle(api,async()=>{
      if(config.openBrowser)await deps.open(api.issueLaunch());
    },{operatorControlled:true});
    deps.report({kind:'lmti-local-api',version:1,url:api.origin+'/',pid:process.pid});
    for await(const frame of frames){
      let action:'open'|'stop';
      try{const o=exact(strictJson(frame),['action']);if(o.action!=='open'&&o.action!=='stop')throw new OperatorInputError();action=o.action;}catch{throw new OperatorInputError();}
      if(action==='stop'){await stop();deps.report({kind:'lmti-operator-control',version:1,action,ok:true});return;}
      if(!config.openBrowser){deps.report({kind:'lmti-operator-control',version:1,action,ok:false,code:'BROWSER_DISABLED'});continue;}
      try{await deps.open(api.issueLaunch());deps.report({kind:'lmti-operator-control',version:1,action,ok:true});}
      catch(error){deps.report({kind:'lmti-operator-control',version:1,action,ok:false,code:error instanceof ApiError&&error.code==='BUSY'?'SESSION_LIMIT':startupCode(error)});}
    }
  }finally{
    try{await stop?.();}finally{await frames.return(undefined);}
  }
}
