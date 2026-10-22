import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const unavailable = () => new Error("AUDIT_ACCESS_PRESERVATION_FAILED");

/** Locations are relative to our loaded module, never the project cwd, PATH or an
 * executable override. In an owner ESM bundle import.meta.url is the bundle URL. */
export function auditHelperLocation(moduleUrl: string): { root: string; parts: string[] } {
  const directory = path.dirname(fileURLToPath(moduleUrl));
  const parent = path.dirname(directory), grandparent = path.dirname(parent);
  if (["src", "dist"].includes(path.basename(directory)) &&
      path.basename(parent) === "privacy" && path.basename(grandparent) === "packages") {
    return { root: path.dirname(grandparent), parts: ["build", "audit-acl", "bin", "lmti-audit-acl.exe"] };
  }
  if (["knowledge-owner", "mapping-owner"].includes(path.basename(directory)) &&
      path.basename(parent) === "lmti" && path.basename(grandparent) === "share") {
    return { root: path.dirname(grandparent), parts: ["bin", "lmti-audit-acl.exe"] };
  }
  throw unavailable();
}

export async function resolveAuditAclHelper(): Promise<string> {
  try {
    const location = auditHelperLocation(import.meta.url);
    let filename = await fs.realpath(location.root);
    for (const [index, component] of location.parts.entries()) {
      filename = path.join(filename, component);
      const info = await fs.lstat(filename, { bigint: true });
      const last = index === location.parts.length - 1;
      if (info.isSymbolicLink() || (last ? !info.isFile() || info.nlink !== 1n : !info.isDirectory()) ||
          path.relative(filename, await fs.realpath(filename)) !== "") throw unavailable();
    }
    return filename;
  } catch { throw unavailable(); }
}
