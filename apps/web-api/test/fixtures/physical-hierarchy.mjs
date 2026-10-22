import {createHash} from 'node:crypto';
export const base=process.platform==='win32'?'C:/physical-fixture':'/physical-fixture';
export const authority={projectId:'project',allowInternal:true};
export const config={adminBinary:base+'/admin.exe',library:base+'/library.sqlite',projects:[authority]};
export const library={schema:3,canonicalPath:base+'/library.sqlite',uuid:'11111111-1111-4111-8111-111111111111',generation:2,digest:'a'.repeat(64)};
export const identity={schemaVersion:2,projectId:'project',canonicalPath:base+'/project.sqlite',
  storeUuid:'22222222-2222-4222-8222-222222222222',revision:4,contentDigest:'b'.repeat(64),registryDigest:'c'.repeat(64)};
export const clone=v=>structuredClone(v),bytes=v=>Buffer.from(JSON.stringify(v)+'\n');
export const site=(id,privacy='internal')=>({id,label:'Controlled '+id,privacy});
export const area=(id,siteId='old-site',parentAreaId='',privacy='internal')=>({...site(id,privacy),siteId,parentAreaId});
export const asset=(id,privacy='internal')=>({...site(id,privacy),site:'old-site',kind:'sensor'});
export const placement=(assetId,areaId='',parentAssetId='',environmentId='',role=null)=>({assetId,areaId,parentAssetId,environmentId,role});
export const path=(siteId='',areaAncestors=[],assetAncestors=[],environmentId='')=>({siteId,areaAncestors,assetAncestors,environmentId});
const rank={site:0,area:1,environment:2,asset:3};
const opKind=op=>op.kind==='set_asset_placement'?'asset':op.kind.endsWith('_site')?'site':op.kind.endsWith('_area')?'area':'environment';
const opId=op=>op.expectedAsset?.id??op.desired?.id??op.expected.id;
export const normalize=p=>({...clone(p),changes:clone(p.changes).sort((a,b)=>
  rank[opKind(a)]-rank[opKind(b)]||(opId(a)<opId(b)?-1:opId(a)>opId(b)?1:0))});
const sf=r=>r===null?null:[r.id,r.label,r.privacy];
const af=r=>r===null?null:[r.id,r.label,r.siteId,r.parentAreaId,r.privacy];
const pf=r=>r===null?null:[r.assetId,r.areaId,r.parentAssetId,r.environmentId,r.role];
const xf=r=>[r.id,r.label,r.site,r.kind,r.privacy];
const pathFields=p=>[p.siteId,p.areaAncestors,p.assetAncestors,p.environmentId];
export function proposalHash(p,g=authority){
  const ops=p.changes.map(o=>{
    switch(o.kind){
      case 'add_site':return ['add_site',sf(o.desired)];
      case 'rename_site':return ['rename_site',sf(o.expected),o.desiredLabel];
      case 'retire_empty_site':return ['retire_site',sf(o.expected)];
      case 'add_area':return ['add_area',af(o.desired)];
      case 'rename_area':return ['rename_area',af(o.expected),o.desiredLabel];
      case 'reparent_area':return ['reparent_area',af(o.expected),o.desiredParentId];
      case 'retire_empty_area':return ['retire_area',af(o.expected)];
      case 'add_environment':return ['add_environment',sf(o.desired)];
      case 'rename_environment':return ['rename_environment',sf(o.expected),o.desiredLabel];
      case 'retire_empty_environment':return ['retire_environment',sf(o.expected)];
      case 'set_asset_placement':return ['placement',xf(o.expectedAsset),pf(o.expected),pf(o.desired)];
    }
  });
  return createHash('sha256').update(JSON.stringify(['lmti.physical-hierarchy.review.v1',g.projectId,true,g.allowInternal,
    p.projectId,String(p.expectedRevision),ops])).digest('hex');
}
export function diffHash(d){
  const h=createHash('sha256'),field=s=>{const b=Buffer.from(s);h.update(String(b.length)+':');h.update(b);},
    row=v=>field(JSON.stringify(v));
  field('lmti.physical-hierarchy.diff.v1');
  for(const [name,encode]of [['sites',sf],['areas',af],['environments',sf]]){
    row([name,String(d[name].length)]);for(const r of d[name])row([r.id,encode(r.before),encode(r.after)]);
  }
  row(['placements',String(d.placements.length)]);for(const r of d.placements)row([r.assetId,pf(r.before),pf(r.after)]);
  row(['affected',String(d.affected.length)]);
  for(const r of d.affected)row([r.kind,r.id,r.beforeClassification,r.afterClassification,pathFields(r.beforePath),pathFields(r.afterPath)]);
  return h.digest('hex');
}
export const affected=(kind,id,beforePath,afterPath,beforeClassification='internal',afterClassification='internal')=>
  ({kind,id,beforePath,afterPath,beforeClassification,afterClassification});
export const batch={projectId:'project',expectedRevision:4,changes:[
  {kind:'add_site',desired:site('new-site')},
  {kind:'rename_site',expected:site('old-site'),desiredLabel:'Renamed site'},
  {kind:'retire_empty_site',expected:site('retired-site')},
  {kind:'add_area',desired:area('new-area','new-site')},
  {kind:'rename_area',expected:area('old-area'),desiredLabel:'Renamed area'},
  {kind:'reparent_area',expected:area('move-area'),desiredParentId:'other-area'},
  {kind:'retire_empty_area',expected:area('retired-area')},
  {kind:'add_environment',desired:site('new-env')},
  {kind:'rename_environment',expected:site('old-env'),desiredLabel:'Renamed environment'},
  {kind:'retire_empty_environment',expected:site('retired-env')},
  {kind:'set_asset_placement',expectedAsset:asset('free'),expected:null,desired:placement('free')},
]};
export const proposal=normalize(batch);
export const diff={
  sites:[
    {id:'new-site',before:null,after:site('new-site')},
    {id:'old-site',before:site('old-site'),after:{...site('old-site'),label:'Renamed site'}},
    {id:'retired-site',before:site('retired-site'),after:null},
  ],
  areas:[
    {id:'move-area',before:area('move-area'),after:area('move-area','old-site','other-area')},
    {id:'new-area',before:null,after:area('new-area','new-site')},
    {id:'old-area',before:area('old-area'),after:{...area('old-area'),label:'Renamed area'}},
    {id:'retired-area',before:area('retired-area'),after:null},
  ],
  environments:[
    {id:'new-env',before:null,after:site('new-env')},
    {id:'old-env',before:site('old-env'),after:{...site('old-env'),label:'Renamed environment'}},
    {id:'retired-env',before:site('retired-env'),after:null},
  ],
  placements:[{assetId:'free',before:null,after:placement('free')}],
  affected:[
    affected('site','new-site',path(),path('new-site'),null),
    affected('site','old-site',path('old-site'),path('old-site')),
    affected('site','retired-site',path('retired-site'),path(),'internal',null),
    affected('area','move-area',path('old-site'),path('old-site',['other-area'])),
    affected('area','new-area',path(),path('new-site'),null),
    affected('area','old-area',path('old-site'),path('old-site')),
    affected('area','other-area',path('old-site'),path('old-site')),
    affected('area','retired-area',path('old-site'),path(),'internal',null),
    affected('environment','new-env',path(),path(),null),
    affected('environment','old-env',path(),path()),
    affected('environment','retired-env',path(),path(),'internal',null),
    affected('asset','free',path('old-site'),path('old-site')),
    affected('asset','observer',path('old-site',['move-area']),path('old-site',['other-area','move-area'])),
  ],
};
export function review(p=proposal,d=diff,g=authority){
  return {ok:true,schema:'lmti.physical-hierarchy.owner.v1',action:'physical-hierarchy-preview',expected:{
    libraryIdentity:clone(library),reviewToken:{...identity,schema:'lmti.physical-hierarchy.review.v1',
      scope:{projectId:g.projectId,allowPhysicalWrite:true,allowInternal:g.allowInternal},
      proposal:clone(p),proposalDigest:proposalHash(p,g),diffDigest:diffHash(d)}},diff:clone(d)};
}
export const readRequest={action:'physical-hierarchy-preview',proposal:batch};
export const writeRequest={action:'physical-hierarchy-commit',expected:review().expected};
export const stateRequest={action:'physical-hierarchy-state'};
export function state(){
  const same=asset('shared','public');
  return {ok:true,schema:'lmti.physical-hierarchy.owner.v1',action:'physical-hierarchy-state',libraryIdentity:clone(library),
    projectIdentity:clone(identity),projection:{projectId:'project',revision:4,
      sites:[{value:site('old-site','public'),classification:'public'}],
      areas:[{value:area('shared','old-site','','public'),ancestors:[],classification:'public'}],
      environments:[{value:site('shared','public'),classification:'public'}],
      assets:[
        {value:asset('free','public'),placement:null,path:path('old-site'),classification:'public'},
        {value:same,placement:placement('shared','shared','','shared'),path:path('old-site',['shared'],[],'shared'),classification:'public'},
      ]}};
}
export function ack(details=true,outcome='confirmed',code='NONE'){
  return {schema:'lmti.project.operation.write.v1',action:'physical-hierarchy-commit',outcome,code,operationId:null,
    detailsAvailable:details,details:details?{projectId:'project',storeUuid:identity.storeUuid,previousRevision:4,revision:5,
      proposalDigest:writeRequest.expected.reviewToken.proposalDigest}:null};
}
export const reseal=r=>(r.expected.reviewToken.diffDigest=diffHash(r.diff),r);
export const closed=v=>({kind:'closed',exitCode:0,transportOk:true,bytes:bytes(v)});
