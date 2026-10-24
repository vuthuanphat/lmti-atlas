import { mkdtemp, writeFile, mkdir, rm, lstat, readFile, link } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  compileMappedCodeSource, MAPPED_CODE_ADAPTER_VERSION, mappingSourceContentFingerprint,
  mappingSourceFingerprint, type ImpactImport, type MappingSourceAuthority, type MappingSourceReadRequest
} from "@atlas/impact";
import { createFixedMappingSourceObserver, mappingSourceAuthorityFingerprint, type FixedMappingSourceConfig } from "../src/impact-mapping-source.js";

const roots: string[] = [], workers: Promise<unknown>[] = [];
const now = "2026-10-20T10:00:00.000Z", uuid = "11111111-2222-4333-8444-555555555555";
afterEach(async () => {
  await Promise.allSettled(workers.splice(0));
  for (const root of roots.splice(0)) {
    expect(path.dirname(root)).toBe(path.resolve(os.tmpdir()));
    expect(path.basename(root)).toMatch(/^lmti-current-source-/);
    expect((await lstat(root)).isSymbolicLink()).toBe(false);
    await rm(root, { recursive: true });
  }
});
function imported(): ImpactImport {
  return { schema: "lmti.impact.import.v1", source: { id: "source-one", projectId: "project-one",
    siteId: "site-one", environmentId: "test", privacy: "public", kind: "manifest",
    revision: "r1", digest: "d".repeat(64), capturedAt: now, parserVersion: "manifest-one", complete: true },
    entities: [{ id: "service-one", sourceKey: "service-one", kind: "service", label: "Service",
      ownerRole: "developer", privacy: "public" }],
    evidence: [{ id: "evidence-one", entityId: "service-one", locator: "docs/service.md",
      summary: "Declared service", capturedAt: now, privacy: "public" }], assertions: [] };
}
async function fixture(kind: "manifest" | "code" = "manifest", policyVersion = "policy-one") {
  const root = await mkdtemp(path.join(path.resolve(os.tmpdir()), "lmti-current-source-")); roots.push(root);
  const base = { schema: "lmti.impact.mapping-source.v1" as const, sourceId: "source-one", projectId: "project-one",
    siteId: "site-one", environmentId: "test", root, descriptorFile: "descriptor.json", policyVersion };
  let accepted = imported(), descriptor: unknown = accepted;
  const config: FixedMappingSourceConfig = kind === "manifest"
    ? { ...base, kind, parserVersion: "manifest-one", minimumClassification: "public", allowInternal: false }
    : { ...base, kind, parserVersion: MAPPED_CODE_ADAPTER_VERSION, minimumClassification: "public", allowInternal: false,
      allowedInputs: ["src/one.ts"] };
  if (kind === "code") {
    await mkdir(path.join(root, "src")); await writeFile(path.join(root, "src/one.ts"), "export function one() { return 1; }\n");
    const { digest: _digest, kind: _kind, ...source } = accepted.source;
    const options = { root, source: { ...source, parserVersion: MAPPED_CODE_ADAPTER_VERSION },
      mappings: [{ entityId: "code-one", sourceKey: "one", file: "src/one.ts", exportName: "one",
        label: "One", ownerRole: "developer", privacy: "public" as const }] };
    accepted = compileMappedCodeSource(options).snapshot;
    descriptor = { source: options.source, mappings: options.mappings };
  }
  await writeFile(path.join(root, config.descriptorFile), JSON.stringify(descriptor));
  const authority: MappingSourceAuthority = { sourceId: config.sourceId, projectId: config.projectId,
    siteId: config.siteId, environmentId: config.environmentId, kind, minimumClassification: "public",
    sourceAuthorityFingerprint: mappingSourceAuthorityFingerprint(config), nativeProjectId: config.projectId,
    nativeStoreUuid: uuid, nativeAuthorityFingerprint: "a".repeat(64), policyVersion };
  const request: MappingSourceReadRequest = { phase: "current", pass: 1, authority, acceptedImport: accepted,
    expectedContentFingerprint: mappingSourceContentFingerprint(accepted) };
  let authorized = true, checks = 0, onCheck: (() => void) | undefined;
  const observer = createFixedMappingSourceObserver(config, {
    authorize: () => { checks++; onCheck?.(); if (!authorized) throw new Error("private revoked text"); },
    clock: () => now
  });
  return { root, config, accepted, descriptor, request, observer,
    revoke: () => { authorized = false; }, restore: () => { authorized = true; },
    checks: () => checks, setCheck: (callback: () => void) => { onCheck = callback; } };
}
function observe(f: Awaited<ReturnType<typeof fixture>>, req = f.request, signal = new AbortController().signal) {
  const p = f.observer.observe(req, { signal, timeoutMilliseconds: 40000 });
  workers.push(p); void p.catch(() => {}); return p;
}
describe("fixed current source observers", () => {
  it("returns stable full manifest content and source evidence without persisting or changing files", async () => {
    const f = await fixture("manifest", "p".repeat(160));
    const filename = path.join(f.root, f.config.descriptorFile), before = await readFile(filename);
    const first = await observe(f), second = await observe(f, { ...f.request, pass: 2 });
    expect(first).toEqual(second);
    expect(first.contentFingerprint).toBe(mappingSourceContentFingerprint(f.accepted));
    const { checkedAt, fingerprint, ...content } = first.observation;
    expect(checkedAt).toBe(now); expect(fingerprint).toBe(mappingSourceFingerprint(content));
    expect(Object.isFrozen(first.observation)).toBe(true);
    expect(await readFile(filename)).toEqual(before); expect(f.observer.isIdle()).toBe(true);
  });
  it("detects edited content despite unchanged self-declared source revision and digest", async () => {
    const f = await fixture(), changed = structuredClone(f.accepted);
    changed.entities[0].label = "Edited with unchanged digest";
    await writeFile(path.join(f.root, f.config.descriptorFile), JSON.stringify(changed));
    await expect(observe(f)).rejects.toThrow("SOURCE_CHANGED");
  });
  it("accepts a deliberate new accepted manifest without repinning immutable authority", async () => {
    const f = await fixture(), changed = structuredClone(f.accepted);
    changed.source.revision = "r2"; changed.source.digest = "e".repeat(64); changed.entities[0].label = "New accepted label";
    await writeFile(path.join(f.root, f.config.descriptorFile), JSON.stringify(changed));
    const result = await observe(f, { ...f.request, acceptedImport: changed,
      expectedContentFingerprint: mappingSourceContentFingerprint(changed) });
    expect(result.observation.authorityFingerprint).toBe(f.request.authority.sourceAuthorityFingerprint);
    expect(result.observation.revision).toBe("r2");
  });
  it("copies config/request and never treats accepted metadata as a file locator", async () => {
    const f = await fixture(), pending = observe(f);
    (f.config as { descriptorFile: string }).descriptorFile = "must-not-open.json";
    f.accepted.source.revision = "mutated";
    expect((await pending).observation.revision).toBe("r1");
  });
  it.each([
    ["semantic duplicate", (s: string) => s.replace('"label":"Service"', '"label":"Service","\\u006cabel":"Changed"')],
    ["unpaired high scalar", (s: string) => s.replace('"Service"', '"before\\ud800after"')],
    ["unpaired low scalar", (s: string) => s.replace('"Service"', '"before\\udc00after"')],
    ["malformed UTF8", (s: string) => Buffer.from(s.replace('"Service"', '"beforeMARKafter"')).map((b, i, a) =>
      i >= 1 && a.subarray(i, i + 4).toString() === "MARK" ? 255 : b)],
    ["extra source field", (s: string) => s.replace('"complete":true', '"complete":true,"path":"private"')],
    ["trailing NUL", (s: string) => s + "\0"]
  ])("refuses malformed source bytes: %s", async (_name, change) => {
    const f = await fixture();
    await writeFile(path.join(f.root, f.config.descriptorFile), change(JSON.stringify(f.accepted)));
    await expect(observe(f)).rejects.toThrow("SOURCE_UNAVAILABLE");
  });
  it("preserves valid supplementary metadata", async () => {
    const f = await fixture(), changed = structuredClone(f.accepted); changed.entities[0].label = "before😀after";
    await writeFile(path.join(f.root, f.config.descriptorFile), JSON.stringify(changed).replace("😀", "\\ud83d\\ude00"));
    const result = await observe(f, { ...f.request, acceptedImport: changed,
      expectedContentFingerprint: mappingSourceContentFingerprint(changed) });
    expect(result.contentFingerprint).toBe(mappingSourceContentFingerprint(changed));
  });
  it("rejects native-as-source and authority mismatches before looking at missing files", async () => {
    const f = await fixture();
    await rm(path.join(f.root, f.config.descriptorFile));
    await expect(observe(f, { ...f.request, authority: { ...f.request.authority, kind: "native" } })).rejects.toThrow("UNSUPPORTED_MAPPING");
    await expect(observe(f, { ...f.request, authority: { ...f.request.authority, sourceAuthorityFingerprint: "b".repeat(64) } })).rejects.toThrow("CONFIG_CHANGED");
  });
  it("refuses a real hardlinked descriptor before publishing any source result", async () => {
    const f = await fixture(), filename = path.join(f.root, f.config.descriptorFile),
      alias = path.join(f.root, "descriptor-alias.json"), before = await readFile(filename);
    // Both names are inside this freshly owned root; unsupported hosts fail with
    // their actual OS code rather than silently pretending the guard executed.
    try { await link(filename, alias); }
    catch (error) { throw new Error(`Hardlink fixture unavailable: ${(error as NodeJS.ErrnoException).code ?? "unknown"}`); }
    expect((await lstat(filename)).nlink).toBe(2);
    await expect(observe(f)).rejects.toThrow("SOURCE_UNAVAILABLE");
    expect(await readFile(filename)).toEqual(before); expect(await readFile(alias)).toEqual(before);
    expect(f.observer.isIdle()).toBe(true);
  });
  it("does not serve a partial Public view of an Internal source", async () => {
    const f = await fixture(), changed = structuredClone(f.accepted); changed.evidence[0].privacy = "internal";
    await writeFile(path.join(f.root, f.config.descriptorFile), JSON.stringify(changed));
    await expect(observe(f, { ...f.request, acceptedImport: changed,
      expectedContentFingerprint: mappingSourceContentFingerprint(changed) })).rejects.toThrow("SCOPE_DENIED");
  });
  it("allows an explicitly Internal-capable manifest and raises effective source classification", async () => {
    const f = await fixture(), accepted = structuredClone(f.accepted); accepted.evidence[0].privacy = "internal";
    const config: FixedMappingSourceConfig = { ...f.config, kind: "manifest", minimumClassification: "public", allowInternal: true };
    const source = createFixedMappingSourceObserver(config, { authorize: () => {}, clock: () => now });
    await writeFile(path.join(f.root, config.descriptorFile), JSON.stringify(accepted));
    const result = await source.observe({ ...f.request, authority: { ...f.request.authority,
      sourceAuthorityFingerprint: mappingSourceAuthorityFingerprint(config) }, acceptedImport: accepted,
      expectedContentFingerprint: mappingSourceContentFingerprint(accepted) },
    { signal: new AbortController().signal, timeoutMilliseconds: 40000 });
    expect(result.observation.classification).toBe("internal");
  });
  it("keeps BUSY through admitted source work and latches authorization revocation", async () => {
    const f = await fixture(), pending = observe(f);
    await expect(observe(f)).rejects.toThrow("BUSY");
    f.revoke(); await expect(pending).rejects.toThrow("CONFIG_CHANGED");
    await f.observer.waitForIdle(); expect(f.observer.isIdle()).toBe(true);
    f.restore(); await expect(observe(f)).rejects.toThrow("CONFIG_CHANGED");
  });
  it("canceling a source check releases admission only when that worker unwinds", async () => {
    const f = await fixture(), controller = new AbortController(), pending = observe(f, f.request, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow("OWNER_UNAVAILABLE");
    await f.observer.waitForIdle();
    expect((await observe(f)).observation.revision).toBe("r1");
  });
  it("uses original capturedAt and actual raw code bytes for code freshness", async () => {
    const f = await fixture("code"), first = await observe(f);
    expect(first.contentFingerprint).toBe(mappingSourceContentFingerprint(f.accepted));
    await writeFile(path.join(f.root, "src/one.ts"), "export function one() { return 2; }\n");
    await expect(observe(f)).rejects.toThrow("SOURCE_CHANGED");
    const descriptor = f.descriptor as { source: Parameters<typeof compileMappedCodeSource>[0]["source"]; mappings: Parameters<typeof compileMappedCodeSource>[0]["mappings"] };
    const accepted = compileMappedCodeSource({ root: f.root, ...descriptor }).snapshot;
    expect(accepted.source.capturedAt).toBe(now); expect(accepted.source.revision).toBe("r1");
    const result = await observe(f, { ...f.request, acceptedImport: accepted,
      expectedContentFingerprint: mappingSourceContentFingerprint(accepted) });
    expect(result.observation.authorityFingerprint).toBe(first.observation.authorityFingerprint);
  });
  it("does not allow mutable descriptors to expand file inventory even inside the same root", async () => {
    const f = await fixture("code"), descriptor = structuredClone(f.descriptor) as { mappings: Array<{ file: string }> };
    descriptor.mappings[0].file = "src/new.ts"; // This file deliberately does not exist.
    await writeFile(path.join(f.root, f.config.descriptorFile), JSON.stringify(descriptor));
    await expect(observe(f)).rejects.toThrow("CONFIG_CHANGED");
  });
  it("hashes immutable code inventory by raw sorted order, preserving exact path spelling", async () => {
    const f = await fixture("code");
    const first = { ...f.config, kind: "code" as const, minimumClassification: "public" as const, allowInternal: false as const,
      allowedInputs: ["src/B.ts", "src/a.ts"] };
    expect(mappingSourceAuthorityFingerprint(first)).toBe(mappingSourceAuthorityFingerprint({ ...first, allowedInputs: [...first.allowedInputs].reverse() }));
    expect(mappingSourceAuthorityFingerprint(first)).not.toBe(mappingSourceAuthorityFingerprint({ ...first, allowedInputs: ["src/b.ts", "src/a.ts"] }));
    expect(() => mappingSourceAuthorityFingerprint({ ...first, allowedInputs: ["../escape.ts"] })).toThrow();
  });
  it("rejects extra/getter config without invoking the getter", async () => {
    const f = await fixture(); let calls = 0;
    const bad = { ...f.config, get unexpected() { calls++; return "not a capability"; } };
    expect(() => mappingSourceAuthorityFingerprint(bad)).toThrow(); expect(calls).toBe(0);
  });
  it.each(["evidence", "assertions"] as const)("accepts5000 %s within the full4MiB source bound", async family => {
    const f = await fixture(), accepted = structuredClone(f.accepted);
    accepted.entities.push({ ...accepted.entities[0], id: "service-two", sourceKey: "service-two" });
    if (family === "evidence") accepted.evidence = Array.from({ length: 5000 }, (_, i) => ({ ...accepted.evidence[0], id: `evidence-${i}` }));
    else accepted.assertions = Array.from({ length: 5000 }, (_, i) => ({ id: `assertion-${i}`, subjectId: "service-one",
      predicate: "depends_on" as const, objectId: "service-two", basis: "desired" as const, polarity: "supports" as const,
      evidenceIds: ["evidence-one"], applicableChanges: ["availability" as const], privacy: "public" as const }));
    const bytes = Buffer.from(JSON.stringify(accepted)); expect(bytes.length).toBeLessThan(4194304);
    await writeFile(path.join(f.root, f.config.descriptorFile), bytes);
    const expectedContentFingerprint = mappingSourceContentFingerprint(accepted);
    expect((await observe(f, { ...f.request, acceptedImport: accepted, expectedContentFingerprint })).contentFingerprint).toBe(expectedContentFingerprint);
  });
});
