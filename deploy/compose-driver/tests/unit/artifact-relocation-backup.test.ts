import { rejects } from "node:assert/strict";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readArtifactRelocationBackup } from "../../src/artifact-relocation-backup.ts";
import type { BundleVerificationReport } from "../../src/verify-bundle.ts";

const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
// USTAR fixture: ./original contains "original"; ./alias is a symbolic link
// to original. Reading archive metadata does not require host symlink rights.
const archiveFixture = Buffer.from(
  "H4sIAAAAAAACCtPTzy/KTM/MS8xhoBkwAAIzExMwDQTotIGBIRIbLG5uZmTAoGDAQAdQWlySWAS0kmFkAtrH/igYzEBPPzEnM7GYpnYQzP/obEMDM2NjBgUjeiTOEZ7/R8EoGAUjFwAAWwqUywAKAAA=",
  "base64",
);
test("original bundle proof rejects same-size corruption, foreign identity, missing/symlink members and changed archives", async () => {
  const root = await mkdtemp(join(tmpdir(), "relocation-backup-"));
  try {
    const archive = join(root, "artifacts.tgz");
    await writeFile(archive, archiveFixture);
    const archiveBytes = await readFile(archive);
    const manifest = { version: 2, createdAt: "2026-01-01T00:00:00Z", profileName: "fixture", instanceId: "fixture", transport: "local", composeProjectName: "fixture", image: { mode: "registry", repoDigest: "ghcr.io/example/runtime@sha256:" + "a".repeat(64) }, contents: { nautiloDb: true, logtoDb: true, artifacts: true, instanceEnv: true, operatorFiles: false, caddyData: false, caddyConfig: false, localCaCerts: false }, integrity: { artifacts: { sha256: hash(archiveBytes), sizeBytes: archiveBytes.byteLength } } };
    const manifestText = JSON.stringify(manifest); await writeFile(join(root, "manifest.json"), manifestText);
    const report: BundleVerificationReport = { ok: true, manifestVersion: 2, bundlePath: root, createdAt: manifest.createdAt, profileName: "fixture", instanceId: "fixture", composeProjectName: "fixture", transport: "local", image: { mode: "registry" }, checks: [], provenance: { manifestSha256: hash(manifestText), createdAt: manifest.createdAt, verifiedAt: manifest.createdAt, imageMode: "registry", imageReference: manifest.image.repoDigest } };
    const input = { bundlePath: root, report, instanceId: "fixture", project: "fixture", root: "/new/artifacts", paths: ["/new/artifacts/original"] };
    const proof = await readArtifactRelocationBackup(input);
    expect(proof.files).toEqual([{ path: "/new/artifacts/original", size: 8, sha256: hash("original") }]);
    expect(proof.archiveSha256).toBe(hash(archiveBytes));
    // The npm/operator entrypoint runs on Node, while the signed binary embeds Bun.
    // Build only this helper for Node and execute the same real archive fixture.
    const build = await Bun.build({ entrypoints: [join(import.meta.dir, "../../src/artifact-relocation-backup.ts")], target: "node", format: "esm" });
    expect(build.success).toBe(true);
    await writeFile(join(root, "helper.mjs"), await build.outputs[0]!.text());
    await writeFile(join(root, "probe.mjs"), `import {readArtifactRelocationBackup} from './helper.mjs'; console.log(JSON.stringify(await readArtifactRelocationBackup(${JSON.stringify(input)})));`);
    const node = Bun.spawn(["node", join(root, "probe.mjs")], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(node.stdout).text(), new Response(node.stderr).text(), node.exited]);
    expect(code, stderr).toBe(0);
    expect(JSON.parse(stdout)).toEqual(proof);

    await rejects(readArtifactRelocationBackup({ ...input, instanceId: "other" }), /exact instance/);
    await rejects(readArtifactRelocationBackup({ ...input, report: { ...report, ok: false } }), /verified v2 backup/);
    for (const path of ["/new/artifacts/alias", "/new/artifacts/missing", "/outside/original"]) await rejects(readArtifactRelocationBackup({ ...input, paths: [path] }));
    await writeFile(archive, Buffer.alloc(archiveBytes.byteLength, 0));
    await rejects(readArtifactRelocationBackup(input), /archive differs/);
    await writeFile(archive, archiveBytes); await writeFile(join(root, "manifest.json"), manifestText + "\n");
    await rejects(readArtifactRelocationBackup(input), /manifest changed/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
