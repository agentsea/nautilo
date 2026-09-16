import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { backupManifestV2Schema } from "./backup-manifest.ts";
import type { BundleVerificationReport } from "./verify-bundle.ts";
import type { RelocationFile } from "./artifact-relocation.ts";

export interface RelocationSourceProof {
  bundlePath: string;
  manifestSha256: string;
  archiveSha256: string;
  files: RelocationFile[];
}
async function digestFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Uint8Array);
  return hash.digest("hex");
}
async function tar(args: string[], hashOnly = false): Promise<{ text: string; size: number; sha256: string }> {
  const child = spawn("tar", args, { stdio: ["ignore", "pipe", "pipe"] });
  child.stderr.resume();
  const closed = new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", code => resolve(code ?? 1));
  });
  const read = async () => {
    const hash = createHash("sha256"); let size = 0; const text: Uint8Array[] = [];
    for await (const data of child.stdout) {
      const chunk = data as Uint8Array;
      hash.update(chunk); size += chunk.byteLength; if (!hashOnly) text.push(chunk);
    }
    return { text: hashOnly ? "" : Buffer.concat(text).toString("utf8"), size, sha256: hash.digest("hex") };
  };
  try {
    const [result, code] = await Promise.all([read(), closed]);
    if (code !== 0) throw new Error("Archive reader failed");
    return result;
  } catch {
    throw new Error("Artifact relocation backup archive read failed; private diagnostics withheld");
  }
}

/** Canonical bundle verifier admits custody; tar only reads exact regular members. */
export async function readArtifactRelocationBackup(input: {
  bundlePath: string; report: BundleVerificationReport; instanceId: string; project: string;
  root: string; paths: string[];
}): Promise<RelocationSourceProof> {
  const { report } = input;
  if (!report.ok || !report.provenance || report.instanceId !== input.instanceId || report.composeProjectName !== input.project) throw new Error("Artifact relocation requires a verified v2 backup of this exact instance");
  const bundlePath = resolve(input.bundlePath);
  const manifestBytes = await readFile(join(bundlePath, "manifest.json"));
  if (createHash("sha256").update(manifestBytes).digest("hex") !== report.provenance.manifestSha256) throw new Error("Artifact relocation backup manifest changed after verification");
  const manifest = backupManifestV2Schema.parse(JSON.parse(manifestBytes.toString("utf8")));
  if (!manifest.contents.artifacts || !manifest.integrity.artifacts) throw new Error("Artifact relocation backup has no verified artifact archive");
  const archive = join(bundlePath, "artifacts.tgz");
  const expectedHash = manifest.integrity.artifacts.sha256;
  if (await digestFile(archive) !== expectedHash) throw new Error("Artifact relocation original archive differs");
  const names = (await tar(["-tzf", archive])).text.trimEnd().split("\n");
  const descriptions = (await tar(["-tvzf", archive])).text.trimEnd().split("\n");
  if (names.length !== descriptions.length) throw new Error("Artifact relocation archive listing is ambiguous");
  const members = new Map<string, { name: string; regular: boolean }>();
  for (let index = 0; index < names.length; index++) {
    const name = names[index]!; const relative = name.replace(/^\.\//, "").replace(/\/$/, "");
    if (relative === "." || relative === "") continue;
    if (relative.startsWith("/") || relative.split("/").some(part => !part || part === "." || part === "..") || /[\0\r\n\\]/.test(relative) || members.has(relative)) throw new Error("Artifact relocation archive contains unsafe or duplicate paths");
    members.set(relative, { name, regular: descriptions[index]!.startsWith("-") && !descriptions[index]!.includes(" link to ") });
  }
  const files: RelocationFile[] = [];
  for (const path of input.paths) {
    if (!path.startsWith(input.root + "/")) throw new Error("Artifact relocation source selection escaped root");
    const relative = path.slice(input.root.length + 1); const member = members.get(relative);
    if (!member?.regular || /[?*[\]]/.test(member.name)) throw new Error("Artifact relocation needs one exact regular original archive member");
    const bytes = await tar(["-xOzf", archive, "--", member.name], true);
    files.push({ path, size: bytes.size, sha256: bytes.sha256 });
  }
  if (await digestFile(archive) !== expectedHash) throw new Error("Artifact relocation original archive changed during verification");
  return { bundlePath, manifestSha256: report.provenance.manifestSha256, archiveSha256: expectedHash, files };
}
