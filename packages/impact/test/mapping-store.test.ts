import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { initializeImpactStore, importImpactSnapshot } from "../src/store.js";
import { createImpactMappingOperator } from "../src/mapping-owner.js";
import {
  MappingError, mappingPayloadDigest, mappingSourceFingerprint, mappingNativeFingerprint,
  type MappingImport, type MappingObservationRequest, type MappingObservations,
  type MappingOperatorConfig, type MappingWriteOutcome,
} from "../src/mapping.js";

const NOW="2026-10-20T05:00:00.000Z", HASH="a".repeat(64);
const NATIVE="28fefed9-e856-4f36-9fa7-567c9b4f04ac";
const directories:string[]=[];
function db<T>(filename:string,run:(opened:DatabaseSync)=>T):T {
  const opened=new DatabaseSync(filename);try{return run(opened);}finally{opened.close();}
}
function canonical(value:unknown):string {
  if(Array.isArray(value))return "["+value.map(canonical).join(",")+"]";
  if(value&&typeof value==="object")return "{"+Object.keys(value).sort().map(k=>JSON.stringify(k)+":"+canonical((value as Record<string,unknown>)[k])).join(",")+"}";
  const encoded=JSON.stringify(value);
  if(encoded===undefined)throw new Error("Non-data fixture value");
  return encoded;
}
function image(filename:string):string {
  return db(filename,opened=>{
    const tables=opened.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    return canonical({catalog:opened.prepare("SELECT * FROM sqlite_schema ORDER BY type,name").all(),
      rows:tables.map(t=>[t.name,opened.prepare(`SELECT * FROM "${String(t.name).replaceAll('"','""')}"`).all().map(canonical).sort()])});
  });
}
function proof(request:MappingObservationRequest):MappingObservations {
  const source={sourceId:request.authority.sourceId,authorityFingerprint:request.authority.sourceAuthorityFingerprint,
    revision:request.sourceRevision,digest:request.sourceDigest,classification:"public" as const};
  const native={schema:2 as const,projectId:request.authority.nativeProjectId,storeUuid:request.authority.nativeStoreUuid,
    revision:1,authorityFingerprint:request.authority.nativeAuthorityFingerprint,
    targets:request.targets.map(target=>({target,effectiveClassification:"public" as const,ancestryFingerprint:HASH,
      referenceFingerprint:null,identityState:"active" as const}))};
  return {source:{...source,checkedAt:NOW,fingerprint:mappingSourceFingerprint(source)},
    native:{...native,checkedAt:NOW,fingerprint:mappingNativeFingerprint(native)}};
}
function fixture(upgrade=true) {
  const directory=mkdtempSync(path.join(realpathSync(tmpdir()),"lmti-mapping-store-test-"));directories.push(directory);
  const filename=path.join(directory,"impact.sqlite"),backup=path.join(directory,"backup.sqlite");
  initializeImpactStore(filename);
  let observe:(r:MappingObservationRequest)=>Promise<MappingObservations>=async r=>proof(r);
  const config:MappingOperatorConfig={storePath:filename,grant:{principalId:"operator",projectId:"project",siteIds:["site"],
    environmentIds:["environment"],allowInternal:true,policyVersion:"grant-policy"},
    authorities:[{sourceId:"source",projectId:"project",siteId:"site",environmentId:"environment",kind:"manifest",
      minimumClassification:"public",sourceAuthorityFingerprint:HASH,nativeProjectId:"project",nativeStoreUuid:NATIVE,
      nativeAuthorityFingerprint:HASH,policyVersion:"source-policy"}],
    maintenance:{capabilityId:"maintenance",policyVersion:"maintenance-policy",backupPath:backup},
    observers:{authorize(){},observe:r=>observe(r)},clock:()=>NOW};
  const owner=createImpactMappingOperator(config);
  if(upgrade)known(owner.upgradeMappings(owner.inspectMappingFormat(),randomUUID()));
  return {filename,backup,owner,config,setObserver(next:typeof observe){observe=next;}};
}
function known(result:MappingWriteOutcome) {
  expect(result.outcome).toBe("confirmed");if(result.outcome!=="confirmed")throw new Error("Expected confirmed result");return result.receipt;
}
function payload():MappingImport {
  const body={schema:"lmti.impact.mapping-import.v1" as const,expectedAcceptedVersion:null,mappingVersion:"version-one",
    input:{schema:"lmti.impact.import.v1" as const,source:{id:"source",projectId:"project",siteId:"site",environmentId:"environment",
      privacy:"public" as const,kind:"manifest" as const,revision:"source-one",digest:HASH,capturedAt:NOW,parserVersion:"fixture",complete:true as const},
      entities:[{id:"entity",sourceKey:"external",kind:"service" as const,label:"Fixture",ownerRole:"test",privacy:"public" as const}],
      evidence:[{id:"evidence",locator:"fixture.json#entity",summary:"Controlled fixture.",capturedAt:NOW,entityId:"entity",privacy:"public" as const}],
      assertions:[]},
    mappings:[{kind:"identity" as const,mappingId:randomUUID(),externalKey:"external",generation:"generation-one",aliases:[],
      classification:"public" as const,evidenceIds:["evidence"],state:"active" as const,impactEntityId:"entity",replacesMappingId:null,
      target:{projectId:"project",storeUuid:NATIVE,kind:"component" as const,id:"component"}}]};
  return {...body,payloadDigest:mappingPayloadDigest(body)};
}
afterEach(()=>{
  const parent=realpathSync(tmpdir());
  for(const directory of directories.splice(0)){
    if(lstatSync(directory).isSymbolicLink())throw new Error("Redirected fixture");
    const target=realpathSync(directory),relative=path.relative(parent,target);
    if(!relative||relative.startsWith("..")||path.isAbsolute(relative)||!path.basename(target).startsWith("lmti-mapping-store-test-"))
      throw new Error("Unexpected cleanup path");
    rmSync(target,{recursive:true,force:true});
  }
});

describe("mapping SQLite schema and transaction boundaries",()=>{
  it("refuses unexpected triggers on owned tables before even reserving upgrade backup",()=>{
    for(const table of ["metadata","imports","review_events"]){
      const f=fixture(false);
      db(f.filename,o=>o.exec(`CREATE TABLE untouched(value TEXT); CREATE TRIGGER injected AFTER INSERT ON ${table} BEGIN INSERT INTO untouched VALUES('effect'); END;`));
      const before=image(f.filename);
      expect(()=>f.owner.inspectMappingFormat()).toThrow("UNSUPPORTED_FORMAT");
      expect(image(f.filename)).toBe(before);expect(existsSync(f.backup)).toBe(false);
    }
  });
  it("refuses owned views, altered checks, and extra owned-table indexes without changing store",()=>{
    for(const statement of [
      "DROP TABLE metadata; CREATE VIEW metadata AS SELECT 1 AS id,0 AS revision",
      "ALTER TABLE metadata ADD COLUMN injected TEXT",
      "CREATE INDEX unexpected_reports ON reports(saved_at)",
    ]){
      const f=fixture(false);db(f.filename,o=>o.exec(statement));const before=image(f.filename);
      expect(()=>f.owner.inspectMappingFormat()).toThrow("UNSUPPORTED_FORMAT");expect(image(f.filename)).toBe(before);
    }
  });
  it("preserves unrelated objects and data without executing unrelated triggers or views",()=>{
    const f=fixture(false);
    db(f.filename,o=>o.exec("CREATE TABLE unrelated(id INTEGER PRIMARY KEY,value TEXT); INSERT INTO unrelated VALUES(1,'preserved'); CREATE TABLE unrelated_events(value TEXT); CREATE TRIGGER unrelated_guard AFTER INSERT ON unrelated BEGIN INSERT INTO unrelated_events VALUES('effect'); END; CREATE VIEW unrelated_view AS SELECT value FROM unrelated;"));
    const old=db(f.filename,o=>canonical(o.prepare("SELECT * FROM sqlite_schema WHERE name LIKE 'unrelated%' ORDER BY name").all()));
    const review=f.owner.inspectMappingFormat();known(f.owner.upgradeMappings(review,randomUUID()));
    expect(db(f.filename,o=>canonical(o.prepare("SELECT * FROM sqlite_schema WHERE name LIKE 'unrelated%' ORDER BY name").all()))).toBe(old);
    expect(db(f.filename,o=>o.prepare("SELECT * FROM unrelated").all())).toEqual([{id:1,value:"preserved"}]);
    expect(db(f.filename,o=>o.prepare("SELECT * FROM unrelated_events").all())).toEqual([]);
    expect(db(f.backup,o=>o.prepare("SELECT * FROM unrelated").all())).toEqual([{id:1,value:"preserved"}]);
  });
  it("keeps existing review guards and rejects changed guard SQL rather than trusting its name",()=>{
    const f=fixture(false);
    db(f.filename,o=>o.exec("DROP TRIGGER review_events_no_update; CREATE TRIGGER review_events_no_update BEFORE UPDATE ON review_events BEGIN SELECT 1; END;"));
    const before=image(f.filename);expect(()=>f.owner.inspectMappingFormat()).toThrow("UNSUPPORTED_FORMAT");
    expect(image(f.filename)).toBe(before);expect(existsSync(f.backup)).toBe(false);
  });
  it("enforces mapping receipt immutability and strictly validates authorized inserted receipt DTOs",()=>{
    const f=fixture(),operation=randomUUID();
    const registered=known(f.owner.registerSource("source",0,operation));
    db(f.filename,o=>{
      expect(()=>o.prepare("UPDATE mapping_operations SET action='reject' WHERE operation_id=?").run(operation)).toThrow();
      expect(()=>o.prepare("DELETE FROM mapping_operations WHERE operation_id=?").run(operation)).toThrow();
    });
    const seed=db(f.filename,o=>o.prepare("SELECT * FROM mapping_operations WHERE operation_id=?").get(operation)!);
    for(const change of [
      {batchId:{unexpected:"object"}},{payloadDigest:HASH+"\n"},{requestDigest:"invalid"},
      {upgrade:{originalSnapshotDigest:HASH,backupSnapshotDigest:HASH,backupIdentityDigest:HASH}},
      {action:["register_source"]},
    ]){
      const id=randomUUID(),receipt={...registered,...change,operationId:id};
      db(f.filename,o=>o.prepare("INSERT INTO mapping_operations VALUES(?,?,?,?,?)").run(id,"register_source",
        typeof receipt.requestDigest==="string"?receipt.requestDigest:HASH,String(seed.scope_json),JSON.stringify(receipt)));
      expect(()=>f.owner.receipt(id)).toThrow();
    }
    expect(f.owner.receipt(operation)).toEqual(registered);
  });
  it("holds original import and mapping records in one rollback on SQL ownership collision",async()=>{
    const f=fixture();known(f.owner.registerSource("source",0,randomUUID()));
    const p=payload();
    // A legitimate old Impact reservation owned by another source is not released.
    db(f.filename,o=>o.prepare("INSERT INTO entity_identity VALUES(?,?)").run("entity","other-source"));
    const before=image(f.filename),op=randomUUID();
    await expect(f.owner.stageComplete(p,1,op)).rejects.toThrow("IDENTITY_CONFLICT");
    expect(image(f.filename)).toBe(before);expect(f.owner.receipt(op)).toBeNull();
  });
  it("cannot enroll an invisible existing source even with a Public configured authority",()=>{
    for(const wrongScope of [false,true]){
      const f=fixture(),value=payload().input;
      const hidden={...value,source:{...value.source,privacy:"internal" as const,
        siteId:wrongScope?"other-site":value.source.siteId}};
      importImpactSnapshot(f.filename,hidden,{expectedRevision:0,actor:"fixture",now:NOW});
      const owner=createImpactMappingOperator({...f.config,grant:{...f.config.grant,allowInternal:false}});
      const before=image(f.filename),operation=randomUUID();
      expect(()=>owner.registerSource("source",1,operation)).toThrow("SCOPE_DENIED");
      expect(image(f.filename)).toBe(before);expect(owner.receipt(operation)).toBeNull();
    }
    const f=fixture(),value=payload().input;
    importImpactSnapshot(f.filename,value,{expectedRevision:0,actor:"fixture",now:NOW});
    const owner=createImpactMappingOperator({...f.config,grant:{...f.config.grant,allowInternal:false}});
    expect(known(owner.registerSource("source",1,randomUUID())).decision).toBe("source_registered");
  });
  it("treats actual COMMIT busy as unknown, keeps a bounded receipt lookup, and never retries",async()=>{
    const f=fixture();known(f.owner.registerSource("source",0,randomUUID()));
    let keeper:DatabaseSync|undefined;
    f.setObserver(async request=>{
      keeper=new DatabaseSync(f.filename,{readOnly:true});
      keeper.exec("BEGIN");keeper.prepare("SELECT * FROM metadata").all();
      return proof(request);
    });
    const before=image(f.filename),op=randomUUID();
    try{
      const outcome=await f.owner.stageComplete(payload(),1,op);
      expect(outcome).toEqual({outcome:"unknown",operationId:op,action:"stage",code:"RECOVERY_REQUIRED",receipt:null});
    }finally{keeper?.exec("ROLLBACK");keeper?.close();}
    expect(image(f.filename)).toBe(before);expect(f.owner.receipt(op)).toBeNull();
    expect(db(f.filename,o=>o.prepare("SELECT COUNT(*) AS n FROM mapping_versions").get()!.n)).toBe(0);
  },10000);
  it("refuses revision exhaustion before adding authority, history, or receipt",()=>{
    const f=fixture();db(f.filename,o=>o.prepare("UPDATE metadata SET revision=? WHERE id=1").run(Number.MAX_SAFE_INTEGER));
    const before=image(f.filename),op=randomUUID();
    expect(()=>f.owner.registerSource("source",Number.MAX_SAFE_INTEGER,op)).toThrow();
    expect(image(f.filename)).toBe(before);expect(f.owner.receipt(op)).toBeNull();
  });
});
