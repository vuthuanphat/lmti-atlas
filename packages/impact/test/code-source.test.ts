import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { compileMappedCodeSource, createSyntheticImpactDemo, getImpactEvidence, importImpactSnapshot, initializeImpactStore, reviewImpactImport } from "../src/index.js";

const temporary: string[] = [], now = "2026-10-12T05:00:00.000Z";
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "lmti-code-source-test-")); temporary.push(root);
  mkdirSync(path.join(root, "src"));
  writeFileSync(path.join(root, "src", "labels.ts"), 'export function renderLabel(packageCode: string): string { return "fixture-v1" + packageCode; }\n');
  const demo = createSyntheticImpactDemo(now), { digest: _ignored, kind: _kind, ...source } = demo.foundation[0].source;
  const mappings = [{ entityId: "label-code", sourceKey: "code:labels", file: "src/labels.ts", exportName: "renderLabel", label: "Package label handler", ownerRole: "Fixture reviewer", privacy: "public" as const, version: "A" }];
  return { root, source, mappings, grant: demo.grant };
}
afterEach(() => {
  const parent = realpathSync(tmpdir());
  for (const candidate of temporary.splice(0)) {
    const resolved = realpathSync(candidate), relative = path.relative(parent, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative) || !path.basename(resolved).startsWith("lmti-code-source-test-")) throw new Error("Unexpected fixture cleanup path");
    rmSync(resolved, { recursive: true, force: true });
  }
});

describe("explicit code source mapping", () => {
  it("reads a real named declaration and returns only identities, provenance and file digests", () => {
    const f = fixture(), result = compileMappedCodeSource(f);
    expect(result.snapshot.entities[0].id).toBe("label-code");
    expect(result.snapshot.assertions).toEqual([]);
    expect(result.snapshot.evidence[0].locator).toBe("src/labels.ts#export:renderLabel");
    expect(result.inputs).toHaveLength(1); expect(result.inputs[0].digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(result)).not.toContain("fixture-v1");
    expect(JSON.stringify(result)).not.toContain("return");
    const filename = path.join(f.root, "impact.sqlite"); initializeImpactStore(filename);
    const staged = importImpactSnapshot(filename, result.snapshot, { actor: "fixture", expectedRevision: 0, now });
    reviewImpactImport(filename, staged.batchId, { decision: "accept", expectedRevision: staged.graphRevision, reviewer: "fixture", evidenceReviewed: true, grant: f.grant, now });
    expect(getImpactEvidence(filename, f.grant, result.snapshot.evidence[0].id).record.entityId).toBe("label-code");
  });
  it("detects same-size content changes even with restored mtime, and keeps explicitly mapped identity after rename", () => {
    const f = fixture(), filename = path.join(f.root, "src", "labels.ts"), before = compileMappedCodeSource(f), times = statSync(filename);
    writeFileSync(filename, 'export function renderLabel(packageCode: string): string { return "fixture-v2" + packageCode; }\n');
    utimesSync(filename, times.atime, times.mtime);
    const after = compileMappedCodeSource(f);
    expect(statSync(filename).size).toBe(times.size);
    expect(after.inputs[0].digest).not.toBe(before.inputs[0].digest);
    expect(after.snapshot.source.digest).not.toBe(before.snapshot.source.digest);
    renameSync(filename, path.join(f.root, "src", "renamed.ts"));
    const renamed = compileMappedCodeSource({ ...f, mappings: [{ ...f.mappings[0], file: "src/renamed.ts" }] });
    expect(renamed.snapshot.entities[0].id).toBe(before.snapshot.entities[0].id);
    expect(renamed.snapshot.evidence[0].id).toBe(before.snapshot.evidence[0].id);
    expect(renamed.snapshot.evidence[0].locator).toBe("src/renamed.ts#export:renderLabel");
  });
  it("does not treat fake exports in comments or strings as declarations", () => {
    const f = fixture(), filename = path.join(f.root, "src", "labels.ts");
    for (const body of ['// export function renderLabel() {}\n', '/* export function renderLabel() {} */\n', 'const misleading = "export function renderLabel() {}";\n']) {
      writeFileSync(filename, body);
      expect(() => compileMappedCodeSource(f)).toThrow("MAPPED_EXPORT_NOT_FOUND");
    }
    writeFileSync(filename, '/* export function fake() {} */\nexport function renderLabel(): string { return "literal"; }');
    expect(compileMappedCodeSource(f).snapshot.entities[0].id).toBe("label-code");
    writeFileSync(filename, 'export function renderLabel() { return `export function fake() {}`; }');
    expect(() => compileMappedCodeSource(f)).toThrow("UNSUPPORTED_CODE_SYNTAX");
  });
  it("rejects traversal, absolute paths and junctions escaping the allowed root", () => {
    const f = fixture();
    for (const file of ["../outside.ts", "src/../../outside.ts", "C:/outside.ts", ".lmti/secret.ts"]) {
      expect(() => compileMappedCodeSource({ ...f, mappings: [{ ...f.mappings[0], file }] })).toThrow("CODE_PATH_DENIED");
    }
    const other = fixture(), link = path.join(f.root, "linked");
    symlinkSync(path.join(other.root, "src"), link, process.platform === "win32" ? "junction" : "dir");
    expect(() => compileMappedCodeSource({ ...f, mappings: [{ ...f.mappings[0], file: "linked/labels.ts" }] })).toThrow("CODE_PATH_DENIED");
  });
  it("rejects private markers, non-public mappings, binary data and unsupported syntax without returning contents", () => {
    const f = fixture(), filename = path.join(f.root, "src", "labels.ts");
    expect(() => compileMappedCodeSource({ ...f, source: { ...f.source, privacy: "internal" } })).toThrow("CODE_SOURCE_PRIVACY_DENIED");
    writeFileSync(filename, '// @lmti-private\nexport function renderLabel() {}');
    expect(() => compileMappedCodeSource(f)).toThrow("CODE_SOURCE_PRIVACY_DENIED");
    writeFileSync(filename, Buffer.from([0, 255, 3]));
    expect(() => compileMappedCodeSource(f)).toThrow(/CODE_ENCODING_DENIED/u);
    writeFileSync(filename, "export declare function renderLabel(): string;");
    expect(() => compileMappedCodeSource(f)).toThrow("MAPPED_EXPORT_NOT_FOUND");
    writeFileSync(filename, "export function renderLabel() { return /fixture/; }");
    expect(() => compileMappedCodeSource(f)).toThrow("UNSUPPORTED_CODE_SYNTAX");
  });
});
