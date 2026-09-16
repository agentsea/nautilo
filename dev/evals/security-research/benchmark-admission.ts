import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DesktopSecurityScanLedger } from "../../../apps/desktop/electron/security-scan/ledger";
import type { SecurityScanObservation } from "@nautilo/types";
const root = await mkdtemp(join(tmpdir(), "nautilo-d577-admission-"));
const identity = { fingerprint: "a".repeat(64), device: "fixture", inode: "fixture" };
const trusted = { taskId: "00000000-0000-4000-8000-000000000001", taskRunId: "00000000-0000-4000-8000-000000000002", modelId: "openai:test", toolCallId: "create" };
const observations: SecurityScanObservation[] = Array.from({ length: 227 }, (_, i) => ({
  id: `observation_benchmark_${i}`, probe: "gitleaks", sourceScope: "current_tree", historyOnlyPath: null,
  ruleId: "fixture", advisoryId: null, packageName: null, relativePath: `src/file-${i}.ts`,
  startLine: 1, endLine: 1, severity: "high", summary: "Synthetic redacted observation", secretRedacted: true,
}));
try {
  const times: Record<string, number> = {};
  for (const mode of ["sequential", "atomic_batch"]) {
    await mkdir(join(root, mode), { mode: 0o700 });
    const ledger = new DesktopSecurityScanLedger({ userDataRoot: join(root, mode), rootIdentityReader: { revalidate: () => Promise.resolve(identity) }, citationReader: { revalidateAndHash: () => Promise.reject(new Error("No code citations are part of the admission benchmark.")) } });
    const access = { scanId: "scan_benchmark", localOwnerId: "fixture-owner", rootIdentity: identity, trusted };
    await ledger.create({ ...access, mode: "deep_research" });
    const start = performance.now();
    if (mode === "sequential") {
      for (const [i, observation] of observations.entries()) await ledger.appendObservation({ ...access, observation, trusted: { ...trusted, toolCallId: `observation-${i}` } });
    } else await ledger.appendObservations({ ...access, observations, trusted: { ...trusted, toolCallId: "suite" } });
    times[mode] = Math.round((performance.now() - start) * 100) / 100;
  }
  console.log(JSON.stringify({ observations: observations.length, milliseconds: times, note: "Ledger admission only; excludes scanners, model latency, and network." }));
} finally { await rm(root, { recursive: true, force: true }); }
