import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createNodeSecurityScannerRuntimeHost, PRODUCTION_SECURITY_SCANNER_MANIFEST, SecurityScannerRuntimeManager } from "../../../apps/desktop/electron/security-scanner-runtime";
import { runSecurityProbeSuite } from "../../../apps/desktop/electron/security-scan/probes";

// A fresh managed cache, then the same cache: no installed Desktop or user cache mutation.
const target = resolve(process.argv[2] ?? "dev/evals/security-research/fixture");
const root = await mkdtemp(join(tmpdir(), "nautilo-d577-startup-"));
try {
  await mkdir(join(root, "scratch"), { mode: 0o700 });
  const manager = new SecurityScannerRuntimeManager(createNodeSecurityScannerRuntimeHost(join(root, "managed")), PRODUCTION_SECURITY_SCANNER_MANIFEST);
  for (const mode of ["cold", "warm"]) {
    const start = performance.now();
    const events: object[] = [];
    const resolver = (component: string, kind: "engine" | "rules") => async (signal?: AbortSignal) => {
      const began = performance.now();
      const installed = await manager.install(component, kind, signal ? { signal } : {});
      events.push({ component, state: installed.details.state, atMs: performance.now() - start, durationMs: performance.now() - began });
      return { state: installed.details.state, internalPath: installed.internalPath };
    };
    const result = await runSecurityProbeSuite(target, {
      scratchRoot: join(root, "scratch"), cacheRoot: join(root, "cache"),
      resolveGitleaks: resolver("gitleaks", "engine"), resolveOsvScanner: resolver("osv-scanner", "engine"),
      resolveTrivy: resolver("trivy", "engine"), resolveSemgrep: resolver("semgrep", "engine"),
      resolveSemgrepRules: resolver("semgrep-nautilo-rules", "rules"),
    }, undefined, (progress) => events.push({ ...progress, atMs: performance.now() - start }));
    console.log(JSON.stringify({ mode, durationMs: performance.now() - start, events, lanes: result.lanes, observations: result.observations.length, note: "Managed acquisition and real scanner execution only; excludes model and UI transport latency." }));
  }
} finally { await rm(root, { recursive: true, force: true }); }
