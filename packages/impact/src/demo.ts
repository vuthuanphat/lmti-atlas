import { type ImpactImport, type ImpactGrant, type ChangeRequest, type SourceCheck, digest, timestamp } from "./model.js";

/** Synthetic technical fixture only: no reviewed real warehouse facts or business oracle. */
export function createSyntheticImpactDemo(value = new Date().toISOString()) {
  const now = timestamp(value);
  const grant: ImpactGrant = { principalId: "synthetic-reviewer", projectId: "warehouse-demo", siteIds: ["warehouse-one"], environmentIds: ["test"], allowInternal: true, policyVersion: "synthetic-policy-1" };
  const base: ImpactImport = {
    schema: "lmti.impact.import.v1",
    source: { id: "warehouse-manifest", projectId: grant.projectId, siteId: "warehouse-one", environmentId: "test", privacy: "public", kind: "manifest", revision: "A", digest: "0".repeat(64), capturedAt: now, parserVersion: "synthetic-1", complete: true },
    entities: [
      { id: "label-code", sourceKey: "code:labels", kind: "code_unit", label: "Package label handler", ownerRole: "Software engineer", privacy: "public", version: "A" },
      { id: "label-service", sourceKey: "service:labels", kind: "service", label: "Label service", ownerRole: "Service owner", privacy: "public" },
      { id: "label-deployment", sourceKey: "deployment:labels:test", kind: "deployment", label: "Label deployment in test", ownerRole: "Deployment engineer", privacy: "public", version: "A" },
      { id: "warehouse-gateway", sourceKey: "machine:gateway", kind: "machine", label: "Warehouse gateway", ownerRole: "Site operator", privacy: "public" },
      { id: "barcode-scanner", sourceKey: "device:scanner", kind: "device", label: "Package barcode scanner", ownerRole: "Device integrator", privacy: "public" },
      { id: "warehouse-db", sourceKey: "datastore:packages", kind: "datastore", label: "Package record store", ownerRole: "Data owner", privacy: "public" },
      { id: "dispatch-confirmation", sourceKey: "step:dispatch-confirmation", kind: "business_step", label: "Confirm warehouse dispatch", ownerRole: "Warehouse supervisor", privacy: "public" },
      { id: "metrics-service", sourceKey: "service:metrics", kind: "service", label: "Unrelated metrics service", ownerRole: "Platform engineer", privacy: "public" },
      { id: "metrics-deployment", sourceKey: "deployment:metrics:test", kind: "deployment", label: "Metrics deployment on the same host", ownerRole: "Platform engineer", privacy: "public", version: "metrics-1" }
    ], evidence: [], assertions: []
  };
  const relations = [
    ["code-mapping", "label-service", "implemented_by", "label-code", "Declared mapping to the label handler."],
    ["label-instance", "label-deployment", "instance_of", "label-service", "Desired test deployment targets label source revision A."],
    ["label-host", "label-deployment", "runs_on", "warehouse-gateway", "Declared deployment host; no live machine state is known."],
    ["scanner-contract", "barcode-scanner", "depends_on", "label-deployment", "Scanner contract consumes the packageCode field from the selected test label deployment."],
    ["dispatch-step", "dispatch-confirmation", "depends_on", "label-deployment", "Dispatch confirmation needs the selected label deployment."],
    ["label-data", "label-service", "reads_from", "warehouse-db", "Labels read the package record schema."],
    ["metrics-instance", "metrics-deployment", "instance_of", "metrics-service", "Independent metrics deployment."],
    ["metrics-host", "metrics-deployment", "runs_on", "warehouse-gateway", "The shared host does not prove a code dependency."]
  ] as const;
  for (const [id, subjectId, predicate, objectId, summary] of relations) {
    base.evidence.push({ id: `evidence-${id}`, locator: `warehouse-manifest.json#${id}`, summary, capturedAt: now, privacy: "public" });
    base.assertions.push({ id, subjectId, predicate, objectId, basis: "desired", polarity: "supports", evidenceIds: [`evidence-${id}`], applicableChanges: ["code", "contract", "config", "version", "availability", "unknown"], privacy: "public", ...(id === "scanner-contract" ? { contract: "packageCode" } : {}) });
  }
  const code: ImpactImport = { schema: base.schema, source: { ...base.source, id: "warehouse-code", kind: "code" }, entities: base.entities.filter(e => e.kind === "code_unit"), evidence: [], assertions: [] };
  code.source.digest = digest({ ...code, source: { ...code.source, digest: undefined } });
  base.entities = base.entities.filter(e => e.kind !== "code_unit");
  function variant(revision: string): ImpactImport {
    const result = structuredClone(base);
    result.source.revision = revision;
    if (revision !== "A") {
      result.entities.find(e => e.id === "barcode-scanner")!.label = "Package identifier scanner";
      result.assertions.find(a => a.id === "scanner-contract")!.contract = "packageIdentifier";
      result.evidence.find(e => e.id === "evidence-scanner-contract")!.summary = "Updated declared scanner contract uses packageIdentifier; actual scanner compatibility still needs operator verification.";
    }
    if (revision === "C") {
      result.assertions.find(a => a.id === "scanner-contract")!.basis = "observed";
      result.evidence.find(e => e.id === "evidence-scanner-contract")!.observedAt = now;
      result.evidence.find(e => e.id === "evidence-scanner-contract")!.summary = "Synthetic observation: scanner fixture accepts packageIdentifier. This does not verify real equipment.";
    }
    // Content digest for this synthetic source, not a claim about a live file.
    result.source.digest = digest({ ...result, source: { ...result.source, digest: undefined } });
    return result;
  }
  const imports = { A: variant("A"), B: variant("B"), C: variant("C") };
  function check(snapshot: ImpactImport): SourceCheck[] { return [{ sourceId: snapshot.source.id, status: "available", checkedAt: now, revision: snapshot.source.revision, digest: snapshot.source.digest }]; }
  const change: ChangeRequest = { entityId: "label-code", description: "Rename the packageCode field to packageIdentifier in the label contract.", category: "contract", baselineRevision: "A", proposedRevision: "B", diffDigest: digest("synthetic-packageCode-to-packageIdentifier"), mode: "prospective", targetDeploymentIds: ["label-deployment"] };
  return { foundation: [code], imports, grant, change, checks: { A: [...check(code), ...check(imports.A)], B: [...check(code), ...check(imports.B)], C: [...check(code), ...check(imports.C)] }, now };
}
