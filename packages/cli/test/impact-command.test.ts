import { execFileSync, spawn, spawnSync } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import path from "node:path";
import os from "node:os";
import { describe, expect, it } from "vitest";
import { createImpactReport, readImpactSnapshot, saveImpactReport, type ImpactReport } from "@atlas/impact";
import { checkImpactSources, createImpactDemo, impactRequest, loadImpactLauncher } from "../src/impact-command";
import { renderImpactReview } from "../src/impact-view";

async function fixture() {
  const parent = await mkdtemp(path.join(os.tmpdir(), "lmti-impact-boundary-"));
  const demo = await createImpactDemo(path.join(parent, "demo"));
  const change = JSON.parse(await readFile(path.join(demo.directory, "change.json"), "utf8"));
  return { ...demo, change };
}
const request = (op: string, extra = {}) => ({ schema: "lmti.impact.request.v1", op, ...extra });

describe("impact owner CLI boundary", () => {
  it("returns supported paths, business verification and associated host without cohost propagation", async () => {
    const demo = await fixture();
    const report = await impactRequest(request("report", { change: demo.change }), demo.config) as ImpactReport;
    expect(report.sourceVersions).toHaveLength(2);
    expect(report.sourceVersions.every(source => source.freshness === "fresh")).toBe(true);
    expect(report.findings.some(f => f.entity.id === "barcode-scanner")).toBe(true);
    expect(report.findings.some(f => f.entity.id === "dispatch-confirmation")).toBe(true);
    expect(report.findings.find(f => f.entity.id === "warehouse-gateway")?.disposition).toBe("associated_context");
    expect(report.findings.some(f => f.entity.id === "metrics-deployment")).toBe(false);
    expect(report.checklist.length).toBeGreaterThan(0);
  });

  it("detects unimported file changes even if source revision and claimed digest are unchanged", async () => {
    const demo = await fixture();
    const loaded = await loadImpactLauncher(demo.config);
    const manifestPath = path.join(demo.directory, "warehouse-manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const before = createImpactReport(loaded.database, loaded.config.grant, demo.change, { freshness: await checkImpactSources(loaded.root, loaded.config.sources) });
    saveImpactReport(loaded.database, loaded.config.grant, before, { freshness: await checkImpactSources(loaded.root, loaded.config.sources) });
    manifest.entities[0].label = "Changed outside import";
    await writeFile(manifestPath, JSON.stringify(manifest));
    const after = await impactRequest(request("report", { change: demo.change }), demo.config) as ImpactReport;
    expect(after.sourceVersions.find(source => source.sourceId === "warehouse-manifest")?.freshness).toBe("stale");
    await expect(impactRequest(request("open-report", { id: before.id }), demo.config)).rejects.toThrow("REPORT_NO_LONGER_CURRENT");
  });

  it("detects changed raw code independently of the imported code snapshot", async () => {
    const demo = await fixture();
    const file = path.join(demo.directory, "src", "labels.ts");
    const before = await readFile(file, "utf8");
    await writeFile(file, before.replace("LABEL=", "LABEL:"));
    const report = await impactRequest(request("report", { change: demo.change }), demo.config) as ImpactReport;
    expect(report.sourceVersions.find(source => source.sourceId === "warehouse-code")?.freshness).toBe("stale");
    expect(report.findings.every(finding => finding.disposition !== "potentially_affected")).toBe(true);
    expect(JSON.stringify(report)).not.toContain("export function renderLabel");
  });

  it("marks code stale when only its mapping file changes", async () => {
    const demo = await fixture();
    const file = path.join(demo.directory, "code-mapping.json");
    const mapping = JSON.parse(await readFile(file, "utf8"));
    mapping.mappings[0].exportName = "changedWithoutImport";
    await writeFile(file, JSON.stringify(mapping));
    const report = await impactRequest(request("report", { change: demo.change }), demo.config) as ImpactReport;
    expect(report.sourceVersions.find(source => source.sourceId === "warehouse-code")?.freshness).toBe("stale");
  });

  it("does not accept caller grants, paths, source checks or extra operations", async () => {
    const demo = await fixture();
    for (const extra of [{ grant: { allowInternal: true } }, { database: "elsewhere.sqlite" }, { freshness: [] }]) {
      await expect(impactRequest(request("report", { change: demo.change, ...extra }), demo.config)).rejects.toThrow("UNEXPECTED_FIELD");
    }
    await expect(impactRequest(request("import"), demo.config)).rejects.toThrow("OPERATION_DENIED");
    await expect(impactRequest(request("snapshot", { id: "unexpected" }), demo.config)).rejects.toThrow("UNEXPECTED_FIELD");
  });

  it("rechecks revoked scope and refuses source path traversal", async () => {
    const demo = await fixture();
    const config = JSON.parse(await readFile(demo.config, "utf8"));
    config.grant.siteIds = ["other-site"];
    await writeFile(demo.config, JSON.stringify(config));
    await expect(impactRequest(request("entity", { id: "label-code" }), demo.config)).rejects.toThrow("ENTITY_UNAVAILABLE");
    config.sources[0].file = "../outside.json";
    await writeFile(demo.config, JSON.stringify(config));
    await expect(impactRequest(request("snapshot"), demo.config)).rejects.toThrow("PATH_DENIED");
  });

  it("refuses to overwrite an existing demo and leaves its database intact", async () => {
    const demo = await fixture();
    const before = await readFile(path.join(demo.directory, "impact.sqlite"));
    await expect(createImpactDemo(demo.directory)).rejects.toThrow();
    expect(await readFile(path.join(demo.directory, "impact.sqlite"))).toEqual(before);
  });

  it("refuses protected demo directories before creating any fixture files", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "lmti-impact-protected-demo-"));
    for (const protectedName of [".lmti", ".git"]) {
      const protectedRoot = path.join(parent, protectedName);
      await mkdir(protectedRoot);
      const target = path.join(protectedRoot, "new-demo");
      await expect(createImpactDemo(target)).rejects.toThrow("PATH_DENIED");
      await expect(access(target)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("renders source text as escaped content and labels the report as an as-of synthetic review", async () => {
    const demo = await fixture();
    const loaded = await loadImpactLauncher(demo.config);
    const report = await impactRequest(request("report", { change: { ...demo.change, description: '<img src=x onerror="bad()">' } }), demo.config) as ImpactReport;
    const html = renderImpactReview(report, readImpactSnapshot(loaded.database, loaded.config.grant));
    expect(html).not.toContain('<img src=x');
    expect(html).toContain("&lt;img");
    expect(html).toContain("Saved exports are as-of snapshots");
    expect(html).toContain("Verification queue");
    expect(html).toContain("default-src 'none'");
  });

  it("serves the versioned readonly Agent envelope from compiled CLI", async () => {
    const demo = await fixture();
    const cli = path.resolve("packages/cli/dist/index.js");
    const output = execFileSync(process.execPath, [cli, "impact", "request", "--config", demo.config], {
      input: JSON.stringify(request("report", { change: demo.change })), encoding: "utf8", timeout: 10000, windowsHide: true,
      env: { ...process.env, NODE_OPTIONS: "", NODE_PATH: "" }
    });
    const decoded = JSON.parse(output);
    expect(decoded).toMatchObject({ schema: "lmti.impact.response.v1", ok: true, result: { schema: "lmti.impact.report.v1" } });
  });

  it("imports a source delta, refuses revoked-scope review, then refreshes only after authorized review", async () => {
    const demo = await fixture();
    const cli = path.resolve("packages/cli/dist/index.js");
    const run = (...args: string[]) => spawnSync(process.execPath, [cli, "impact", ...args, "--config", demo.config], { encoding: "utf8", timeout: 10000, windowsHide: true, env: { ...process.env, NODE_OPTIONS: "", NODE_PATH: "" } });
    const imported = JSON.parse(run("import", "--file", "source-B.json", "--revision", String(demo.graphRevision)).stdout);
    expect(imported.state).toBe("pending");
    const stale = await impactRequest(request("report", { change: demo.change }), demo.config) as ImpactReport;
    expect(stale.sourceVersions.some(source => source.freshness === "stale")).toBe(true);
    const config = JSON.parse(await readFile(demo.config, "utf8"));
    await writeFile(demo.config, JSON.stringify({ ...config, grant: { ...config.grant, siteIds: ["other-site"] } }));
    const reviewArgs = ["review", "--batch", imported.batchId, "--revision", String(imported.graphRevision), "--decision", "accept", "--reviewer", "synthetic-reviewer", "--evidence-reviewed", "true"];
    const rejected = run(...reviewArgs);
    expect(rejected.status).toBe(3);
    expect(JSON.parse(rejected.stdout).ok).toBe(false);
    await writeFile(demo.config, JSON.stringify(config));
    const reviewed = run(...reviewArgs);
    expect(reviewed.status).toBe(0);
    expect(JSON.parse(reviewed.stdout).state).toBe("accepted");
    const current = await impactRequest(request("report", { change: demo.change }), demo.config) as ImpactReport;
    expect(current.sourceVersions.every(source => source.freshness === "fresh")).toBe(true);
    expect(current.sourceVersions.find(source => source.sourceId === "warehouse-manifest")?.revision).toBe("B");
  });

  it("reimports mapped code with raw input bindings and requires review before it becomes fresh", async () => {
    const demo = await fixture();
    const cli = path.resolve("packages/cli/dist/index.js");
    const run = (...args: string[]) => spawnSync(process.execPath, [cli, "impact", ...args, "--config", demo.config], { encoding: "utf8", timeout: 10000, windowsHide: true, env: { ...process.env, NODE_OPTIONS: "", NODE_PATH: "" } });
    const rawFile = path.join(demo.directory, "src", "labels.ts");
    await writeFile(rawFile, (await readFile(rawFile, "utf8")).replace("LABEL=", "LABEL:"));
    const mappingFile = path.join(demo.directory, "code-mapping.json");
    const mapping = JSON.parse(await readFile(mappingFile, "utf8"));
    mapping.source.revision = "B";
    mapping.mappings[0].version = "B";
    await writeFile(mappingFile, JSON.stringify(mapping));
    const importedResult = run("import-code", "--file", "code-mapping.json", "--revision", String(demo.graphRevision));
    expect(importedResult.status).toBe(0);
    const imported = JSON.parse(importedResult.stdout);
    expect(imported.state).toBe("pending");
    const config = JSON.parse(await readFile(demo.config, "utf8"));
    const codeBinding = config.sources.find((source: { sourceId: string }) => source.sourceId === "warehouse-code");
    expect(codeBinding.inputs).toEqual([
      { file: "src/labels.ts", digest: expect.stringMatching(/^[a-f0-9]{64}$/) },
      { file: "code-mapping.json", digest: expect.stringMatching(/^[a-f0-9]{64}$/) }
    ]);
    const snapshotText = await readFile(path.join(demo.directory, codeBinding.file), "utf8");
    expect(snapshotText).not.toContain("export function renderLabel");
    const pending = await impactRequest(request("report", { change: demo.change }), demo.config) as ImpactReport;
    expect(pending.sourceVersions.find(source => source.sourceId === "warehouse-code")?.freshness).toBe("stale");
    const reviewed = run("review", "--batch", imported.batchId, "--revision", String(imported.graphRevision), "--decision", "accept", "--reviewer", "synthetic-reviewer", "--evidence-reviewed", "true");
    expect(reviewed.status).toBe(0);
    const current = await impactRequest(request("report", { change: demo.change }), demo.config) as ImpactReport;
    expect(current.sourceVersions.find(source => source.sourceId === "warehouse-code")).toMatchObject({ revision: "B", freshness: "fresh" });
    const genericImport = run("import", "--file", codeBinding.file, "--revision", String(JSON.parse(reviewed.stdout).graphRevision));
    expect(genericImport.status).toBe(3);
    expect(JSON.parse(genericImport.stdout).error).toBe("MAPPED_CODE_REQUIRES_CODE_IMPORT");
  });

  it("serves readonly HTTP with fresh checks and revalidates change paths after startup", async () => {
    const demo = await fixture();
    const changes = path.join(demo.directory, "changes");
    const outside = path.join(path.dirname(demo.directory), "outside");
    await mkdir(changes); await mkdir(outside);
    await writeFile(path.join(changes, "change.json"), JSON.stringify(demo.change));
    await writeFile(path.join(outside, "change.json"), JSON.stringify({ ...demo.change, description: "OUTSIDE_BOUNDARY_MARKER" }));
    const child = spawn(process.execPath, [path.resolve("packages/cli/dist/index.js"), "impact", "serve", "--config", demo.config, "--change", "changes/change.json"], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true, env: { ...process.env, NODE_OPTIONS: "", NODE_PATH: "" } });
    try {
      const url = await new Promise<string>((resolve, reject) => {
        let output = "";
        const timeout = setTimeout(() => reject(new Error("Server startup timed out")), 5000);
        child.once("error", error => { clearTimeout(timeout); reject(error); });
        child.stdout.on("data", chunk => {
          output += chunk.toString();
          if (!output.includes("\n")) return;
          clearTimeout(timeout);
          try { resolve(JSON.parse(output.split("\n")[0]).url); } catch { reject(new Error("Invalid startup output")); }
        });
      });
      const response = await fetch(url);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.has("access-control-allow-origin")).toBe(false);
      expect(await response.text()).toContain("Verification queue");
      const deniedHost = await new Promise<number | undefined>((resolve, reject) => {
        const req = httpRequest(url, { headers: { Host: "untrusted.example" } }, res => { res.resume(); resolve(res.statusCode); });
        req.once("error", reject); req.end();
      });
      expect(deniedHost).toBe(404);
      expect((await fetch(url, { method: "POST" })).status).toBe(404);
      const manifest = path.join(demo.directory, "warehouse-manifest.json");
      const source = JSON.parse(await readFile(manifest, "utf8"));
      source.entities[0].label = "Unimported file change";
      await writeFile(manifest, JSON.stringify(source));
      expect((await (await fetch(`${url}api/report`)).json()).sourceVersions.some((s: {freshness: string}) => s.freshness === "stale")).toBe(true);
      await rename(changes, `${changes}-original`);
      await symlink(outside, changes, "junction");
      const swapped = await fetch(url);
      expect(swapped.status).toBe(409);
      expect(await swapped.text()).toBe("PATH_DENIED");
    } finally { child.kill(); }
  }, 10000);
});
