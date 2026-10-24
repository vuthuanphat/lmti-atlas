import { formatDoctorReport, type DoctorReport, doctorLmti, canonicalStoragePaths, detectLegacyAtlasStorage, type DoctorSeverity } from "@atlas/migration";
import { runEgressSecretScan, verifyAuditIntegrity } from "@atlas/privacy";
import { type LmtiConfig, checkMemoryPrivacy, getLessonCandidateReviewSummary } from "@atlas/memory";
import { parseArgs } from "../arguments.js";
import { CliBoundaryMessage, CliStatus, printCliEnvelope, printSafeJson, setCliExitCode } from "../output.js";
import { readTextIfExists } from "../files.js";

export async function runDoctor(args: string[], cwd = process.cwd()): Promise<void> {
  const { flags } = parseArgs(args, { fix: "boolean", json: "boolean", security: "boolean" }, 0);
  if (flags.security) {
    const report = await doctorSecurityCommand(cwd);
    const status = report.status === "pass" ? "pass" : report.status === "warn" ? "warn" : "blocked";
    setCliExitCode(status);
    if (flags.json) {
      printCliEnvelope("lmti.doctor.security", status, securityDoctorMessages(report, "warn"), securityDoctorMessages(report, "fail"), report);
      return;
    }
    printSafeJson(report, "doctor security");
    return;
  }
  const report = await doctorCommand(cwd, { fix: Boolean(flags.fix) });
  const status = doctorStatusToCliStatus(report.status);
  setCliExitCode(status);
  if (flags.json) {
    printCliEnvelope("lmti.doctor", status, doctorProblemMessages(report, "warning"), doctorProblemMessages(report, "error"), report);
    return;
  }
  console.log(formatDoctorReport(report));
}

export async function doctorCommand(cwd: string, options: { fix?: boolean } = {}): Promise<DoctorReport> {
  return doctorLmti(cwd, options);
}

export interface SecurityDoctorCheck {
  id: string;
  status: "pass" | "warn" | "fail";
  message: string;
}

export interface SecurityDoctorReport {
  status: "pass" | "warn" | "fail";
  checks: SecurityDoctorCheck[];
  recommendations: string[];
}

export async function doctorSecurityCommand(cwd: string): Promise<SecurityDoctorReport> {
  const checks: SecurityDoctorCheck[] = [];
  const recommendations = new Set<string>();
  const paths = canonicalStoragePaths(cwd);
  const legacy = await detectLegacyAtlasStorage(cwd);

  if (legacy.hasLegacy) {
    checks.push({ id: "legacy-storage", status: "warn", message: "Legacy Atlas storage detected; keep .lmti as canonical and avoid duplicate active mind files." });
    recommendations.add("Run `lmti doctor` or `lmti migrate --yes` before release if legacy storage is still active.");
  } else {
    checks.push({ id: "legacy-storage", status: "pass", message: "No legacy Atlas storage detected." });
  }

  const configText = await readTextIfExists(paths.configPath);
  if (!configText) {
    checks.push({ id: "config-present", status: "fail", message: ".lmti/config.json is missing." });
    recommendations.add("Run `lmti init` to create canonical local config.");
  } else {
    checks.push({ id: "config-present", status: "pass", message: ".lmti/config.json exists." });
    const configScan = runEgressSecretScan(configText);
    checks.push({
      id: "config-secret-scan",
      status: configScan.blocked ? "fail" : "pass",
      message: configScan.blocked ? `Config contains secret-like material: ${configScan.findings.join(", ")}.` : "Config contains no detected secret-like material."
    });
    if (configScan.blocked) {
      recommendations.add("Remove secrets from .lmti/config.json; use secure storage before adding adapter credentials.");
    }

    try {
      const config = JSON.parse(configText) as Partial<LmtiConfig>;
      const privacy = config.privacy;
      const permissive = Boolean(privacy?.allowSecretExport) || Boolean(privacy?.allowExternalModelRawMemory);
      checks.push({
        id: "privacy-config",
        status: permissive ? "fail" : "pass",
        message: permissive ? "Privacy config allows secret export or external raw memory." : "Privacy config keeps secret export and external raw memory disabled."
      });
      if (permissive) {
        recommendations.add("Set privacy.allowSecretExport=false and privacy.allowExternalModelRawMemory=false.");
      }
    } catch {
      checks.push({ id: "config-json", status: "fail", message: ".lmti/config.json is not valid JSON." });
      recommendations.add("Repair .lmti/config.json before using adapters or context commands.");
    }
  }

  try {
    const audit = await verifyAuditIntegrity(cwd);
    checks.push({
      id: "audit-integrity",
      status: audit.valid ? "pass" : "fail",
      message: audit.valid ? `Audit hash chain valid (${audit.checked} events checked).` : `Audit integrity failed (${audit.failures.length} failure(s)).`
    });
    if (!audit.valid) {
      recommendations.add("Inspect .lmti/privacy/audit.jsonl locally and investigate possible tampering.");
    }
  } catch {
    checks.push({ id: "audit-integrity", status: "warn", message: "Audit integrity could not be verified yet." });
    recommendations.add("Run `lmti privacy audit --verify` after privacy storage is initialized.");
  }

  try {
    const memory = await checkMemoryPrivacy({ cwd });
    checks.push({
      id: "memory-privacy",
      status: memory.length > 0 ? "warn" : "pass",
      message: memory.length > 0 ? `${memory.length} memory privacy finding(s) require review.` : "Memory privacy check has no findings."
    });
    if (memory.length > 0) {
      recommendations.add("Review `lmti privacy check` findings and mark secret-like memory as secret/do_not_prompt.");
    }
  } catch {
    checks.push({ id: "memory-privacy", status: "warn", message: "Memory privacy check could not run." });
  }

  try {
    const lessonReview = await getLessonCandidateReviewSummary({ cwd });
    const needsAttention = lessonReview.pending + lessonReview.needsReview + lessonReview.privacyWarnings + lessonReview.missingEvidence;
    checks.push({
      id: "lesson-candidates",
      status: needsAttention > 0 ? "warn" : "pass",
      message:
        needsAttention > 0
          ? `${lessonReview.pending} pending, ${lessonReview.needsReview} needs-review, ${lessonReview.privacyWarnings} privacy warning lesson candidate(s) require approval workflow.`
          : "No lesson candidates require approval review."
    });
    if (needsAttention > 0) {
      recommendations.add("Run `lmti memory lesson candidates` and approve only evidence-backed, privacy-safe lessons.");
    }
  } catch {
    checks.push({ id: "lesson-candidates", status: "warn", message: "Lesson candidate review check could not run." });
  }

  const failed = checks.some((check) => check.status === "fail");
  const warned = checks.some((check) => check.status === "warn");
  return {
    status: failed ? "fail" : warned ? "warn" : "pass",
    checks,
    recommendations: Array.from(recommendations)
  };
}

function doctorStatusToCliStatus(status: DoctorReport["status"]): CliStatus {
  if (status === "ok") {
    return "pass";
  }
  if (status === "warning") {
    return "warn";
  }
  return "blocked";
}

function doctorProblemMessages(report: DoctorReport, severity: DoctorSeverity): CliBoundaryMessage[] {
  return report.problems
    .filter((problem) => problem.severity === severity)
    .map((problem) => ({
      code: problem.id.toUpperCase().replace(/[^A-Z0-9]+/gu, "_"),
      message: problem.message,
      suggestion: problem.recommendedFix
    }));
}

function securityDoctorMessages(report: SecurityDoctorReport, status: SecurityDoctorCheck["status"]): CliBoundaryMessage[] {
  return report.checks
    .filter((check) => check.status === status)
    .map((check) => ({
      code: check.id.toUpperCase().replace(/[^A-Z0-9]+/gu, "_"),
      message: check.message
    }));
}
