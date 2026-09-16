/**
 * `execute_artifact` — D073 + D060 Sprint 2 G5.
 *
 * Runs an agent-written script (artifact in `home/` or `scratch/`)
 * inside the Sprint 1 sandbox, scoped to the zone root. Closes the
 * "writable but not executable" gap from D049 — the Agent can write
 * `analyze.py` to `home/research/` AND actually run it, contained.
 *
 * Architecture — server-local, NOT a relay tool.
 *   - D073 issue: "execute_artifact is server-local and targets the
 *     artifact zones (home/, scratch/) only." The relay doesn\u0027t
 *     own those zones; the server does.
 *   - The server has direct access to `StorageZones` via the Sprint 1
 *     `getArtifactZone()` registry.
 *   - The handler builds a server-local `Sandbox` from
 *     `resolveServerPosture()` + the zone\u0027s rootPath as workspace,
 *     then calls `spawnSandboxed()` directly. Same sandbox library
 *     the relay uses, just invoked in-process.
 *
 * Sandbox shape:
 *   - `workspace` = zone root (`~/.nautilo/home` or `~/.nautilo/scratch`).
 *     The script can read/write within its zone; bubblewrap and
 *     sandbox-exec enforce the boundary.
 *   - `readOnlyPaths` = empty by default. An execute_artifact call
 *     should NOT be able to read arbitrary user files — that\u0027s
 *     what the desktop-permissive posture is for when the user is
 *     driving a tool call with full UI context. Agent-driven script
 *     execution is the tightest possible surface.
 *   - `failIfNoBackend` is driven by posture: paranoid → fail loud
 *     on missing bwrap/sandbox-exec, otherwise warn + passthrough.
 *
 * Runtime allowlist is in `./runtimes.ts`. Not every interpreter is
 * safe to put in a sandbox with zero review; the list is additive
 * with deliberation.
 */

import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { appendFileSync, mkdirSync, statSync } from "node:fs";

import {
  fromRuntimeConfig,
  resolveNautiloRuntimePaths,
  resolveServerPosture,
  type NetworkPolicy as ConfigNetworkPolicy,
} from "@nautilo/config";
import { warn } from "@nautilo/logger";
import {
  Sandbox,
  spawnSandboxed,
  type NetworkPolicy as SandboxNetworkPolicy,
  type SandboxConfig,
} from "@nautilo/sandbox";

import { getArtifactZone } from "../artifacts/storage-registry";
import { detectRuntime, listSupportedExtensions } from "./runtimes";

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 300_000;

const ExecuteZoneEnum = z.enum(["home", "scratch"]);

const ExecuteArtifactSchema = z.object({
  path: z
    .string()
    .min(1, "path required")
    .describe(
      'Script file RELATIVE to the zone root. Must have a supported extension. Examples: "research/analyze.py", "scripts/run.ts".',
    ),
  zone: ExecuteZoneEnum.optional()
    .default("home")
    .describe('"home" for user-visible artifacts (default); "scratch" for ephemeral tool output.'),
  args: z
    .array(z.string())
    .optional()
    .default([])
    .describe(
      "Arguments passed to the script AFTER the argv separator. Each interpreter has a separator (e.g. `--` for Python) that prevents flag injection; user args land as positional params only.",
    ),
  stdin: z
    .string()
    .optional()
    .describe(
      "Optional UTF-8 string piped to the script\\u0027s stdin. Useful for data-in-data-out scripts that read from stdin rather than argv.",
    ),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(MAX_TIMEOUT_MS)
    .optional()
    .default(DEFAULT_TIMEOUT_MS)
    .describe(
      `Kill the script after this many milliseconds. Default ${DEFAULT_TIMEOUT_MS}ms; max ${MAX_TIMEOUT_MS}ms (5 minutes).`,
    ),
});

/**
 * Path used for the per-execution audit log. Separate from the
 * security audit log (which is event-stream shaped) — this is a
 * per-script-run ledger.
 */
function auditLogPath(): string {
  return join(homedir(), ".nautilo", "data", "artifact-executions.jsonl");
}

/**
 * Resolve the directory the sandbox should mount as toolsBin. Same
 * heuristic as the Electron relay (see relay.ts::resolveToolsBin)
 * but without the env-var override — on the server side, operators
 * don\u0027t have a reason to relocate interpreter binaries.
 */
function resolveToolsBin(): string {
  const candidates = [
    "/opt/homebrew/bin", // Apple Silicon brew
    "/usr/local/bin",    // Intel brew / Linux standard
    join(homedir(), ".bun", "bin"),
  ];
  for (const candidate of candidates) {
    try {
      const stat = statSync(candidate);
      if (stat.isDirectory()) return candidate;
    } catch {
      // missing — try next
    }
  }
  // Fall back — the sandbox binds /usr/bin + /bin already via the
  // base profile, so this just adds an extra (maybe empty) mount.
  return "/usr/local/bin";
}

/**
 * Append a JSONL audit row for every execute_artifact invocation.
 * Ship plan §5.8 mentions artifact-executions.jsonl as the canonical
 * location. Append-only; rotated by the same OS tooling as the
 * security audit log (logrotate / newsyslog).
 */
function writeAuditRow(row: {
  ts: string;
  zone: string;
  path: string;
  runtime: string;
  exitCode: number | null;
  timedOut: boolean;
  stdoutBytes: number;
  stderrBytes: number;
}): void {
  const p = auditLogPath();
  try {
    mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
    appendFileSync(p, `${JSON.stringify(row)}\n`, { mode: 0o600 });
  } catch (err) {
    // Audit-log failure is serious but not worth aborting the tool
    // response — we log it and the primary security-audit JSONL
    // already captured the approval decision that got us here.
    warn(`[execute_artifact] audit row write failed: ${String(err)}`);
  }
}

function toSandboxNetworkPolicy(
  policy: ConfigNetworkPolicy,
): SandboxNetworkPolicy {
  if (policy.mode === "host" || policy.mode === "isolated") {
    return { mode: policy.mode };
  }
  return {
    mode: "proxy-allowlist",
    allow: policy.allow.map((rule) => {
      if (rule.type === "domain") {
        return {
          type: "domain",
          host: rule.host,
          ...(rule.ports !== undefined ? { ports: rule.ports } : {}),
        };
      }
      if (rule.type === "wildcard") {
        return {
          type: "wildcard",
          suffix: rule.suffix,
          ...(rule.ports !== undefined ? { ports: rule.ports } : {}),
        };
      }
      return {
        type: "cidr",
        cidr: rule.cidr,
        ...(rule.ports !== undefined ? { ports: rule.ports } : {}),
      };
    }),
    ...(policy.defaultPort !== undefined ? { defaultPort: policy.defaultPort } : {}),
  };
}

export function createExecuteArtifactTool() {
  return new DynamicStructuredTool({
    name: "execute_artifact",
    description: `Run a script artifact (from "home" or "scratch" zone) inside the OS-level sandbox and return its combined stdout/stderr.

USE WHEN you\\u0027ve written a script via \`file.write\` and need to actually run it — e.g. analyze a dataset, invoke a small tool, spin a one-off job. The script is filesystem-contained to its zone root: it can read/write within the zone, cannot reach outside the zone filesystem, and cannot persist state beyond the zone. Network access is not a sandbox guarantee in D060 Sprint 2; do not use this for scripts that must be network-isolated.

SUPPORTED INTERPRETERS: ${listSupportedExtensions()} — extension must match. Compiled binaries are rejected; compile your code first or rewrite as a script language.

APPROVAL: requires prove_it (PIN). First invocation per session prompts; subsequent invocations within the session are allowed.

OUTPUT: stdout + stderr are clearly labelled. The shared sandbox returns each stream in full when it fits its configured inline budget; otherwise it returns a head-and-tail projection with a truncation marker. Exit code reported. Timeout default ${DEFAULT_TIMEOUT_MS}ms, max ${MAX_TIMEOUT_MS}ms.`,
    schema: ExecuteArtifactSchema,
    func: async ({ path, zone, args, stdin, timeoutMs }) => {
      // --- 1. Zone provider + existence check ------------------------
      const provider = getArtifactZone(zone);
      if (!provider) {
        return `Error: artifact storage for zone "${zone}" is not initialised. This is a server wiring bug — report it.`;
      }
      const stat = await provider.stat(path);
      if (!stat) {
        return `Error: artifact not found at zone=${zone} path=${path}. Use file.list to see what exists.`;
      }
      if (stat.isDirectory) {
        return `Error: artifact at zone=${zone} path=${path} is a directory, not a file. execute_artifact only runs files.`;
      }

      // --- 2. Runtime detection --------------------------------------
      const runtime = detectRuntime(path);
      if (!runtime) {
        return `Error: extension not in the runtime allowlist. Supported: ${listSupportedExtensions()}. Rename your artifact or use a supported language.`;
      }

      // --- 3. Sandbox construction ----------------------------------
      // Workspace = zone root (public on StorageProvider). The sandbox
      // bounds the script to read/write within its own zone; any
      // attempt to escape (../, absolute paths outside, symlinks) is
      // rejected at the kernel layer.
      //
      // dataDir is the path the sandbox MASKS (tmpfs/deny-subpath) —
      // resolved from the live runtime-paths so the server masks the
      // correct data directory, not a hardcoded default that may not
      // exist. On a stock install the resolved path equals `~/.nautilo/data`.
      const workspace = provider.rootPath;
      const posture = resolveServerPosture();
      const runtimePaths = resolveNautiloRuntimePaths({
        config: fromRuntimeConfig(),
        env: process.env,
        userHomeDir: homedir(),
      });
      const dataDir = runtimePaths.dataDir;
      const toolsBin = resolveToolsBin();
      const config: SandboxConfig = {
        mode: "enabled",
        writablePaths: [],
        projectPaths: [],
        passthroughEnv: [],
        ...(posture.networkPolicy !== undefined
          ? { networkPolicy: toSandboxNetworkPolicy(posture.networkPolicy) }
          : {}),
        // readOnlyPaths DELIBERATELY omitted — agent-driven scripts
        // don\u0027t need broad RO. If a legitimate use case surfaces
        // (e.g. "read from ~/Documents") it should be a separate tool
        // with user-driven UI approval, not a quietly-added knob here.
      };

      let sandbox: Sandbox;
      try {
        sandbox = await Sandbox.create({
          workspace,
          dataDir,
          toolsBin,
          config,
          // Paranoid posture → refuse to execute without a kernel
          // sandbox. Any other level degrades to WARN + passthrough
          // if bwrap/sandbox-exec is missing (same behavior as
          // desktopPermissive).
          failIfNoBackend: posture.securityLevel === "paranoid",
        });
      } catch (err) {
        return `Error: sandbox unavailable — ${err instanceof Error ? err.message : String(err)}. Either install bubblewrap (Linux) / sandbox-exec (macOS), or lower security_level via the Settings UI (requires manage_server_security Capability).`;
      }

      // --- 4. Build argv ---------------------------------------------
      // Form: <program> <preScriptArgs...> <./scriptPath> <separator> <userArgs...>
      //
      // SAFE-PATH CONTRACT: the script path is always prefixed with
      // `./` before passing to the interpreter. This blocks a
      // critical argv-injection: a filename like `-c.sh` (created
      // out-of-band directly on the filesystem) would otherwise be
      // parsed by `/bin/sh` / `/bin/bash` / `python3` / `node` / etc.
      // as an OPTION FLAG rather than a filename. `/bin/sh -c.sh
      // <args>` interprets the leading `-c` as "-c <command>" — user
      // `args` become executable commands. `./-c.sh` is unambiguous:
      // any POSIX tool treats it as a filename.
      //
      // The argv SEPARATOR (`--` for most, `--args` for Rscript,
      // empty for sh/bash) blocks a separate flag-injection via
      // `args`. Both guards compose: leading-dash filename fails at
      // the script-path level, user-arg flag-like content fails at
      // the separator level.
      //
      // `path` comes from provider.stat which rejected absolute
      // paths and parent-escapes — always relative, always in-zone.
      const safeScriptRef = path.startsWith("./") ? path : `./${path}`;
      const argv: string[] = [
        ...runtime.preScriptArgs,
        safeScriptRef,
        ...runtime.argvSeparator,
        ...args,
      ];

      // --- 5. Spawn + capture ----------------------------------------
      const ts = new Date().toISOString();
      let result;
      try {
        result = await spawnSandboxed(sandbox, runtime.program, argv, {
          cwd: workspace,
          // The shared sandbox applies its configured inline budget (default
          // 16 KiB; env NAUTILO_SANDBOX_INLINE_OUTPUT_BYTES) per stream. When
          // it overflows, it returns a head-and-tail projection plus a
          // truncation marker; no full-output spool exists on this path.
          timeoutMs,
          ...(stdin !== undefined ? { stdin } : {}),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        writeAuditRow({
          ts,
          zone,
          path,
          runtime: runtime.program,
          exitCode: null,
          timedOut: false,
          stdoutBytes: 0,
          stderrBytes: 0,
        });
        return `Error: spawn failed — ${msg}`;
      } finally {
        await sandbox.close();
      }

      // --- 6. Format output ------------------------------------------
      const stdoutBytes = Buffer.byteLength(result.stdout, "utf8");
      const stderrBytes = Buffer.byteLength(result.stderr, "utf8");

      writeAuditRow({
        ts,
        zone,
        path,
        runtime: runtime.program,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        stdoutBytes,
        stderrBytes,
      });

      // D275-D4 — large output is bounded to head+tail with an inline
      // "re-run with head/tail/sed" marker already embedded in result.stdout
      // (no disk spill). Nothing extra to append here.
      if (result.timedOut) {
        return [
          `Error: execution timed out after ${timeoutMs}ms.`,
          result.stdout.length > 0 ? `\n--- stdout (partial) ---\n${result.stdout}` : "",
          result.stderr.length > 0 ? `\n--- stderr (partial) ---\n${result.stderr}` : "",
        ].join("");
      }

      // Non-zero exit is NOT an "Error:" string — the script ran; the
      // model needs to see the output to decide what to do. We still
      // label the exit code in the footer so the model can react.
      const sections: string[] = [];
      if (result.stdout.length > 0) sections.push(`--- stdout ---\n${result.stdout}`);
      if (result.stderr.length > 0) sections.push(`--- stderr ---\n${result.stderr}`);
      const exitLabel =
        result.exitCode === 0
          ? "\n--- exit 0 (ok) ---"
          : result.exitCode !== null
          ? `\n--- exit ${result.exitCode} (non-zero) ---`
          : `\n--- killed by signal ${result.signal ?? "unknown"} ---`;
      if (sections.length === 0) sections.push("(no output)");
      return sections.join("\n") + exitLabel;
    },
  });
}
