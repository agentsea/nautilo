import type { CommandApprovalRow, SecurityAuditEvent, SecurityPostureResponse } from "@nautilo/api-client";
import type { CommandModule } from "yargs";
import { readSync } from "node:fs";
import { ApiError } from "@nautilo/api-client";
import { createAuthenticatedAdminClient, type AuthenticatedAdminClient } from "../lib/authenticated-admin-client.ts";
import {
  redactServerAdminValue,
  writeServerAdminError,
  writeServerAdminSuccess,
  type ServerAdminFormat,
} from "../lib/server-admin-output.ts";

type BaseArgs = { server?: string; format: ServerAdminFormat };
type PostureArgs = BaseArgs & {
  action?: "show" | "set";
  deploymentMode?: SecurityPostureResponse["deploymentMode"];
  securityLevel?: SecurityPostureResponse["securityLevel"];
  proofFd?: number;
};
type AuditArgs = BaseArgs & { limit: number; all: boolean; cursor?: string; since?: string; actorId?: string; correlationId?: string; kind?: string[] };
type RevokeArgs = BaseArgs & { id: string; yes: boolean };

export interface SecurityCommandDependencies {
  authenticate(input: { serverFlag?: string }): Promise<AuthenticatedAdminClient>;
  readHidden(prompt: string): Promise<string>;
  readPinDescriptor(fd: number): string;
  isStdinTty(): boolean;
  isStderrTty(): boolean;
}

async function readHiddenLine(prompt: string): Promise<string> {
  const { readHiddenLine: read } = await import("../lib/host-provider-prompt.ts");
  return read(prompt);
}

function readBoundedDescriptor(fd: number): string {
  if (!Number.isSafeInteger(fd) || fd < 0) throw new Error("invalid_pin_descriptor");
  const bytes: number[] = [];
  const byte = Buffer.allocUnsafe(1);
  while (bytes.length <= 128) {
    const count = readSync(fd, byte, 0, 1, null);
    if (count === 0 || byte[0] === 10) break;
    bytes.push(byte[0] ?? 0);
  }
  if (bytes.length === 0 || bytes.length > 128 || bytes.includes(0) || bytes.includes(13)) {
    throw new Error("invalid_pin_input");
  }
  return Buffer.from(bytes).toString("utf8");
}

const DEFAULT_DEPENDENCIES: SecurityCommandDependencies = {
  authenticate: (input) => createAuthenticatedAdminClient(input),
  readHidden: readHiddenLine,
  readPinDescriptor: readBoundedDescriptor,
  isStdinTty: () => process.stdin.isTTY === true,
  isStderrTty: () => process.stderr.isTTY === true,
};

function authInput(server: string | undefined): { serverFlag?: string } {
  return server === undefined ? {} : { serverFlag: server };
}

function safe(value: string | null): string {
  return [...(value ?? "-")].map((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || (code >= 127 && code <= 159) ? "�" : character;
  }).join("").slice(0, 200);
}

function stableError(error: unknown): { code: string; message: string } {
  if (error instanceof ApiError && error.status === 403) return { code: "capability_denied", message: "The selected security information is not available to this Human." };
  if (error instanceof ApiError && error.status === 409) return { code: "continuation_stale", message: "Audit state changed during pagination. Restart the query from its first page." };
  if (error instanceof ApiError && error.status === 400) return { code: "invalid_input", message: "The server rejected the requested security input." };
  if (error instanceof ApiError && error.status === 401) return { code: "proof_rejected", message: "The protected confirmation was rejected." };
  if (error instanceof ApiError && error.status === 429) return { code: "proof_locked", message: "Protected confirmation is temporarily locked. Wait before retrying." };
  if (error instanceof ApiError && error.status === 413) return { code: "result_bound_exceeded", message: "The result exceeds the safe buffered-output bound. Use JSONL output." };
  return { code: "security_unavailable", message: "Security administration could not be completed safely." };
}

const MAX_BUFFERED_AUDIT_EVENTS = 10_000;

function writeAuditJsonlEvent(event: SecurityAuditEvent): void {
  process.stdout.write(`${JSON.stringify({
    schema: "nautilo.server-admin.audit-event.v1",
    type: "event",
    event: redactServerAdminValue(event),
  })}\n`);
}

function auditProjection(event: SecurityAuditEvent): SecurityAuditEvent {
  return redactServerAdminValue(event) as SecurityAuditEvent;
}

function writeAuditJsonlEnd(returned: number, hasMore: boolean, nextCursor: string | undefined): void {
  process.stdout.write(`${JSON.stringify({
    schema: "nautilo.server-admin.audit-event.v1",
    type: "end",
    returned,
    complete: !hasMore,
    hasMore,
    nextCursor: nextCursor ?? null,
  })}\n`);
}

function writeAuditJsonlError(code: string, message: string, returned: number): void {
  process.stdout.write(`${JSON.stringify({
    schema: "nautilo.server-admin.audit-event.v1",
    type: "error",
    outcome: returned > 0 ? "partial" : "rejected",
    returned,
    error: { code, message },
  })}\n`);
}

function postureHuman(posture: SecurityPostureResponse): string[] {
  return [
    `deployment: ${safe(posture.deploymentMode)}`,
    `level:      ${safe(posture.securityLevel)}`,
    `network:    ${safe(posture.networkPolicy.mode)}`,
    `backend:    ${safe(posture.backend.kind)}`,
    `actorRole:  ${safe(posture.actorRole)}`,
    `writable:   ${posture.writablePaths.length}`,
    `readOnly:   ${posture.readOnlyPaths.length}`,
  ];
}

function postureIntent(argv: PostureArgs): {
  deploymentMode?: SecurityPostureResponse["deploymentMode"];
  securityLevel?: SecurityPostureResponse["securityLevel"];
} {
  return {
    ...(argv.deploymentMode === undefined ? {} : { deploymentMode: argv.deploymentMode }),
    ...(argv.securityLevel === undefined ? {} : { securityLevel: argv.securityLevel }),
  };
}

function approvalData(row: CommandApprovalRow) {
  return {
    id: row.id,
    scope: row.scope,
    roomId: row.roomId,
    roomLabel: row.roomLabel,
    label: row.label,
    approvalKind: row.approvalKind,
    capabilitySlug: row.capabilitySlug,
    active: row.active,
    createdAt: row.createdAt,
    toolPattern: row.toolPattern,
  };
}

export function createSecurityModule(overrides: Partial<SecurityCommandDependencies> = {}): CommandModule {
  const deps = { ...DEFAULT_DEPENDENCIES, ...overrides };
  return {
    command: "security",
    describe: "Inspect security posture, audit evidence, and standing approvals.",
    builder: (yargs) => yargs
      .command({
        command: "posture [action]",
        describe: "Show or change the selected server's effective security posture.",
        builder: (child) => child
          .positional("action", { type: "string", choices: ["show", "set"] as const, default: "show" })
          .option("deployment-mode", { type: "string", choices: ["server", "desktop-permissive", "desktop-locked"] as const })
          .option("security-level", { type: "string", choices: ["yolo", "permissive", "standard", "cautious", "paranoid"] as const })
          .option("proof-fd", { type: "number", describe: "Read protected confirmation from an already-open descriptor (0 permits explicit stdin)" })
          .option("format", { type: "string", choices: ["human", "json"] as const, default: "human" }),
        handler: async (raw) => {
          const argv = raw as unknown as PostureArgs;
          try {
            const client = await deps.authenticate(authInput(argv.server));
            const current = await client.api.getSecurityPosture();
            if ((argv.action ?? "show") === "show") {
              writeServerAdminSuccess(argv.format, { ...current }, postureHuman(current));
              process.exitCode = 0;
              return;
            }
            if (!client.whoami.capabilities.includes("manage_server_security")) {
              throw new ApiError(403, "forbidden");
            }
            const intent = postureIntent(argv);
            if (intent.deploymentMode === undefined && intent.securityLevel === undefined) {
              writeServerAdminError(argv.format, "posture_intent_required", "Choose a deployment mode or security level to change.");
              process.exitCode = 2;
              return;
            }
            if (argv.proofFd === undefined) {
              if (!deps.isStdinTty() || !deps.isStderrTty()) {
                writeServerAdminError(argv.format, "protected_input_required", "A hidden terminal prompt or explicit --proof-fd is required.");
                process.exitCode = 2;
                return;
              }
              process.stderr.write([
                "Security posture change:",
                `  deployment: ${safe(current.deploymentMode)} -> ${safe(intent.deploymentMode ?? current.deploymentMode)}`,
                `  level:      ${safe(current.securityLevel)} -> ${safe(intent.securityLevel ?? current.securityLevel)}`,
              ].join("\n") + "\n");
            }
            const pin = argv.proofFd === undefined
              ? await deps.readHidden("Admin PIN (input hidden; confirms this change): ")
              : deps.readPinDescriptor(argv.proofFd);
            const applied = await client.api.updateSecurityPosture({ ...intent, pin });
            const verified = await client.api.getSecurityPosture();
            writeServerAdminSuccess(argv.format, {
              previous: { deploymentMode: current.deploymentMode, securityLevel: current.securityLevel },
              current: { deploymentMode: verified.deploymentMode, securityLevel: verified.securityLevel },
              stateChanged: applied.changed,
              auditRecorded: applied.changed ? "server-enforced" : "not-applicable",
            }, [
              `deployment: ${safe(verified.deploymentMode)}`,
              `level:      ${safe(verified.securityLevel)}`,
              `changed:    ${String(applied.changed)}`,
            ]);
            process.exitCode = 0;
          } catch (error) {
            const stable = stableError(error);
            writeServerAdminError(argv.format, stable.code, stable.message);
            process.exitCode = 2;
          }
        },
      })
      .command({
        command: "audit",
        describe: "Read bounded audit pages with deterministic continuation.",
        builder: (child) => child
          .option("limit", { type: "number", default: 50 })
          .option("all", { type: "boolean", default: false })
          .option("cursor", { type: "string" })
          .option("since", { type: "string" })
          .option("actor-id", { type: "string" })
          .option("correlation-id", { type: "string" })
          .option("kind", { type: "array", string: true })
          .option("format", { type: "string", choices: ["human", "json", "jsonl"] as const, default: "human" }),
        handler: async (raw) => {
          const argv = raw as unknown as AuditArgs;
          let emitted = 0;
          try {
            if (!Number.isInteger(argv.limit) || argv.limit < 1 || argv.limit > 500) {
              throw new ApiError(400, "invalid_limit");
            }
            const client = await deps.authenticate(authInput(argv.server));
            if (!client.whoami.capabilities.includes("view_audit_log")) throw new ApiError(403, "forbidden");
            const events: SecurityAuditEvent[] = [];
            let returned = 0;
            let cursor = argv.cursor;
            let hasMore = false;
            do {
              const page = await client.api.getSecurityAuditLog({
                limit: argv.limit,
                ...(argv.since ? { since: argv.since } : {}),
                ...(argv.actorId ? { actorId: argv.actorId } : {}),
                ...(argv.correlationId ? { correlationId: argv.correlationId } : {}),
                ...(argv.kind && argv.kind.length > 0 ? { kinds: argv.kind } : {}),
                ...(cursor ? { cursor } : {}),
              });
              if (argv.format === "jsonl") {
                for (const event of page.events) writeAuditJsonlEvent(event);
              } else {
                events.push(...page.events.map(auditProjection));
                if (events.length > MAX_BUFFERED_AUDIT_EVENTS) {
                  throw new ApiError(413, "audit_result_too_large");
                }
              }
              returned += page.events.length;
              emitted = returned;
              hasMore = page.hasMore;
              cursor = page.nextCursor ?? undefined;
            } while (argv.all && hasMore && cursor);
            if (argv.format === "jsonl") {
              writeAuditJsonlEnd(returned, hasMore, cursor);
              process.exitCode = 0;
              return;
            }
            writeServerAdminSuccess(argv.format, {
              events,
              page: { returned, complete: !hasMore, hasMore, nextCursor: cursor ?? null },
            }, [
              `events:   ${events.length}`,
              `complete: ${String(!hasMore)}`,
              ...events.map((event) => `${safe(event.ts)} ${safe(event.kind)} actor=${safe(event.actorId)}`),
              ...(hasMore ? ["More events remain; use --cursor or --all."] : []),
            ]);
            process.exitCode = 0;
          } catch (error) {
            const stable = stableError(error);
            if (argv.format === "jsonl") writeAuditJsonlError(stable.code, stable.message, emitted);
            else writeServerAdminError(argv.format, stable.code, stable.message);
            process.exitCode = 2;
          }
        },
      })
      .command({
        command: "approvals",
        describe: "List or revoke the signed-in Human's standing approvals.",
        builder: (child) => child
          .command({
            command: "list",
            describe: "List current standing approvals.",
            builder: (list) => list.option("format", { type: "string", choices: ["human", "json"] as const, default: "human" }),
            handler: async (raw) => {
              const argv = raw as unknown as BaseArgs;
              try {
                const client = await deps.authenticate(authInput(argv.server));
                const approvals = await client.api.listStandingApprovals();
                writeServerAdminSuccess(argv.format, { approvals: approvals.map(approvalData) }, [
                  `approvals: ${approvals.length}`,
                  ...approvals.map((approval) => `- ${safe(approval.label)} (${safe(approval.id)}) ${approval.active ? "active" : "inactive"}`),
                ]);
                process.exitCode = 0;
              } catch (error) {
                const stable = stableError(error);
                writeServerAdminError(argv.format, stable.code, stable.message);
                process.exitCode = 2;
              }
            },
          })
          .command({
            command: "revoke <id>",
            describe: "Idempotently revoke one observed standing approval.",
            builder: (revoke) => revoke
              .positional("id", { type: "string", demandOption: true })
              .option("yes", { type: "boolean", default: false })
              .option("format", { type: "string", choices: ["human", "json"] as const, default: "human" }),
            handler: async (raw) => {
              const argv = raw as unknown as RevokeArgs;
              try {
                const client = await deps.authenticate(authInput(argv.server));
                const current = (await client.api.listStandingApprovals()).find((approval) => approval.id === argv.id) ?? null;
                if (!argv.yes) {
                  writeServerAdminSuccess(argv.format, { current: current ? approvalData(current) : null, proposed: "revoked" }, [
                    current ? `Revoke ${safe(current.label)} (${safe(current.id)}). Re-run with --yes.` : "Approval is already absent; no change is needed.",
                  ]);
                  process.exitCode = 0;
                  return;
                }
                await client.api.revokeStandingApproval(argv.id);
                writeServerAdminSuccess(argv.format, { approvalId: argv.id, currentState: "revoked", stateChanged: current !== null }, [
                  `approvalId: ${safe(argv.id)}`,
                  "current:    revoked",
                  `changed:    ${String(current !== null)}`,
                ]);
                process.exitCode = 0;
              } catch (error) {
                const stable = stableError(error);
                writeServerAdminError(argv.format, stable.code, stable.message);
                process.exitCode = 2;
              }
            },
          })
          .demandCommand(1, 1)
          .strict(),
        handler: () => {},
      })
      .demandCommand(1, 1)
      .strict(),
    handler: () => {},
  };
}

export const securityModule = createSecurityModule();
