#!/usr/bin/env bun
/**
 * scan-helper.ts — runs inside the test VM, invoked by the runner via
 * `driver.execShell`. Reads a JSON scan request from stdin, calls the
 * appropriate @nautilo/security function, prints a JSON response to
 * stdout.
 *
 * Protocol (stdin JSON):
 *   { "layer": "command" | "path" | "content",
 *     "level": SecurityLevel,
 *     "input": string,
 *     "source"?: string,              // content only
 *     "resultScanPolicy"?: "never" | "always" | "on-suspicious"  // content only
 *   }
 *
 * Protocol (stdout JSON):
 *   { "layer": ..., "level": ..., "blocked": boolean,
 *     "reason"?: string,
 *     "matchedPatterns"?: [...], "matchedThreats"?: [...] }
 *
 * Deliberately mirrors the surface of /api/test/security-scan so the
 * runner can swap between in-VM exec and HTTP endpoint. This path is
 * preferred for the Runner: it exercises the exact @nautilo/security
 * build that's sitting in the VM's snapshotted disk.
 *
 * D063 Phase 2 task 2.6.
 */

import { scanCommand, checkPathAccess, scanToolResult } from "@nautilo/security";
import type { SecurityLevel } from "@nautilo/security";

type Layer = "command" | "path" | "content";
type ResultScanPolicy = "never" | "always" | "on-suspicious";

interface ScanRequest {
  layer: Layer;
  level: SecurityLevel;
  input: string;
  source?: string;
  resultScanPolicy?: ResultScanPolicy;
}

interface ScanResponse {
  layer: Layer;
  level: SecurityLevel;
  blocked: boolean;
  reason?: string;
  matchedPatterns?: Array<{ key: string; severity: string; description: string }>;
  matchedThreats?: string[];
  contentReplaced?: boolean;
}

async function readAllStdin(): Promise<string> {
  let buf = "";
  for await (const chunk of process.stdin) {
    buf += chunk instanceof Buffer ? chunk.toString("utf8") : String(chunk);
  }
  return buf;
}

function main(req: ScanRequest): ScanResponse {
  const { layer, level, input, source, resultScanPolicy } = req;

  if (layer === "command") {
    const r = scanCommand(input, level);
    if (r.allowed) {
      return { layer, level, blocked: false };
    }
    return {
      layer,
      level,
      blocked: true,
      reason: `command blocked (${r.severity}): ${r.matchedPatterns.map((p) => p.description).join("; ")}`,
      matchedPatterns: r.matchedPatterns.map((p) => ({
        key: p.key,
        severity: p.severity,
        description: p.description,
      })),
    };
  }

  if (layer === "path") {
    const r = checkPathAccess(input, level);
    if (r.allowed) {
      return { layer, level, blocked: false };
    }
    return {
      layer,
      level,
      blocked: true,
      reason: r.reason ?? "protected path",
    };
  }

  // content
  const policy = resultScanPolicy ?? "always";
  const r = scanToolResult(source ?? "test_tool", input, {
    scanPolicy: policy,
    securityLevel: level,
  });
  if (!r.blocked) {
    return { layer, level, blocked: false };
  }
  return {
    layer,
    level,
    blocked: true,
    reason: `content blocked: ${r.threats.join(", ")}`,
    matchedThreats: r.threats,
    contentReplaced: true,
  };
}

const raw = await readAllStdin();
let req: ScanRequest;
try {
  req = JSON.parse(raw) as ScanRequest;
} catch (err) {
  process.stderr.write(`scan-helper: failed to parse stdin JSON: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(2);
}

const response = main(req);
process.stdout.write(JSON.stringify(response));
