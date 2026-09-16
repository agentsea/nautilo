import { execFile } from "node:child_process";
import { constants as fsConstants, promises as fs } from "node:fs";
import { basename, delimiter, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import {
  isReviewedClaudeCodeVersion,
  type ClaudeExecutableResolver,
  type ClaudeRuntimeFeatures,
  type ResolvedClaudeExecutable,
} from "@nautilo/claude-agent-sdk-host";

const execFileAsync = promisify(execFile);
const MAX_VERSION_OUTPUT_BYTES = 4 * 1024;
const VERSION_TIMEOUT_MS = 3_000;

/** This argv is local, fixed, and never supplied by a server or renderer. */
export const CLAUDE_VERSION_ARGS = Object.freeze(["--version"] as const);

/**
 * The exact feature ledger reviewed with Claude Code 2.1.235. Feature names
 * are not inferred from the executable output: the exact version admission
 * selects this frozen review record.
 */
export const REVIEWED_CLAUDE_RUNTIME_FEATURES: ClaudeRuntimeFeatures = Object.freeze({
  accountInfo: true,
  supportedModels: true,
  interrupt: true,
  modelRefusalFallback: true,
  modelRefusalNoFallback: true,
  servingModelIdentity: true,
  switchModelsOnFlag: true,
});

export const UNREVIEWED_CLAUDE_RUNTIME_FEATURES: ClaudeRuntimeFeatures = Object.freeze({
  accountInfo: false,
  supportedModels: false,
  interrupt: false,
  modelRefusalFallback: false,
  modelRefusalNoFallback: false,
  servingModelIdentity: false,
  switchModelsOnFlag: false,
});

/**
 * Only a Human-managed ambient `claude` found in the local PATH is
 * eligible. There is deliberately no configuration, vendor directory, SDK
 * optional-binary, package-resource, or fallback candidate.
 */
export function createAmbientClaudeExecutableResolver(
  input: Readonly<{ path?: string; inspect?: ClaudeExecutableInspector; executableName?: "claude" | "claude.exe" }> = {},
): ClaudeExecutableResolver {
  const inspect = input.inspect ?? defaultInspector;
  const pathEntries = safePathEntries(input.path ?? process.env["PATH"]);
  const executableName = input.executableName ?? (process.platform === "win32" ? "claude.exe" : "claude");
  return {
    async resolve(): Promise<ResolvedClaudeExecutable | null> {
      for (const entry of pathEntries) {
        const candidate = join(entry, executableName);
        const executable = await inspect.canonicalAmbientClaude(candidate);
        if (executable === null) continue;
        const version = parseAmbientClaudeVersionOutput(await inspect.version(executable, CLAUDE_VERSION_ARGS));
        if (version === null) continue;
        const reviewed = isReviewedClaudeCodeVersion(version);
        return {
          path: executable,
          version,
          features: reviewed ? REVIEWED_CLAUDE_RUNTIME_FEATURES : UNREVIEWED_CLAUDE_RUNTIME_FEATURES,
        };
      }
      return null;
    },
  };
}

export interface ClaudeExecutableInspector {
  canonicalAmbientClaude(candidate: string): Promise<string | null>;
  version(executable: string, args: typeof CLAUDE_VERSION_ARGS): Promise<string | null>;
}

const defaultInspector: ClaudeExecutableInspector = {
  async canonicalAmbientClaude(candidate): Promise<string | null> {
    try {
      const executable = await fs.realpath(candidate);
      const stat = await fs.stat(executable);
      await fs.access(executable, fsConstants.X_OK);
      return (basename(candidate) === "claude" || basename(candidate) === "claude.exe") && stat.isFile() ? executable : null;
    } catch {
      return null;
    }
  },
  async version(executable, args): Promise<string | null> {
    try {
      const { stdout, stderr } = await execFileAsync(executable, [...args], {
        shell: false,
        timeout: VERSION_TIMEOUT_MS,
        maxBuffer: MAX_VERSION_OUTPUT_BYTES,
        windowsHide: true,
      });
      const output = `${stdout}${stderr}`;
      return Buffer.byteLength(output, "utf8") <= MAX_VERSION_OUTPUT_BYTES ? output : null;
    } catch {
      return null;
    }
  },
};

export function parseAmbientClaudeVersionOutput(output: string | null): string | null {
  if (output === null || Buffer.byteLength(output, "utf8") > MAX_VERSION_OUTPUT_BYTES) return null;
  const match = /^((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))(?: \(Claude Code\))?\r?\n?$/.exec(output);
  return match?.[1] !== undefined && Buffer.byteLength(match[1], "utf8") <= 320 ? match[1] : null;
}

function safePathEntries(raw: string | undefined): readonly string[] {
  if (typeof raw !== "string" || raw.includes("\0")) return [];
  return raw.split(delimiter)
    .filter((entry) => isAbsolute(entry) && !entry.includes("\0"));
}
