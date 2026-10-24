import path from "node:path";
import { createHash } from "node:crypto";
import {
  MappingError, MAPPED_CODE_ADAPTER_VERSION, compileMappedCodeSource,
  normalizeMappingSourceImport, mappingSourceContentFingerprint, mappingSourceFingerprint,
  type Classification, type MappingDigest, type MappingSourceReadRequest,
  type MappingSourceReadResult, type MappingReadObservationContext, type ImpactImport,
  type CodeSourceMapping, type MappedCodeOptions, type DeepReadonly
} from "@atlas/impact";
import type { FixedMappingObserverRuntime } from "./impact-mapping-native.js";
import {
  Admission, absolute, authority, context, copyData, fail, freeze, hash, id, object,
  ordinary, readFile, relative, requireValue, strictJson, tagged, text, timestamp, legacyText
} from "./impact-mapping-private.js";

interface FixedMappingSourceCommon {
  readonly schema: "lmti.impact.mapping-source.v1";
  readonly sourceId: string;
  readonly projectId: string;
  readonly siteId: string;
  readonly environmentId: string;
  readonly root: string;
  readonly descriptorFile: string;
  readonly parserVersion: string;
  readonly policyVersion: string;
}
export type FixedMappingSourceConfig =
  | (FixedMappingSourceCommon & { readonly kind: "manifest"; readonly minimumClassification: Classification; readonly allowInternal: boolean })
  | (FixedMappingSourceCommon & { readonly kind: "code"; readonly minimumClassification: "public"; readonly allowInternal: false; readonly allowedInputs: readonly string[] });
export interface FixedMappingSourceObserver {
  observe(request: MappingSourceReadRequest, context: MappingReadObservationContext): Promise<MappingSourceReadResult>;
  isIdle(): boolean;
  waitForIdle(): Promise<void>;
}
const CAP = 4194304, DESCRIPTOR_CAP = 131072;
function config(value: FixedMappingSourceConfig): FixedMappingSourceConfig {
  const raw = copyData(value, 131072);
  const common = ["schema", "sourceId", "projectId", "siteId", "environmentId", "root",
    "descriptorFile", "parserVersion", "policyVersion", "kind", "minimumClassification", "allowInternal"];
  const o = object(raw, common, ["allowedInputs"]);
  requireValue(o.schema === "lmti.impact.mapping-source.v1" && (o.kind === "manifest" || o.kind === "code") &&
    (o.minimumClassification === "public" || o.minimumClassification === "internal") && typeof o.allowInternal === "boolean");
  requireValue(o.allowInternal || o.minimumClassification === "public", "SCOPE_DENIED");
  const base: FixedMappingSourceCommon = { schema: o.schema, sourceId: id(o.sourceId),
    projectId: id(o.projectId, true), siteId: id(o.siteId, true), environmentId: id(o.environmentId, true),
    root: absolute(o.root), descriptorFile: relative(o.descriptorFile),
    parserVersion: legacyText(o.parserVersion, 80), policyVersion: legacyText(o.policyVersion, 160) };
  if (o.kind === "manifest") {
    requireValue(!Object.hasOwn(o, "allowedInputs"));
    return freeze({ ...base, kind: "manifest", minimumClassification: o.minimumClassification, allowInternal: o.allowInternal });
  }
  requireValue(o.minimumClassification === "public" && o.allowInternal === false &&
    base.parserVersion === MAPPED_CODE_ADAPTER_VERSION);
  requireValue(Array.isArray(o.allowedInputs) && o.allowedInputs.length >= 1 && o.allowedInputs.length <= 100);
  const allowedInputs = o.allowedInputs.map(v => relative(v));
  requireValue(allowedInputs.every(v => /\.(?:ts|js)$/iu.test(v)));
  requireValue(new Set(allowedInputs.map(v => v.replaceAll("\\", "/"))).size === allowedInputs.length);
  allowedInputs.sort();
  return freeze({ ...base, kind: "code", minimumClassification: "public", allowInternal: false, allowedInputs });
}
export function mappingSourceAuthorityFingerprint(value: FixedMappingSourceConfig): MappingDigest {
  return tagged("lmti.impact.mapping.source-authority.v1", config(value));
}
function sourceMatches(input: DeepReadonly<ImpactImport>, c: FixedMappingSourceConfig): void {
  const s = input.source;
  requireValue(s.id === c.sourceId && s.projectId === c.projectId && s.siteId === c.siteId &&
    s.environmentId === c.environmentId && s.kind === c.kind && s.parserVersion === c.parserVersion, "SOURCE_CHANGED");
}
function classification(input: DeepReadonly<ImpactImport>, c: FixedMappingSourceConfig): Classification {
  const internal = c.minimumClassification === "internal" || input.source.privacy === "internal" ||
    [...input.entities, ...input.evidence, ...input.assertions].some(row => row.privacy === "internal");
  requireValue(c.allowInternal || !internal, "SCOPE_DENIED"); return internal ? "internal" : "public";
}
/** All descriptor fields and input locators are validated before calling the
 * existing synchronous compiler. That compiler owns its bounded file opens. */
function descriptor(value: unknown, c: Extract<FixedMappingSourceConfig, { kind: "code" }>): MappedCodeOptions {
  const o = object(value, ["source", "mappings"]);
  const s = object(o.source, ["id", "projectId", "siteId", "environmentId", "privacy", "revision",
    "capturedAt", "parserVersion", "complete"], ["maxAgeSeconds"]);
  const normalized = normalizeMappingSourceImport({ schema: "lmti.impact.import.v1",
    source: { ...s, kind: "code", digest: "0".repeat(64) }, entities: [], evidence: [], assertions: [] });
  sourceMatches(normalized, c); requireValue(normalized.source.privacy === "public", "SCOPE_DENIED");
  requireValue(Array.isArray(o.mappings) && o.mappings.length >= 1 && o.mappings.length <= 100);
  const allowed = new Set(c.allowedInputs.map(v => v.replaceAll("\\", "/")));
  const mappings: CodeSourceMapping[] = o.mappings.map(value => {
    const m = object(value, ["entityId", "sourceKey", "file", "exportName", "label", "ownerRole", "privacy"], ["version"]);
    const file = relative(m.file).replaceAll("\\", "/");
    requireValue(allowed.has(file), "CONFIG_CHANGED");
    requireValue(m.privacy === "public", "SCOPE_DENIED");
    const exportName = text(m.exportName, 100);
    requireValue(/^[A-Za-z_$][\w$]*$/u.test(exportName));
    return { entityId: id(m.entityId), sourceKey: legacyText(m.sourceKey, 240), file, exportName,
      label: legacyText(m.label, 240), ownerRole: legacyText(m.ownerRole, 100), privacy: "public",
      ...(m.version !== undefined ? { version: legacyText(m.version, 160) } : {}) };
  });
  requireValue(new Set(mappings.map(m => JSON.stringify([m.file, m.exportName]))).size === mappings.length);
  const { digest: _digest, kind: _kind, ...source } = normalized.source;
  return { root: c.root, source: { ...source }, mappings };
}
export function createFixedMappingSourceObserver(
  value: FixedMappingSourceConfig, runtime: FixedMappingObserverRuntime
): FixedMappingSourceObserver {
  const c = config(value), pin = mappingSourceAuthorityFingerprint(c);
  requireValue(runtime !== null && typeof runtime === "object" &&
    typeof runtime.authorize === "function" && typeof runtime.clock === "function");
  const admission = new Admission(runtime.authorize), clock = runtime.clock;
  return Object.freeze({
    isIdle: () => admission.isIdle(), waitForIdle: () => admission.waitForIdle(),
    async observe(input: MappingSourceReadRequest, ctx: MappingReadObservationContext): Promise<MappingSourceReadResult> {
      context(ctx);
      const req = object(copyData(input, CAP + 16384), ["phase", "pass", "authority", "acceptedImport", "expectedContentFingerprint"]);
      requireValue(req.phase === "current" && (req.pass === 1 || req.pass === 2));
      const a = authority(req.authority);
      requireValue(a.kind !== "native", "UNSUPPORTED_MAPPING");
      requireValue(a.sourceId === c.sourceId && a.projectId === c.projectId && a.siteId === c.siteId &&
        a.environmentId === c.environmentId && a.kind === c.kind && a.minimumClassification === c.minimumClassification &&
        a.sourceAuthorityFingerprint === pin && a.policyVersion === c.policyVersion, "CONFIG_CHANGED");
      const expected = normalizeMappingSourceImport(req.acceptedImport), expectedFingerprint = hash(req.expectedContentFingerprint);
      requireValue(mappingSourceContentFingerprint(expected) === expectedFingerprint);
      sourceMatches(expected, c); classification(expected, c);
      admission.begin(); const deadline = performance.now() + 5000;
      const check = () => {
        admission.check();
        requireValue(!ctx.signal.aborted && performance.now() <= deadline, "OWNER_UNAVAILABLE");
      };
      try {
        check(); await ordinary(c.root, true, check);
        const filename = path.join(c.root, c.descriptorFile);
        const before = await readFile(filename, c.kind === "manifest" ? CAP : DESCRIPTOR_CAP, check);
        check();
        let current: DeepReadonly<ImpactImport>;
        if (c.kind === "manifest") {
          current = normalizeMappingSourceImport(strictJson(before.bytes, CAP));
        } else {
          const options = descriptor(strictJson(before.bytes, DESCRIPTOR_CAP), c);
          // Preflight every declared file before compiler I/O, and bind the bytes
          // it reports to post-compile reads. No mutable descriptor adds authority.
          const files = [...new Set(options.mappings.map(m => m.file))].sort();
          for (const file of files) { check(); await ordinary(path.join(c.root, file), false, check); }
          check(); const compiled = compileMappedCodeSource(options); check();
          current = normalizeMappingSourceImport(compiled.snapshot);
          let total = 0;
          for (const file of compiled.inputs) {
            check(); const after = await readFile(path.join(c.root, file.file), 262144, check);
            total += after.bytes.length; requireValue(total <= 1048576, "BUDGET_EXCEEDED");
            // This compares raw file bytes, not normalized source text.
            requireValue(createHash("sha256").update(after.bytes).digest("hex") === file.digest, "SOURCE_CHANGED");
          }
        }
        check(); sourceMatches(current, c);
        const effective = classification(current, c), contentFingerprint = mappingSourceContentFingerprint(current);
        requireValue(contentFingerprint === expectedFingerprint, "SOURCE_CHANGED");
        const after = await readFile(filename, c.kind === "manifest" ? CAP : DESCRIPTOR_CAP, check);
        requireValue(after.identity === before.identity && after.bytes.equals(before.bytes), "SOURCE_CHANGED");
        check(); const content = { sourceId: c.sourceId, authorityFingerprint: pin,
          revision: current.source.revision, digest: current.source.digest, classification: effective };
        const result = freeze({ observation: { ...content, checkedAt: timestamp(clock()),
          fingerprint: mappingSourceFingerprint(content) }, contentFingerprint });
        check(); return result;
      } catch (error) {
        if (error instanceof MappingError) {
          if (error.code === "INVALID_INPUT") fail("SOURCE_UNAVAILABLE");
          throw error;
        }
        fail("SOURCE_UNAVAILABLE");
      } finally { admission.end(); }
    }
  });
}
