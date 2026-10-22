import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nativeEntityId, type ImpactReport } from "@atlas/impact";
import { desktopImpactRequest, impactRequest, loadImpactLauncher, setupNativeImpact } from "../src/impact-command";

const owner = vi.hoisted(() => ({ snapshot: {} as Record<string, unknown>, unavailable: false, documentPath: "" }));
vi.mock("../src/impact-native", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/impact-native")>();
  return { ...actual,
    pinNativeSource: async (value: unknown) => ({ ...(value as object), executableDigest: "a".repeat(64) }),
    readNativeOwner: async () => { if (owner.unavailable) throw new Error("source unavailable"); return structuredClone(owner.snapshot); }
  };
});
function nativeFixture() {
  return { schema: "lmti.project.snapshot.v1", projectId: "project-one", revision: 1, site: "site-one", external: true, complete: true, semantics: "declared",
    components: [{ id: "consumer", label: "Consumer", kind: "service", privacy: "public" }, { id: "provider", label: "Provider", kind: "service", privacy: "public" }],
    assets: [{ id: "host", label: "Host", kind: "gateway", site: "site-one", privacy: "public" }],
    releases: [{ id: "release-one", label: "1.0", componentId: "provider", state: "draft", privacy: "public" }],
    bindings: [{ id: "binding-one", assetId: "host", componentId: "provider", desiredReleaseId: "release-one", privacy: "public" }],
    dependencies: [{ id: "dep-one", from: "consumer", to: "provider", contract: "desired contract", privacy: "public" }], connections: [] };
}
function request(op: string, fields: Record<string, unknown> = {}) { return { schema: "lmti.impact.desktop.request.v1", op, projectId: "project-one", expectedProjectRevision: 1, documentPath: owner.documentPath, ...fields }; }
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "lmti-native-impact-cli-"));
  owner.documentPath = path.join(root, "project.sqlite");
  await writeFile(owner.documentPath, "Synthetic owner storage placeholder; process boundary is mocked in this suite.");
  await writeFile(path.join(root, "lmti-project.exe"), "Synthetic owner executable placeholder.");
  vi.stubEnv("LMTI_STUDIO_PROJECT_BINARY", path.join(root, "lmti-project.exe"));
  const setup = await setupNativeImpact(path.join(root, "impact"), { executable: path.join(root, "lmti-project.exe"), database: path.join(root, "project.sqlite"), projectId: "project-one", site: "site-one", target: "external", environmentId: "development" }, "operator", 1);
  return { root, ...setup };
}
async function accepted() {
  const setup = await fixture();
  const imported = await desktopImpactRequest(request("import-native", { graphRevision: 0 }), setup.configPath, true) as { batchId: string; graphRevision: number };
  await desktopImpactRequest(request("review", { batchId: imported.batchId, graphRevision: imported.graphRevision, decision: "accept", evidenceReviewed: true }), setup.configPath, true);
  const loaded = await loadImpactLauncher(setup.configPath), sourceId = loaded.config.sources[0].sourceId;
  const change = { entityId: nativeEntityId(sourceId, "component", "provider"), description: "Review proposed component contract", category: "contract", baselineRevision: "1", proposedRevision: "2", mode: "prospective", targetDeploymentIds: [nativeEntityId(sourceId, "binding", "binding-one")] };
  return { ...setup, change };
}
beforeEach(() => { owner.snapshot = nativeFixture(); owner.unavailable = false; });
afterEach(() => { vi.unstubAllEnvs(); });
describe("native impact CLI and desktop authorization boundary", () => {
  it("sets up an empty isolated store and stages native declarations only after an operator action", async () => {
    const setup = await fixture();
    const overview = await desktopImpactRequest(request("overview"), setup.configPath) as { snapshot: { entities: unknown[] }; reviewEnabled: boolean };
    expect(overview.snapshot.entities).toEqual([]); expect(overview.reviewEnabled).toBe(false);
    await expect(desktopImpactRequest(request("import-native", { graphRevision: 0 }), setup.configPath)).rejects.toThrow("OPERATOR_CAPABILITY_REQUIRED");
    const imported = await desktopImpactRequest(request("import-native", { graphRevision: 0 }), setup.configPath, true) as { state: string; batchId: string; graphRevision: number };
    expect(imported.state).toBe("pending");
    const preview = await desktopImpactRequest(request("import-preview", { batchId: imported.batchId }), setup.configPath) as { batch: { source: { kind: string } } };
    expect(preview.batch.source.kind).toBe("native");
    const again = await desktopImpactRequest(request("import-native", { graphRevision: imported.graphRevision }), setup.configPath, true) as { idempotent: boolean };
    expect(again.idempotent).toBe(true);
  });
  it("rechecks native owner contents for every report and treats availability loss as unknown", async () => {
    const setup = await accepted();
    const agentRequest = { schema: "lmti.impact.request.v1", op: "report", change: setup.change };
    const before = await impactRequest(agentRequest, setup.configPath) as ImpactReport;
    expect(before.sourceVersions[0].freshness).toBe("fresh");
    (owner.snapshot.components as Array<{ label: string }>)[0].label = "Changed without import";
    const after = await impactRequest(agentRequest, setup.configPath) as ImpactReport;
    expect(after.sourceVersions[0].freshness).toBe("stale");
    owner.unavailable = true;
    expect((await impactRequest(agentRequest, setup.configPath) as ImpactReport).sourceVersions[0].freshness).toBe("unknown");
  });
  it("recovers a staged import after launcher replacement was interrupted without reusing a digest for different contents", async () => {
    const setup = await fixture(), originalConfig = await readFile(setup.configPath);
    const staged = await desktopImpactRequest(request("import-native", { graphRevision: 0 }), setup.configPath, true) as { batchId: string; graphRevision: number };
    await writeFile(setup.configPath, originalConfig);
    const recovered = await desktopImpactRequest(request("import-native", { graphRevision: staged.graphRevision }), setup.configPath, true) as { batchId: string; idempotent: boolean };
    expect(recovered).toMatchObject({ batchId: staged.batchId, idempotent: true });
    expect((await loadImpactLauncher(setup.configPath)).config.sources).toHaveLength(1);
  });
  it("rejects native revision drift, scope substitution and Agent access to operator operations", async () => {
    const setup = await accepted();
    await expect(desktopImpactRequest(request("overview", { projectId: "other-project" }), setup.configPath)).rejects.toThrow("NATIVE_SCOPE_DENIED");
    const copiedDocument = path.join(setup.root, "copied-project.sqlite"); await writeFile(copiedDocument, await readFile(owner.documentPath));
    await expect(desktopImpactRequest(request("overview", { documentPath: copiedDocument }), setup.configPath)).rejects.toThrow("NATIVE_SCOPE_DENIED");
    const untrustedBinary = path.join(setup.root, "untrusted-lmti-project.exe"); await writeFile(untrustedBinary, "untrusted binary placeholder");
    vi.stubEnv("LMTI_STUDIO_PROJECT_BINARY", untrustedBinary);
    await expect(desktopImpactRequest(request("overview"), setup.configPath)).rejects.toThrow("NATIVE_BINARY_DENIED");
    vi.stubEnv("LMTI_STUDIO_PROJECT_BINARY", path.join(setup.root, "lmti-project.exe"));
    owner.snapshot.revision = 2;
    await expect(desktopImpactRequest(request("report", { change: setup.change }), setup.configPath)).rejects.toThrow("NATIVE_REVISION_CONFLICT");
    for (const op of ["import-native", "review", "verify", "upgrade", "setup"]) await expect(impactRequest({ schema: "lmti.impact.request.v1", op }, setup.configPath)).rejects.toThrow("OPERATION_DENIED");
    await expect(desktopImpactRequest(request("overview", { grant: {} }), setup.configPath)).rejects.toThrow("UNEXPECTED_FIELD");
  });
  it("refuses accepting a native import whose source changed after staging", async () => {
    const setup = await fixture();
    const imported = await desktopImpactRequest(request("import-native", { graphRevision: 0 }), setup.configPath, true) as { batchId: string; graphRevision: number };
    (owner.snapshot.components as Array<{ label: string }>)[0].label = "Changed";
    await expect(desktopImpactRequest(request("review", { batchId: imported.batchId, graphRevision: imported.graphRevision, decision: "accept", evidenceReviewed: true }), setup.configPath, true)).rejects.toThrow("SOURCE_NOT_CURRENT");
  });
  it("persists human verification separately and hides checked state when its owner source goes stale", async () => {
    const setup = await accepted();
    const displayed = await desktopImpactRequest(request("report", { change: setup.change }), setup.configPath) as { report: ImpactReport };
    await expect(desktopImpactRequest(request("save-report", { report: { ...displayed.report, conclusion: "Tampered report" } }), setup.configPath, true)).rejects.toThrow("REPORT_UNAVAILABLE");
    const saved = await desktopImpactRequest(request("save-report", { report: displayed.report }), setup.configPath, true) as { report: ImpactReport; review: { reviewRevision: number } };
    expect(saved.report).toEqual(displayed.report);
    const overview = await desktopImpactRequest(request("overview"), setup.configPath) as { savedReports: { reports: Array<{ id: string }> } };
    expect(overview.savedReports.reports.map(report => report.id)).toContain(saved.report.id);
    const reopened = await desktopImpactRequest(request("open-report", { id: saved.report.id }), setup.configPath) as { report: ImpactReport };
    expect(reopened.report).toEqual(displayed.report);
    const verification = { reportId: saved.report.id, checklistId: saved.report.checklist[0].id, status: "verified", expectedGraphRevision: saved.report.graphRevision, expectedReviewRevision: saved.review.reviewRevision, evidenceSummary: "Owner checked the desired contract in a synthetic review.", evidenceRef: "review/contract-check" };
    await expect(desktopImpactRequest(request("verify", { verification }), setup.configPath)).rejects.toThrow("OPERATOR_CAPABILITY_REQUIRED");
    const verified = await desktopImpactRequest(request("verify", { verification }), setup.configPath, true) as { review: { entries: Array<{ status: string }> } };
    expect(verified.review.entries.some(entry => entry.status === "verified")).toBe(true);
    expect(saved.report.checklist.every(task => task.status === "pending")).toBe(true);
    (owner.snapshot.components as Array<{ label: string }>)[0].label = "Source drift";
    const stale = await desktopImpactRequest(request("read-review", { reportId: saved.report.id }), setup.configPath) as { review: { current: boolean; entries: unknown[] } };
    expect(stale.review).toMatchObject({ current: false, entries: [] });
  });
  it("does not let caller input choose an executable or overwrite setup files, and reloads revoked scope", async () => {
    const setup = await fixture();
    const before = await readFile(setup.configPath);
    await expect(desktopImpactRequest(request("setup", { documentPath: path.join(setup.root, "project.sqlite"), site: "site-one", environmentId: "development", allowInternal: false, executable: "other" }), setup.configPath, true)).rejects.toThrow("UNEXPECTED_FIELD");
    vi.stubEnv("LMTI_STUDIO_PROJECT_BINARY", path.join(setup.root, "lmti-project.exe"));
    await expect(desktopImpactRequest(request("setup", { documentPath: path.join(setup.root, "project.sqlite"), site: "site-one", environmentId: "development", allowInternal: false }), setup.configPath, true)).rejects.toThrow();
    expect(await readFile(setup.configPath)).toEqual(before);
    const config = JSON.parse(before.toString("utf8")); config.grant.siteIds = ["revoked"];
    await writeFile(setup.configPath, JSON.stringify(config));
    await expect(desktopImpactRequest(request("overview"), setup.configPath)).rejects.toThrow("NATIVE_SCOPE_DENIED");
  });
});
