import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ImpactError, digest, grantFingerprint, validateImport,
  type ImpactGrant, type ImpactImport,
} from "../src/model.js";
import {
  MappingError, MAPPING_LIMITS, canonicalMappingJson, mappingNativeFingerprint,
  mappingPayloadDigest, mappingSourceFingerprint, normalizeMappingImport, transitionMapping,
  type MappingBeforeState, type MappingCode, type MappingImport, type MappingNativeObservation,
  type MappingObservations, type MappingRow, type MappingScope, type MappingSourceAuthority,
  type MappingTarget, type MappingTransition,
} from "../src/mapping.js";

// Pure in-memory cases only. These fixtures are not native observations, SQLite
// transactions, transport/replay evidence, or an accepted-mapping serving API.
const NOW = "2026-10-20T04:00:00.000Z";
const STORE = "c78dab62-8939-43d0-b498-28d9356ed865";
const NATIVE = "622eb31e-5a07-474d-8849-6a349b541f83";
type Mutable<T> = T extends readonly (infer E)[] ? Mutable<E>[]
  : T extends object ? { -readonly [K in keyof T]: Mutable<T[K]> } : T;
function copy<T>(value: T): Mutable<T> { return structuredClone(value) as Mutable<T>; }
function sha(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function uuid(n: number): string { return `57a9f130-b017-4f82-92c5-${n.toString(16).padStart(12, "0")}`; }
function order(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function json(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(json).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort(order)
    .map(k => `${JSON.stringify(k)}:${json((value as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(value);
}
function denied(run: () => unknown, code: MappingCode): void {
  try { run(); throw new Error("Expected a bounded mapping refusal"); }
  catch (error) {
    expect(error).toBeInstanceOf(MappingError);
    expect(error).toBeInstanceOf(ImpactError);
    expect((error as MappingError).code).toBe(code);
    expect((error as Error).message).toBe(code);
  }
}
function authority(): MappingSourceAuthority {
  return { sourceId: "source-a", projectId: "project-a", siteId: "site-a", environmentId: "test",
    kind: "manifest", minimumClassification: "public", sourceAuthorityFingerprint: sha("fixed-source"),
    nativeProjectId: "project-a", nativeStoreUuid: NATIVE, nativeAuthorityFingerprint: sha("fixed-native"),
    policyVersion: "source-policy-one" };
}
function scope(allowInternal = true): MappingScope {
  const grant: ImpactGrant = { principalId: "reviewer-a", projectId: "project-a", siteIds: ["site-a"],
    environmentIds: ["test"], allowInternal, policyVersion: "grant-policy-one" };
  return { grant, authority: authority(), grantFingerprint: grantFingerprint(grant) };
}
function before(): MappingBeforeState {
  return { storeUuid: STORE, graphRevision: 1, authority: authority(), acceptedImport: null,
    acceptedMapping: null, latestBatchId: null, identities: [], keys: [],
    capacity: { registeredSources: 1, versions: 0, identities: 0, keys: 0, operations: 0, authoritiesBytes: 512 } };
}
function legacy(): ImpactImport {
  return {
    schema: "lmti.impact.import.v1",
    source: { id: "source-a", projectId: "project-a", siteId: "site-a", environmentId: "test",
      privacy: "public", kind: "manifest", revision: "source-one", digest: sha("source-bytes"),
      capturedAt: NOW, parserVersion: "fixture-one", complete: true },
    entities: [
      { id: "service-a", sourceKey: "service:main", kind: "service", label: "Service", ownerRole: "Fixture", privacy: "public" },
      { id: "code-a", sourceKey: "code:main", kind: "code_unit", label: "Code", ownerRole: "Fixture", privacy: "public" },
    ],
    evidence: [{ id: "evidence-a", locator: "fixtures/source.json#service", summary: "Fixture declaration.",
      capturedAt: NOW, observedAt: NOW, entityId: "service-a", privacy: "public" }],
    assertions: [{ id: "assertion-a", subjectId: "service-a", predicate: "implemented_by",
      objectId: "code-a", basis: "desired", polarity: "supports", evidenceIds: ["evidence-a"],
      applicableChanges: ["config", "code"], privacy: "public" }],
  };
}
function row(n = 1): MappingRow {
  return { mappingId: uuid(n), externalKey: `external-${n}`, generation: "generation-one",
    aliases: [], classification: "public", evidenceIds: ["evidence-a"], state: "active",
    impactEntityId: "service-a", replacesMappingId: null, kind: "identity",
    target: { projectId: "project-a", storeUuid: NATIVE, kind: "component", id: `component-${n}` } };
}
function imported(rows: readonly MappingRow[] = [row()], version = "mapping-one", accepted: string | null = null,
  input: ImpactImport = legacy()): MappingImport {
  const body = { schema: "lmti.impact.mapping-import.v1" as const, input,
    expectedAcceptedVersion: accepted, mappingVersion: version, mappings: rows };
  return { ...body, payloadDigest: mappingPayloadDigest(body) };
}
function bulkImport(count: number): MappingImport {
  // Normalize only the small legacy baseline. Bulk fixture rows are already
  // sorted and normalized; independent framing leaves exactly one full
  // production validation pass in each boundary test.
  const body = { schema: "lmti.impact.mapping-import.v1" as const,
    input: normalizeMappingImport(imported()).input,
    expectedAcceptedVersion: null, mappingVersion: "bulk-boundary",
    mappings: Array.from({ length: count }, (_, i) => row(i + 1)) };
  return { ...body, payloadDigest: sha("lmti.impact.mapping.payload.v1\n" + json(body)) };
}
function ref(id: string): string { return sha(`reference:${id}`); }
function sealObservations(value: Mutable<MappingObservations>): MappingObservations {
  const { checkedAt: _s, fingerprint: _sf, ...source } = value.source;
  const { checkedAt: _n, fingerprint: _nf, ...native } = value.native;
  native.targets.sort((a, b) => {
    for (const key of ["projectId", "storeUuid", "kind", "id"] as const) {
      const c = order(a.target[key], b.target[key]); if (c) return c;
    }
    return 0;
  });
  return { source: { ...source, checkedAt: value.source.checkedAt,
      fingerprint: sha("lmti.impact.mapping.source-observation.v1\n" + json(source)) },
    native: { ...native, checkedAt: value.native.checkedAt,
      fingerprint: sha("lmti.impact.mapping.native-observation.v1\n" + json(native)) } };
}
function observations(original: MappingBeforeState, input: MappingImport): Mutable<MappingObservations> {
  const targets = new Map<string, MappingTarget>();
  for (const r of [...(original.acceptedMapping?.mappings ?? []), ...input.mappings])
    targets.set(json(r.target), r.target);
  return copy(sealObservations({
    source: { sourceId: "source-a", authorityFingerprint: authority().sourceAuthorityFingerprint,
      revision: input.input.source.revision, digest: input.input.source.digest, classification: "public",
      checkedAt: NOW, fingerprint: "" },
    native: { schema: 2, projectId: "project-a", storeUuid: NATIVE, revision: 7,
      authorityFingerprint: authority().nativeAuthorityFingerprint, checkedAt: NOW, fingerprint: "",
      targets: [...targets.values()].map(t => ({ target: copy(t), effectiveClassification: "public",
        ancestryFingerprint: sha(`ancestry:${t.kind}:${t.id}`),
        referenceFingerprint: t.kind === "repository" || t.kind === "knowledge" ? ref(t.id) : null,
        identityState: t.kind === "repository" || t.kind === "knowledge" ? "present_reference" : "active" })) },
  }));
}
function transition(original = before(), input = imported(), grant = scope()): MappingTransition {
  return transitionMapping(original, grant, input, observations(original, input));
}
// Model only the documented accepted before-state shape. No persistence is
// implied; SQLite reservation/receipt/transaction tests live in the owner suite.
function accepted(original: MappingBeforeState, result: MappingTransition): MappingBeforeState {
  return { ...copy(original), graphRevision: original.graphRevision + 1,
    acceptedImport: result.candidate.input, acceptedMapping: result.candidate, latestBatchId: result.candidate.batchId,
    identities: [...original.identities, ...result.reserveIdentities].map(r =>
      result.retireOnAccept.includes(r.mappingId) ? { ...r, retiredBatchId: result.candidate.batchId } : r),
    keys: [...original.keys, ...result.reserveKeys],
    capacity: { ...original.capacity, versions: original.capacity.versions + 1,
      operations: original.capacity.operations + 1, identities: original.capacity.identities + result.reserveIdentities.length,
      keys: original.capacity.keys + result.reserveKeys.length } };
}

describe("pure reviewed Impact mappings", () => {
  it("preserves schema2 golden observation bytes and hashes truthful schema3 in the same domain", () => {
    const storeUuid = "11111111-2222-4333-8444-555555555555";
    const native: Omit<MappingNativeObservation, "checkedAt" | "fingerprint"> = {
      schema: 2, projectId: "project-one", storeUuid, revision: 7, authorityFingerprint: "a".repeat(64),
      targets: [
        { target: { projectId: "project-one", storeUuid, kind: "component", id: "component-one" },
          effectiveClassification: "public", ancestryFingerprint: "b".repeat(64),
          referenceFingerprint: null, identityState: "active" },
        { target: { projectId: "project-one", storeUuid, kind: "repository", id: "repository-one" },
          effectiveClassification: "public", ancestryFingerprint: "d".repeat(64),
          referenceFingerprint: "c".repeat(64), identityState: "present_reference" },
      ],
    };
    // Literal hashes were independently calculated from sorted JSON using
    // SHA256(domain + LF + UTF8), without invoking a production normalizer.
    const legacy = "724204f06d0784ff8a784bedf33e5f2a836a03686727354d3a28b4c065e3a667";
    const schema3 = "162d6abb9fbc9d1e234e29ac31e8db556efd88057d086ce8bb8e228e350ccff9";
    expect(sha("lmti.impact.mapping.native-observation.v1\n" + json(native))).toBe(legacy);
    expect(mappingNativeFingerprint(native)).toBe(legacy);
    const current = { ...native, schema: 3 as const };
    expect(sha("lmti.impact.mapping.native-observation.v1\n" + json(current))).toBe(schema3);
    expect(mappingNativeFingerprint(current)).toBe(schema3);
    expect(mappingNativeFingerprint({ ...current, targets: [...current.targets].reverse() })).toBe(schema3);
    expect(canonicalMappingJson(current)).toBe(json(native).replace('"schema":2', '"schema":3'));
    for (const schema of [0, 1, 4, 2.5, true, false, "2", "3", null]) {
      denied(() => mappingNativeFingerprint({ ...native, schema } as unknown as typeof native), "UNSUPPORTED_FORMAT");
    }
  });
  it("accepts a complete schema3 observation without relabeling schema2 fingerprints", () => {
    const input = imported(), original = observations(before(), input);
    const changed = copy(original); changed.native.schema = 3;
    // Historical schema2 hash cannot authenticate otherwise identical schema3.
    denied(() => transitionMapping(before(), scope(), input, changed), "INVALID_INPUT");
    const current = sealObservations(changed);
    expect(current.native.schema).toBe(3);
    expect(current.native.fingerprint).not.toBe(original.native.fingerprint);
    const reviewed = transitionMapping(before(), scope(), input, current);
    expect(reviewed.candidate).toEqual(transitionMapping(before(), scope(), input, original).candidate);
    expect(reviewed.diffDigest).toBe(transitionMapping(before(), scope(), input, original).diffDigest);
    const incomplete = copy(current); incomplete.native.targets = [];
    denied(() => transitionMapping(before(), scope(), input, sealObservations(incomplete)), "NATIVE_UNAVAILABLE");
  });
  it("normalizes raw identity order with independently framed digests and preserves legacy hashing", () => {
    const raw = legacy(), legacyDigest = digest(validateImport(raw));
    const r = { ...row(), aliases: ["a_", "a.", "A", "a-"] };
    const input = imported([r]), normalized = normalizeMappingImport(input);
    expect(normalized.mappings[0].aliases).toEqual(["A", "a-", "a.", "a_"]);
    expect(canonicalMappingJson({ "a_": 4, "a.": 3, A: 1, "a-": 2 })).toBe('{"A":1,"a-":2,"a.":3,"a_":4}');
    const { payloadDigest, ...body } = normalized;
    expect(payloadDigest).toBe(sha("lmti.impact.mapping.payload.v1\n" + json(body)));
    const reordered = copy(input);
    reordered.input.entities.reverse(); reordered.input.assertions[0].applicableChanges.reverse();
    reordered.mappings[0].aliases.reverse();
    expect(normalizeMappingImport(reordered)).toEqual(normalized);
    expect(digest(validateImport(raw))).toBe(legacyDigest);
    expect(raw.entities[0].id).toBe("service-a");
    expect(Object.isFrozen(raw)).toBe(false);
    expect(Object.isFrozen(normalized.input.entities[0])).toBe(true);
    expect(Object.isFrozen(normalized.mappings[0].target)).toBe(true);
  });

  it("rejects non-data objects and malformed scalars without executing caller getters", () => {
    let calls = 0;
    const getter = { ...imported() };
    Object.defineProperty(getter, "mappings", { enumerable: true, get() { calls++; return []; } });
    denied(() => normalizeMappingImport(getter), "INVALID_INPUT");
    const proxy = new Proxy(imported(), { ownKeys() { calls++; return []; } });
    denied(() => normalizeMappingImport(proxy), "INVALID_INPUT");
    expect(calls).toBe(0);
    const badValues = [undefined, NaN, Infinity, "\ud800", "\udc00", "\udc00\ud800"];
    for (const bad of badValues) {
      const value = copy(imported()) as unknown as Record<string, any>;
      value.input.entities[0].label = bad;
      denied(() => normalizeMappingImport(value), "INVALID_INPUT");
    }
    const sparse = copy(imported()); delete sparse.mappings[0];
    denied(() => normalizeMappingImport(sparse), "INVALID_INPUT");
    const custom = Object.assign(Object.create({ inherited: true }), imported());
    denied(() => normalizeMappingImport(custom), "INVALID_INPUT");
    const cycle: any = {}; cycle.self = cycle;
    denied(() => canonicalMappingJson(cycle), "INVALID_INPUT");
    const symbol = { [Symbol("field")]: true };
    denied(() => canonicalMappingJson(symbol), "INVALID_INPUT");
    const hidden = Object.defineProperty({}, "field", { value: true });
    denied(() => canonicalMappingJson(hidden), "INVALID_INPUT");
    const supplied = copy(imported());
    const nullPrototype = Object.assign(Object.create(null), supplied);
    expect(normalizeMappingImport(nullPrototype)).toEqual(normalizeMappingImport(supplied));
    const unicode = legacy(); unicode.entities[0].label = "Plant \u{1f331}";
    expect(normalizeMappingImport(imported([row()], "unicode", null, unicode)).input.entities
      .find(e => e.id === "service-a")!.label).toBe("Plant \u{1f331}");
  });

  it("requires exact nested fields and leaves duplicate-byte JSON detection to the transport", () => {
    for (const path of ["top", "input", "source", "entity", "evidence", "assertion", "row", "target"]) {
      const value = copy(imported()) as unknown as Record<string, any>;
      const target = path === "top" ? value : path === "input" ? value.input : path === "source" ? value.input.source
        : path === "entity" ? value.input.entities[0] : path === "evidence" ? value.input.evidence[0]
          : path === "assertion" ? value.input.assertions[0] : path === "row" ? value.mappings[0] : value.mappings[0].target;
      target.unexpected = "fixture";
      denied(() => normalizeMappingImport(value), "INVALID_INPUT");
    }
    const digestChanged = copy(imported()); digestChanged.payloadDigest = sha("wrong");
    denied(() => normalizeMappingImport(digestChanged), "INVALID_INPUT");
    const undefinedOptional = copy(imported()) as any; undefinedOptional.input.source.maxAgeSeconds = undefined;
    denied(() => normalizeMappingImport(undefinedOptional), "INVALID_INPUT");
    // Already parsed objects have no duplicate-key history. This layer makes no
    // claim about recovering duplicates from discarded JSON tokens.
    expect(canonicalMappingJson(JSON.parse('{"x":1,"x":2}'))).toBe('{"x":2}');
  });

  it("refuses trailing newlines on every exact UUID/digest boundary including embedded legacy digests", () => {
    const baseline = imported();
    expect(normalizeMappingImport(baseline).payloadDigest).toBe(baseline.payloadDigest);
    expect(normalizeMappingImport(baseline).mappings[0].mappingId).toBe(uuid(1));
    expect(normalizeMappingImport(baseline).mappings[0].target.storeUuid).toBe(NATIVE);
    expect(uuid(1).split("-").map(part => part.length)).toEqual([8, 4, 4, 4, 12]);
    denied(() => imported([{ ...row(), mappingId: row().mappingId + "\n" }]), "INVALID_INPUT");
    denied(() => imported([{ ...row(), target: { ...row().target, storeUuid: NATIVE + "\n" } }]), "INVALID_INPUT");
    const source = legacy(); source.source.digest += "\n";
    denied(() => imported([row()], "bad-source-hash", null, source), "INVALID_INPUT");
    for (const part of ["source", "native"] as const) {
      const obs = observations(before(), baseline); obs[part].fingerprint += "\n";
      denied(() => transitionMapping(before(), scope(), baseline, obs), "INVALID_INPUT");
    }
    const payload = copy(baseline); payload.payloadDigest += "\n";
    denied(() => normalizeMappingImport(payload), "INVALID_INPUT");
    const code: MappingRow = { ...row(), kind: "code", target: { ...row().target, kind: "repository" },
      selection: "src/main.ts", referenceFingerprint: ref(row().target.id) };
    expect(transition(before(), imported([code])).candidate.mappings[0].kind).toBe("code");
    denied(() => imported([{ ...code, referenceFingerprint: code.referenceFingerprint + "\n" }]), "INVALID_INPUT");
    const { checkedAt: _n, fingerprint: _nf, ...native } = observations(before(), baseline).native;
    expect(mappingNativeFingerprint(native)).toHaveLength(64);
    denied(() => mappingNativeFingerprint({ ...native, authorityFingerprint: native.authorityFingerprint + "\n" }), "INVALID_INPUT");
  });

  it("supports all four finite mapping variants and treats selections only as safe relative metadata", () => {
    const base = row();
    const code: MappingRow = { ...base, mappingId: uuid(2), externalKey: "code", kind: "code",
      target: { ...base.target, kind: "repository", id: "repository-a" }, selection: "src\\main.ts",
      referenceFingerprint: ref("repository-a") };
    const document: MappingRow = { ...base, mappingId: uuid(3), externalKey: "document", kind: "document",
      target: { ...base.target, kind: "knowledge", id: "knowledge-a" }, selection: "guide/overview.md",
      referenceFingerprint: ref("knowledge-a") };
    const memory: MappingRow = { ...base, mappingId: uuid(4), externalKey: "memory", kind: "memory",
      target: { ...base.target, kind: "component" }, disclosure: "owner_safe_summary" };
    const result = transition(before(), imported([base, code, document, memory]));
    expect(result.candidate.mappings.map(r => r.kind)).toEqual(["identity", "code", "document", "memory"]);
    expect(result.candidate.mappings[1]).toHaveProperty("selection", "src/main.ts");
    expect(result.reserveIdentities).toHaveLength(4);
    for (const selection of ["/abs", "../parent", "C:/root", "\\\\server\\file", ".env", "a/.git/config", "a/NUL.txt", "a/part:other", "a//b"]) {
      denied(() => imported([{ ...code, selection }]), "INVALID_INPUT");
    }
    denied(() => imported([{ ...code, target: { ...code.target, kind: "component" } } as any]), "UNSUPPORTED_MAPPING");
    denied(() => imported([{ ...memory, disclosure: "raw_memory" } as any]), "UNSUPPORTED_MAPPING");
    denied(() => imported([{ ...memory, text: "Unrequested stored text" } as any]), "INVALID_INPUT");
    denied(() => imported([{ ...base, target: { ...base.target, id: "colon:denied" } }]), "INVALID_INPUT");
    const maxNative = { ...base, target: { ...base.target, id: "a".repeat(64) } };
    expect(imported([maxNative]).mappings[0].target.id).toHaveLength(64);
    denied(() => imported([{ ...maxNative, target: { ...maxNative.target, id: "a".repeat(65) } }]), "INVALID_INPUT");
  });

  it("returns complete first-review source, entity, evidence, assertion, mapping and origin changes", () => {
    const original = before(), input = imported(), saved = json({ original, input });
    const result = transition(original, input);
    expect(result.diff.source).toEqual({ before: null, after: input.input.source });
    expect(result.diff.entities.map(c => c.id)).toEqual(["code-a", "service-a"]);
    expect(result.diff.evidence.map(c => c.id)).toEqual(["evidence-a"]);
    expect(result.diff.assertions.map(c => c.id)).toEqual(["assertion-a"]);
    expect(result.diff.mappings).toEqual([{ kind: "added", id: uuid(1), before: null, after: row() }]);
    expect(result.diff.mappingEvidence).toEqual([{ kind: "added", id: json([uuid(1), "evidence-a"]), before: null,
      after: { mappingId: uuid(1), evidenceId: "evidence-a", evidenceBatchId: result.candidate.batchId, evidence: input.input.evidence[0] } }]);
    expect(result.candidate.batchId).toBe("mapping-" + sha("lmti.impact.mapping.batch.v1\n" + input.payloadDigest));
    expect(result.diffDigest).toBe(sha("lmti.impact.mapping.diff.v1\n" + json(result.diff)));
    expect(json({ original, input })).toBe(saved);
    expect(Object.isFrozen(result.diff.mappingEvidence[0].after)).toBe(true);
    expect(result.candidate.input.entities.find(e => e.id === "service-a")!.id).not.toBe(row().target.id);
  });

  it("compares the accepted legacy snapshot on enrollment without inventing old associations", () => {
    const old = legacy(), desired = legacy();
    old.entities[0].label = "Old service"; old.evidence[0].summary = "Old declaration";
    old.assertions[0].polarity = "denies"; old.source.revision = "older-source";
    const original = { ...before(), acceptedImport: old };
    const result = transition(original, imported([row()], "enrolled", null, desired));
    expect(result.diff.source.before?.revision).toBe("older-source");
    expect(result.diff.entities.map(c => [c.kind, c.id])).toEqual([["changed", "service-a"]]);
    expect(result.diff.evidence[0].before?.summary).toBe("Old declaration");
    expect(result.diff.assertions[0].before?.polarity).toBe("denies");
    expect(result.diff.mappings[0].kind).toBe("added");
    expect(result.diff.mappingEvidence[0].before).toBeNull();
  });

  it("allows reviewed metadata correction with unchanged source bytes but rejects a version-only no-op", () => {
    const first = transition(), original = accepted(before(), first), r = copy(row());
    r.aliases = ["renamed-old"];
    const correction = imported([r], "mapping-two", "mapping-one");
    const changed = transition(original, correction);
    expect(changed.diff.source.before).toEqual(changed.diff.source.after);
    expect(changed.diff.entities).toEqual([]);
    expect(changed.diff.mappings[0].kind).toBe("changed");
    denied(() => transition(original, imported([row()], "mapping-only-token", "mapping-one")), "VERSION_CONFLICT");
    const changedSource = legacy(); changedSource.source.parserVersion = "fixture-two";
    expect(transition(original, imported([row()], "source-metadata", "mapping-one", changedSource))
      .diff.source.after.parserVersion).toBe("fixture-two");
  });

  it("retains omitted retirement rows and their exact original evidence across multiple accepted versions", () => {
    const first = transition(), original = accepted(before(), first);
    const empty = legacy(); empty.entities = []; empty.evidence = []; empty.assertions = [];
    const second = transition(original, imported([], "mapping-two", "mapping-one", empty));
    expect(second.candidate.mappings).toEqual([{ ...row(), state: "retired" }]);
    expect(second.retireOnAccept).toEqual([uuid(1)]);
    expect(second.diff.mappings[0]).toMatchObject({ kind: "changed", before: { state: "active" }, after: { state: "retired" } });
    expect(second.evidenceBindings).toEqual(first.evidenceBindings);
    expect(second.diff.mappingEvidence).toEqual([]);
    const afterRetire = accepted(original, second), thirdInput = copy(empty);
    thirdInput.source.parserVersion = "fixture-three";
    const third = transition(afterRetire, imported([], "mapping-three", "mapping-two", thirdInput));
    expect(third.retireOnAccept).toEqual([]);
    expect(third.candidate.mappings).toEqual(second.candidate.mappings);
    expect(third.evidenceBindings[0].evidenceBatchId).toBe(first.candidate.batchId);
    expect(third.evidenceBindings[0].evidenceBatchId).not.toBe(second.candidate.batchId);
    expect(third.diff.mappingEvidence).toEqual([]);
    const refreshed = legacy(); refreshed.evidence[0].summary = "Explicit retired evidence refresh.";
    const explicit = transition(accepted(afterRetire, third),
      imported([{ ...row(), state: "retired" }], "mapping-four", "mapping-three", refreshed));
    expect(explicit.evidenceBindings[0].evidenceBatchId).toBe(explicit.candidate.batchId);
    expect(explicit.diff.mappingEvidence[0]).toMatchObject({ kind: "changed", id: json([uuid(1), "evidence-a"]) });
    expect(explicit.diff.mappingEvidence[0].before?.evidenceBatchId).toBe(first.candidate.batchId);
    expect(explicit.diff.mappingEvidence[0].after?.evidence.summary).toBe("Explicit retired evidence refresh.");
    denied(() => transition(afterRetire, imported([row()], "revive", "mapping-two")), "IDENTITY_CONFLICT");
    denied(() => transition(before(), imported([{ ...row(), state: "retired" }])), "IDENTITY_CONFLICT");
  });

  it("never lowers an association below source, entity, evidence, native or prior classification", () => {
    for (const field of ["authority", "source-observation", "source", "entity", "evidence", "native"] as const) {
      const original = copy(before()), grant = copy(scope()), input = legacy();
      if (field === "authority") original.authority.minimumClassification = grant.authority.minimumClassification = "internal";
      if (field === "source") input.source.privacy = "internal";
      if (field === "entity") input.entities[0].privacy = "internal";
      if (field === "evidence") input.evidence[0].privacy = "internal";
      const request = imported([row()], "internal-floor", null, input), obs = observations(original, request);
      if (field === "source-observation") obs.source.classification = "internal";
      if (field === "native") obs.native.targets[0].effectiveClassification = "internal";
      denied(() => transitionMapping(original, grant, request, sealObservations(obs)), "SCOPE_DENIED");
      const raised = imported([{ ...row(), classification: "internal" }], "raised", null, input);
      expect(transitionMapping(original, grant, raised, sealObservations(obs)).candidate.mappings[0].classification).toBe("internal");
    }
    const internal = imported([{ ...row(), classification: "internal" }]);
    const original = accepted(before(), transition(before(), internal));
    denied(() => transition(original, imported([row()], "lowered", "mapping-one")), "SCOPE_DENIED");
    const memory: MappingRow = { ...row(), kind: "memory", target: { ...row().target, kind: "component" }, disclosure: "owner_safe_summary" };
    const request = imported([memory]), obs = observations(before(), request);
    obs.native.targets[0].effectiveClassification = "internal";
    denied(() => transitionMapping(before(), scope(), request, sealObservations(obs)), "SCOPE_DENIED");
  });

  it("inherits evidence-associated entity privacy even without a direct Impact entity link", () => {
    const source = legacy(); source.entities[0].privacy = "internal";
    const publicRow = { ...row(), impactEntityId: null };
    denied(() => transition(before(), imported([publicRow], "public-indirect", null, source)), "SCOPE_DENIED");
    const internalRow: MappingRow = { ...publicRow, classification: "internal" };
    const first = transition(before(), imported([internalRow], "mapping-one", null, source));
    expect(first.candidate.mappings[0].classification).toBe("internal");
    const empty = legacy(); empty.entities = []; empty.evidence = []; empty.assertions = [];
    const retirement = transition(accepted(before(), first), imported([], "mapping-two", "mapping-one", empty));
    expect(retirement.candidate.mappings[0]).toMatchObject({ state: "retired", classification: "internal", impactEntityId: null });
    expect(retirement.evidenceBindings).toEqual(first.evidenceBindings);
  });

  it("authorizes the complete desired and original scope before stale-version disclosures", () => {
    const hidden = legacy(); hidden.assertions[0].privacy = "internal";
    const input = imported([row()], "new", "stale", hidden);
    denied(() => transition(before(), input, scope(false)), "SCOPE_DENIED");
    const old = accepted(before(), transition(before(), imported([{ ...row(), classification: "internal" }])));
    denied(() => transition(old, imported([], "retire", "stale"), scope(false)), "SCOPE_DENIED");
    const foreign = copy(scope()); foreign.authority.nativeStoreUuid = uuid(100);
    denied(() => transition(before(), imported(), foreign), "SCOPE_DENIED");
    const revoked = copy(scope()); revoked.grant.siteIds = ["other-site"]; revoked.grantFingerprint = grantFingerprint(revoked.grant);
    denied(() => transition(before(), imported(), revoked), "SCOPE_DENIED");
    const replacedGrant = copy(scope()); replacedGrant.grant.policyVersion = "changed";
    denied(() => transition(before(), imported(), replacedGrant), "CONFIG_CHANGED");
  });

  it("requires the complete exact native target set and checks fingerprint, lineage and reference changes", () => {
    const request = imported(), base = observations(before(), request);
    const { checkedAt: _s, fingerprint: _sf, ...source } = base.source;
    const { checkedAt: _n, fingerprint: _nf, ...native } = base.native;
    expect(mappingSourceFingerprint(source)).toBe(base.source.fingerprint);
    expect(mappingNativeFingerprint(native)).toBe(base.native.fingerprint);
    const later = copy(base); later.source.checkedAt = later.native.checkedAt = "2026-10-20T04:01:00.000Z";
    expect(transitionMapping(before(), scope(), request, later).diffDigest).toBe(transition().diffDigest);
    for (const mutation of ["missing", "extra", "hidden", "lineage", "authority"] as const) {
      const obs = copy(base);
      if (mutation === "missing") obs.native.targets = [];
      if (mutation === "extra") obs.native.targets.push({ ...copy(obs.native.targets[0]), target: { ...obs.native.targets[0].target, id: "other" } });
      if (mutation === "hidden") obs.native.targets[0].effectiveClassification = "internal";
      if (mutation === "lineage") { obs.native.storeUuid = uuid(90); obs.native.targets[0].target.storeUuid = uuid(90); }
      if (mutation === "authority") obs.native.authorityFingerprint = sha("changed");
      denied(() => transitionMapping(before(), scope(false), request, sealObservations(obs)), "NATIVE_UNAVAILABLE");
    }
    const wrongHash = copy(base); wrongHash.native.targets[0].ancestryFingerprint = sha("changed");
    denied(() => transitionMapping(before(), scope(), request, wrongHash), "INVALID_INPUT");
    const changedSource = copy(base); changedSource.source.digest = sha("new-source-bytes");
    denied(() => transitionMapping(before(), scope(), request, sealObservations(changedSource)), "SOURCE_CHANGED");
    const code: MappingRow = { ...row(), kind: "code", target: { ...row().target, kind: "repository" },
      selection: "source/main.ts", referenceFingerprint: sha("old-reference") };
    denied(() => transition(before(), imported([code])), "NATIVE_CHANGED");
    const unavailable = copy(base) as any; unavailable.native.targets[0].identityState = "retired";
    denied(() => transitionMapping(before(), scope(), request, unavailable), "INVALID_INPUT");
  });

  it("keeps all six registry kinds distinct even when native IDs have the same spelling", () => {
    const kinds = ["component", "asset", "subsystem", "site", "area", "environment"] as const;
    const rows = kinds.map((kind, i): MappingRow => ({ ...row(i + 1), target: { ...row().target, kind, id: "shared-id" } }));
    const request = imported(rows), obs = observations(before(), request);
    expect(obs.native.targets).toHaveLength(6);
    expect(transitionMapping(before(), scope(), request, obs).reserveIdentities).toHaveLength(6);
    const { checkedAt: _n, fingerprint: _nf, ...native } = obs.native;
    expect(mappingNativeFingerprint({ ...native, targets: [...native.targets].reverse() })).toBe(obs.native.fingerprint);
  });

  it("preserves all reserved aliases and requires an explicit new ID and generation for replacement", () => {
    const first = transition(), original = accepted(before(), first), renamed = copy(row());
    renamed.externalKey = "renamed"; renamed.aliases = ["external-1"];
    const second = transition(original, imported([renamed], "mapping-two", "mapping-one"));
    expect(second.reserveIdentities).toEqual([]);
    expect(second.reserveKeys.map(k => k.key)).toEqual(["renamed"]);
    const afterRename = accepted(original, second), forgotten = copy(renamed); forgotten.aliases = [];
    denied(() => transition(afterRename, imported([forgotten], "mapping-three", "mapping-two")), "IDENTITY_CONFLICT");
    const replacement: MappingRow = { ...row(2), externalKey: "renamed", aliases: ["external-1"],
      generation: "generation-two", replacesMappingId: uuid(1) };
    const third = transition(afterRename, imported([replacement], "mapping-three", "mapping-two"));
    expect(third.diff.replacements).toEqual([{ oldMappingId: uuid(1), newMappingId: uuid(2) }]);
    expect(third.retireOnAccept).toEqual([uuid(1)]);
    expect(third.candidate.mappings.map(r => [r.mappingId, r.state])).toEqual([[uuid(1), "retired"], [uuid(2), "active"]]);
    const afterReplace = accepted(afterRename, third);
    const next: MappingRow = { ...row(3), externalKey: "renamed", aliases: ["external-1"],
      generation: "generation-three", replacesMappingId: uuid(2) };
    const fourth = transition(afterReplace, imported([next], "mapping-four", "mapping-three"));
    expect(fourth.retireOnAccept).toEqual([uuid(2)]);
    expect(fourth.candidate.mappings.map(r => r.state)).toEqual(["retired", "retired", "active"]);
    denied(() => transition(original, imported([{ ...row(2), externalKey: "external-1" }], "silent", "mapping-one")), "IDENTITY_CONFLICT");
    denied(() => transition(original, imported([{ ...row(), target: row(2).target }], "retarget", "mapping-one")), "IDENTITY_CONFLICT");
    denied(() => transition(original, imported([{ ...replacement, generation: "generation-one" }], "same-generation", "mapping-one")), "IDENTITY_CONFLICT");
  });

  it("keeps rejected or pending identity/key reservations and refuses same-generation reuse", () => {
    const staged = transition(), original = copy(before());
    original.identities = copy(staged.reserveIdentities); original.keys = copy(staged.reserveKeys);
    original.capacity.identities = 1; original.capacity.keys = 1; original.capacity.versions = 1;
    const changed = { ...row(), target: row(2).target };
    denied(() => transition(original, imported([changed])), "IDENTITY_CONFLICT");
    denied(() => transition(original, imported([{ ...row(2), externalKey: "external-1" }])), "IDENTITY_CONFLICT");
    // An unused version can reuse exactly its already reserved identity, but it
    // receives neither a fresh identity reservation nor a released key.
    const result = transition(original, imported([row()], "retry-as-new-version"));
    expect(result.reserveIdentities).toEqual([]);
    expect(result.reserveKeys).toEqual([]);
    expect(result.candidate.mappings[0].mappingId).toBe(uuid(1));
  });

  it("validates source time and the last writable graph/native revision boundaries", () => {
    const request = imported(), future = legacy(); future.evidence[0].capturedAt = "2026-10-20T04:02:00.000Z";
    denied(() => transition(before(), imported([row()], "future", null, future)), "INVALID_INPUT");
    const badObserved = legacy(); badObserved.evidence[0].observedAt = "2026-10-20T04:00:01.000Z";
    denied(() => transition(before(), imported([row()], "bad-time", null, badObserved)), "INVALID_INPUT");
    const original = { ...before(), graphRevision: Number.MAX_SAFE_INTEGER - 1 };
    expect(transition(original, request).candidate.mappings).toHaveLength(1);
    denied(() => transition({ ...original, graphRevision: Number.MAX_SAFE_INTEGER }, request), "BUDGET_EXCEEDED");
    const obs = observations(before(), request); obs.native.revision = Number.MAX_SAFE_INTEGER - 1;
    expect(transitionMapping(before(), scope(), request, sealObservations(obs)).candidate.mappings).toHaveLength(1);
    obs.native.revision = Number.MAX_SAFE_INTEGER;
    denied(() => transitionMapping(before(), scope(), request, obs), "INVALID_INPUT");
  });

  it("accepts exactly 2000 independently framed complete mapping rows", () => {
    expect(MAPPING_LIMITS.mappingsPerVersion).toBe(2000);
    const request = bulkImport(2000), normalized = normalizeMappingImport(request);
    expect(request.mappings).toHaveLength(2000);
    expect(normalized.mappings).toHaveLength(2000);
    expect(normalized.payloadDigest).toBe(request.payloadDigest);
    expect(normalized.mappings[1999]).toEqual(row(2000));
  });

  it("refuses 2001 independently framed complete mapping rows", () => {
    const request = bulkImport(2001);
    expect(request.mappings).toHaveLength(2001);
    expect(request.mappings[2000]).toEqual(row(2001));
    denied(() => normalizeMappingImport(request), "BUDGET_EXCEEDED");
  });

  it("bounds complete alias counts and encoded mapping rows independently", () => {
    const aliases = Array.from({ length: 32 }, (_, i) => `alias-${i}`);
    expect(imported([{ ...row(), aliases }]).mappings[0].aliases).toHaveLength(32);
    denied(() => imported([{ ...row(), aliases: [...aliases, "one-too-many"] }]), "BUDGET_EXCEEDED");
    denied(() => imported([{ ...row(), aliases: aliases.map((_, i) => `alias-${i}-` + "x".repeat(180)) }]), "BUDGET_EXCEEDED");
  });

  it("refuses a complete UTF8 import over four MiB while each field and record count remains valid", () => {
    const large = legacy();
    large.evidence = Array.from({ length: 1100 }, (_, i) => ({ ...large.evidence[0], id: `evidence-${i}`,
      summary: "\u{1f331}".repeat(1000) }));
    large.assertions = [];
    const body = { schema: "lmti.impact.mapping-import.v1", input: large,
      expectedAcceptedVersion: null, mappingVersion: "large", mappings: [] };
    expect(large.entities.length).toBeLessThanOrEqual(2000);
    expect(large.evidence.length).toBeLessThanOrEqual(5000);
    expect(large.evidence.every(e => e.summary.length === 2000 && e.entityId === "service-a")).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(body), "utf8")).toBeGreaterThan(4194304);
    denied(() => imported([], "large", null, large), "BUDGET_EXCEEDED");
  });

  it("refuses a native observation containing more than 4000 complete targets", () => {
    const request = imported(), native = observations(before(), request).native;
    const { checkedAt: _n, fingerprint: _nf, ...fields } = native;
    fields.targets = Array.from({ length: 4001 }, (_, i) => ({ ...fields.targets[0], target: { ...fields.targets[0].target, id: `component-${i}` } }));
    denied(() => mappingNativeFingerprint(fields as Omit<MappingNativeObservation, "checkedAt" | "fingerprint">), "BUDGET_EXCEEDED");
  });

  it("counts historical retirement rows and global permanent reservations against admission caps", () => {
    const first = transition(), original = accepted(before(), first);
    const rows = Array.from({ length: 2000 }, (_, i) => row(i + 2));
    // This fixture starts with already normalized accepted legacy fields and
    // sorted rows, so independent framing avoids an extra production-normalizer
    // pass. transitionMapping still validates the entire exact submitted 2000
    // rows before adding the separately retained retired row.
    const body = { schema: "lmti.impact.mapping-import.v1" as const, input: first.candidate.input,
      expectedAcceptedVersion: "mapping-one", mappingVersion: "too-many-retained", mappings: rows };
    const request = { ...body, payloadDigest: sha("lmti.impact.mapping.payload.v1\n" + json(body)) };
    denied(() => transition(original, request), "BUDGET_EXCEEDED");
    for (const field of ["versions", "identities", "keys", "operations"] as const) {
      const full = copy(before());
      full.capacity[field] = field === "versions" ? 1000 : field === "identities" ? 20000 : field === "keys" ? 40000 : 2500;
      denied(() => transition(full), "BUDGET_EXCEEDED");
    }
    const sourceCap = copy(before()); sourceCap.capacity.registeredSources = 201;
    denied(() => transition(sourceCap), "BUDGET_EXCEEDED");
    const policyCap = copy(before()); policyCap.capacity.authoritiesBytes = 131073;
    denied(() => transition(policyCap), "BUDGET_EXCEEDED");
  });

  it("rejects corrupt original evidence linkage and hidden historical evidence without changing input state", () => {
    const first = transition(), original = copy(accepted(before(), first));
    original.acceptedMapping!.evidenceBindings[0].evidenceId = "different";
    denied(() => transition(original, imported([], "retire", "mapping-one")), "INVALID_INPUT");
    const hiddenInput = legacy(); hiddenInput.evidence[0].privacy = "internal";
    const hiddenFirst = transition(before(), imported([{ ...row(), classification: "internal" }], "mapping-one", null, hiddenInput));
    const old = accepted(before(), hiddenFirst), empty = legacy();
    empty.entities = []; empty.evidence = []; empty.assertions = [];
    const retired = transition(old, imported([], "mapping-two", "mapping-one", empty));
    const snapshot = accepted(old, retired), saved = json(snapshot);
    denied(() => transition(snapshot, imported([], "mapping-three", "stale", empty), scope(false)), "SCOPE_DENIED");
    expect(json(snapshot)).toBe(saved);
  });
});
