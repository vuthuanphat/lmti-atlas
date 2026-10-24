// Package public Markdown only. Images/source references remain pinned GitHub links.
import {lstat,mkdir,readdir,readFile,realpath,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {dirname,extname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
const repo=fileURLToPath(new URL('../',import.meta.url)),docs=join(repo,'docs'),output=resolve(process.argv[2]||'');
const under=(root,path)=>{const value=relative(root,path);return !!value&&!isAbsolute(value)&&value!=='..'&&!value.startsWith('..'+sep);};
if(process.argv.length!==3||!under(join(repo,'build'),output))throw Error('Use one owned build package directory.');
if((await realpath(output)).toLowerCase()!==output.toLowerCase())throw Error('Redirected package directory refused.');
const sha=execFileSync('git',['-C',repo,'rev-parse','HEAD'],{encoding:'utf8',windowsHide:true}).trim();
if(!/^[a-f0-9]{40}$/.test(sha))throw Error('Source commit required.');
const sources=[];
async function walk(path){
  if((await lstat(path)).isSymbolicLink())throw Error('Linked documentation refused.');
  for(const entry of await readdir(path,{withFileTypes:true})){
    const source=join(path,entry.name);if(entry.isSymbolicLink())throw Error('Linked documentation refused.');
    if(entry.isDirectory())await walk(source);else if(entry.isFile()&&extname(source)==='.md')sources.push(source);
  }
}
await walk(docs);if(sources.length>1000)throw Error('Documentation count exceeded.');
const destinations=new Map(sources.map(source=>[resolve(source),join(output,'share/lmti',relative(docs,source))]));
destinations.set(resolve(repo,'LICENSE'),join(output,'LICENSE'));
const uri=path=>path.split(/[\\/]/).map(encodeURIComponent).join('/');
function rewrite(text,source,destination){
  return text.replace(/\]\(([^)\r\n]+)\)/g,(match,value)=>{
    if(value.startsWith('#')||/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value))return match;
    const split=value.indexOf('#'),name=split<0?value:value.slice(0,split),anchor=split<0?'':value.slice(split);
    if(!name||name.includes(' ')||name.startsWith('<'))return match;
    let decoded;try{decoded=decodeURIComponent(name);}catch{return match;}
    const target=resolve(dirname(source),decoded);if(!under(repo,target))throw Error('Documentation reference escaped source tree.');
    const local=destinations.get(target);
    if(local)return ']('+relative(dirname(destination),local).split(sep).join('/')+anchor+')';
    const sourcePath=uri(relative(repo,target));
    const media=/\.(png|jpg|jpeg|gif|webp|svg)$/i.test(target);
    return ']('+(media?'https://raw.githubusercontent.com/vuthuanphat/lmti-atlas/':'https://github.com/vuthuanphat/lmti-atlas/blob/')+sha+'/'+sourcePath+anchor+')';
  });
}
let bytes=0;
for(const source of sources){
  const info=await lstat(source);bytes+=info.size;if(info.size>256*1024||bytes>4*1024*1024)throw Error('Documentation budget exceeded.');
  const destination=destinations.get(resolve(source));await mkdir(dirname(destination),{recursive:true});
  await writeFile(destination,rewrite(await readFile(source,'utf8'),source,destination),'utf8');
}
for(const [name,source]of [['README.md',join(docs,'local-web.md')],['RELEASE-NOTES.md',join(docs,'releases/v0.2.0-alpha.1.md')]]){
  const destination=join(output,name);await writeFile(destination,rewrite(await readFile(source,'utf8'),source,destination),'utf8');
}
console.log(JSON.stringify({schema:'lmti.package.docs.v1',markdownFiles:sources.length,bytes,sourceCommit:sha}));
