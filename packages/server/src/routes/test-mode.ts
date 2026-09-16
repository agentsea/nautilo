/**
 * Test-mode routes — gated on NAUTILO_TEST_MODE=1.
 *
 * Exposes a deterministic scanner-exercise endpoint for the security
 * smoke runner (@nautilo/smoke-runner → bin/nautilo-smoke). The runner
 * calls this endpoint with known inputs and asserts on the response,
 * bypassing the LLM entirely so pass/fail is reproducible.
 *
 * WHY THIS EXISTS (not part of the normal app):
 *   - NOT available in production. `NAUTILO_TEST_MODE=1` must be set
 *     in the environment at server start.
 *   - Bearer-token-gated via NAUTILO_TEST_TOKEN. Returns 404 (not 401)
 *     when disabled, so the route is invisible to probes.
 *   - Scanner-scope only: calls scanCommand / checkPathAccess /
 *     scanToolResult directly. Does NOT invoke tools or enter the
 *     LangGraph pipeline. That keeps the surface tight and side-effect
 *     free.
 *
 * D063 Phase 2 task 2.6.2.
 */

import { randomBytes } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import type { FastifyInstance } from "fastify";
import {
  scanCommand,
  checkPathAccess,
  scanToolResult,
  type SecurityLevel,
} from "@nautilo/security";
import {
  registerToolInvokeRoute,
  type RelayRegistryLike,
} from "./test-mode-tool-invoke";

export interface TestModeRouteDeps {
  /** If false, test routes are not registered at all. */
  enabled: boolean;
  /** Bearer token required on every request. Generated at server boot. */
  token: string;
  /**
   * Optional relay registry. When supplied, `/api/test/tool-invoke`
   * dispatches relay-executor tools (`run_shell`) through a
   * connected in-VM relay using the production envelope protocol.
   * When absent (default), relay-routed tools return a clear
   * "no relay wired" error. D060 Sprint 2 G2 — SANDBOX-LINUX-*
   * harness. Narrow interface (RelayRegistryLike) so tests can
   * mock without casting.
   */
  relayRegistry?: RelayRegistryLike | null;
  /** Paired synthetic identity for the isolated DB-less smoke composition. */
  defaultRelayUserId?: string;
}

/**
 * Upper bound on `input` field length. Scanner patterns operate on
 * normalized strings; past 10k characters the regex work becomes a
 * practical DoS surface even on localhost. Nothing legitimate sends
 * a 10k-char shell command to the scanner. 10k is ~10× the largest
 * realistic invocation we've seen in DANGEROUS_PATTERNS live-fire.
 *
 * D063 PR-001 follow-up M-1 — see the D063 task README's followups file.
 */
const MAX_INPUT_LEN = 10_000;

type SecurityScanBody = {
  layer?: string;
  level?: string;
  input?: string;
  source?: string;
  resultScanPolicy?: string;
};

type SecurityScanResponse = {
  layer: "command" | "path" | "content";
  level: SecurityLevel;
  blocked: boolean;
  reason?: string;
  matchedPatterns?: Array<{ key: string; severity: string; description: string }>;
  contentReplaced?: boolean;
  matchedThreats?: string[];
};

const VALID_LAYERS = new Set(["command", "path", "content"]);
const VALID_LEVELS: ReadonlySet<SecurityLevel> = new Set([
  "yolo",
  "permissive",
  "standard",
  "cautious",
  "paranoid",
]);
const VALID_RESULT_SCAN_POLICIES = new Set(["never", "always", "on-suspicious"]);

export function testModeRoutes(app: FastifyInstance, deps: TestModeRouteDeps): void {
  if (!deps.enabled) return;

  app.addHook("onRequest", (request, reply, done) => {
    if (!request.url.startsWith("/api/test/")) {
      done();
      return;
    }
    const auth = request.headers.authorization;
    const token = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
    if (token !== deps.token) {
      void reply.code(404).send({ error: "Not found" });
      return;
    }
    done();
  });

  /**
   * POST /api/test/security-scan
   *
   * Body:
   *   { layer: "command" | "path" | "content",
   *     level: SecurityLevel,
   *     input: string,
   *     source?: string,              // for content
   *     resultScanPolicy?: ResultScanPolicy   // for content
   *   }
   *
   * Returns SecurityScanResponse.
   */
  app.post<{ Body: SecurityScanBody }>(
    "/api/test/security-scan",
    async (request, reply) => {
      const { layer, level, input, source, resultScanPolicy } = request.body ?? {};

      if (!layer || !VALID_LAYERS.has(layer)) {
        return reply.code(400).send({
          error: "invalid layer",
          message: `layer must be one of: ${Array.from(VALID_LAYERS).join(", ")}`,
        });
      }
      if (!level || !VALID_LEVELS.has(level as SecurityLevel)) {
        return reply.code(400).send({
          error: "invalid level",
          message: `level must be one of: ${Array.from(VALID_LEVELS).join(", ")}`,
        });
      }
      if (typeof input !== "string") {
        return reply.code(400).send({
          error: "invalid input",
          message: "input must be a string",
        });
      }
      if (input.length > MAX_INPUT_LEN) {
        // D063 PR-001 M-1: reject early before the scanner runs. No
        // legitimate caller sends a 10k+ char command to this endpoint.
        return reply.code(400).send({
          error: "input too long",
          message: `input must be at most ${MAX_INPUT_LEN} characters (received ${input.length})`,
        });
      }

      const secLevel = level as SecurityLevel;
      let response: SecurityScanResponse;

      if (layer === "command") {
        const r = scanCommand(input, secLevel);
        response = {
          layer: "command",
          level: secLevel,
          blocked: !r.allowed,
          ...(r.allowed
            ? {}
            : {
                reason: `command blocked (${r.severity}): ${r.matchedPatterns.map((p) => p.description).join("; ")}`,
                matchedPatterns: r.matchedPatterns.map((p) => ({
                  key: p.key,
                  severity: p.severity,
                  description: p.description,
                })),
              }),
        };
      } else if (layer === "path") {
        const r = checkPathAccess(input, secLevel);
        response = {
          layer: "path",
          level: secLevel,
          blocked: !r.allowed,
          ...(r.allowed
            ? {}
            : { reason: r.reason ?? "protected path" }),
        };
      } else {
        // content
        const policy =
          resultScanPolicy && VALID_RESULT_SCAN_POLICIES.has(resultScanPolicy)
            ? (resultScanPolicy as "never" | "always" | "on-suspicious")
            : "always";
        const r = scanToolResult(source ?? "test_tool", input, {
          scanPolicy: policy,
          securityLevel: secLevel,
        });
        response = {
          layer: "content",
          level: secLevel,
          blocked: r.blocked,
          ...(r.blocked
            ? {
                reason: `content blocked: ${r.threats.join(", ")}`,
                contentReplaced: true,
                matchedThreats: r.threats,
              }
            : {}),
        };
      }

      return reply.send(response);
    },
  );

  // POST /api/test/tool-invoke — drives the full tool pipeline
  // (validateBeforeExecution → zone resolver → realpath containment
  // → handler) for tests whose failure mode is the WIRING between
  // layers, not the scanner primitive itself. See
  // `./test-mode-tool-invoke.ts` for the full handler + rationale.
  // D063 Phase 6 task 6.1.
  registerToolInvokeRoute(app, {
    relayRegistry: deps.relayRegistry ?? null,
    ...(deps.defaultRelayUserId === undefined ? {} : { defaultRelayUserId: deps.defaultRelayUserId }),
  });

  /**
   * GET /api/test/ping
   *
   * Liveness probe for the runner to confirm the server is up and
   * test-mode is enabled (otherwise 404). Authenticated.
   */
  app.get("/api/test/ping", async (_request, reply) =>
    reply.send({
      ok: true,
      testMode: true,
      timestamp: new Date().toISOString(),
    }),
  );
}

/**
 * Generate or load the test-mode bearer token. Called once at server
 * start. Precedence:
 *   1. NAUTILO_TEST_TOKEN env var (if set)
 *   2. ~/.nautilo/smoke-token file (created if missing)
 *   3. Random 32-byte hex, written to the file
 */
export async function resolveTestToken(): Promise<string | null> {
  if (process.env["NAUTILO_TEST_MODE"] !== "1") return null;

  const envToken = process.env["NAUTILO_TEST_TOKEN"];
  if (envToken && envToken.length >= 16) return envToken;

  const dir = path.join(homedir(), ".nautilo");
  const tokenFile = path.join(dir, "smoke-token");

  try {
    const existing = (await readFile(tokenFile, "utf8")).trim();
    if (existing.length >= 16) return existing;
  } catch {
    // not present yet
  }

  await mkdir(dir, { recursive: true });
  const token = randomBytes(32).toString("hex");
  await writeFile(tokenFile, token + "\n", { mode: 0o600 });
  return token;
}
