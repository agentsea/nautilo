import { afterEach, beforeEach, expect, test } from "bun:test";
import type { CommandApprovalRow, SecurityAuditEvent, SecurityPostureResponse } from "@nautilo/api-client";
import yargs from "yargs/yargs";
import { createSecurityModule } from "../../src/commands/security.ts";
import type { AuthenticatedAdminClient } from "../../src/lib/authenticated-admin-client.ts";

let stdout = "";
let original: typeof process.stdout.write;

beforeEach(() => {
  stdout = "";
  original = process.stdout.write;
  process.stdout.write = ((value: string | Uint8Array) => {
    stdout += typeof value === "string" ? value : Buffer.from(value).toString();
    return true;
  }) as typeof process.stdout.write;
});

afterEach(() => {
  process.stdout.write = original;
  process.exitCode = undefined;
});

const posture: SecurityPostureResponse = {
  deploymentMode: "server",
  securityLevel: "paranoid",
  allowUncontainedHostCommands: false,
  networkPolicy: { mode: "isolated" },
  capabilities: ["view_audit_log"],
  actorRole: "admin",
  writablePaths: ["/srv/nautilo"],
  readOnlyPaths: [],
  backend: { kind: "bubblewrap", procSupported: true },
};

const approval: CommandApprovalRow = {
  id: "approval-1",
  scope: "server",
  roomId: null,
  roomLabel: null,
  toolPattern: "web_fetch",
  label: "Approved web access",
  approvalKind: "tool",
  capabilitySlug: null,
  active: true,
  createdAt: "2026-08-12T10:00:00.000Z",
};

function event(index: number): SecurityAuditEvent {
  return {
    kind: "posture_changed",
    ts: `2026-08-12T10:0${index}:00.000Z`,
    actorId: "actor-1",
    correlationId: "rollout-1",
    tokenHash: "secret-token-hash",
    nested: { password: "secret-password", safe: "kept" },
  };
}

function client(input?: {
  capabilities?: string[];
  pages?: Array<{ events: SecurityAuditEvent[]; hasMore: boolean; nextCursor: string | null }>;
  approvals?: CommandApprovalRow[];
  revoke?: (id: string) => Promise<{ ok: boolean }>;
  updatePosture?: (request: { deploymentMode?: SecurityPostureResponse["deploymentMode"]; securityLevel?: SecurityPostureResponse["securityLevel"]; pin: string }) => Promise<{ changed: boolean } & SecurityPostureResponse>;
}): AuthenticatedAdminClient {
  const pages = [...(input?.pages ?? [])];
  return {
    whoami: { sessionUserId: "user-1", capabilities: input?.capabilities ?? ["view_audit_log"] },
    api: {
      getSecurityPosture: async () => posture,
      updateSecurityPosture: input?.updatePosture ?? (async () => ({ changed: true, ...posture })),
      getSecurityAuditLog: async () => pages.shift() ?? { events: [], hasMore: false, nextCursor: null },
      listStandingApprovals: async () => input?.approvals ?? [approval],
      revokeStandingApproval: input?.revoke ?? (async () => ({ ok: true })),
    },
  } as unknown as AuthenticatedAdminClient;
}

async function run(args: string[], admin: AuthenticatedAdminClient): Promise<void> {
  await yargs(args)
    .exitProcess(false)
    .command(createSecurityModule({ authenticate: async () => admin }))
    .strict()
    .parseAsync();
}

async function runWithDependencies(
  args: string[],
  admin: AuthenticatedAdminClient,
  dependencies: Parameters<typeof createSecurityModule>[0],
): Promise<void> {
  await yargs(args)
    .exitProcess(false)
    .command(createSecurityModule({ authenticate: async () => admin, ...dependencies }))
    .strict()
    .parseAsync();
}

test("posture returns the server's effective facts", async () => {
  await run(["security", "posture", "--format", "json"], client());
  expect(JSON.parse(stdout)).toMatchObject({ ok: true, data: { deploymentMode: "server", securityLevel: "paranoid" } });
});

test("posture mutation rejects non-TTY use without an explicit descriptor", async () => {
  let mutations = 0;
  await runWithDependencies(
    ["security", "posture", "set", "--security-level", "cautious", "--format", "json"],
    client({
      capabilities: ["manage_server_security"],
      updatePosture: async (request) => { mutations += 1; return { changed: true, ...posture, ...request }; },
    }),
    { isStdinTty: () => false, isStderrTty: () => false },
  );
  expect(mutations).toBe(0);
  expect(JSON.parse(stdout)).toMatchObject({ ok: false, error: { code: "protected_input_required" } });
});

test("posture mutation reads the PIN only through the selected descriptor and re-observes", async () => {
  let capturedPin = "";
  let reads = 0;
  const admin = client({
    capabilities: ["manage_server_security"],
    updatePosture: async (request) => {
      capturedPin = request.pin;
      return { changed: true, ...posture, securityLevel: request.securityLevel ?? posture.securityLevel };
    },
  });
  (admin.api as unknown as { getSecurityPosture(): Promise<SecurityPostureResponse> }).getSecurityPosture = async () => {
    reads += 1;
    return reads === 1 ? posture : { ...posture, securityLevel: "cautious" };
  };
  await runWithDependencies(
    ["security", "posture", "set", "--security-level", "cautious", "--proof-fd", "7", "--format", "json"],
    admin,
    { readPinDescriptor: (fd) => { expect(fd).toBe(7); return "canary-pin"; } },
  );
  expect(capturedPin).toBe("canary-pin");
  expect(stdout).not.toContain("canary-pin");
  expect(reads).toBe(2);
  expect(JSON.parse(stdout)).toMatchObject({ data: { stateChanged: true, current: { securityLevel: "cautious" } } });
});

test("audit --all emits bounded JSONL pages and a truthful end record", async () => {
  await run(["security", "audit", "--all", "--limit", "1", "--format", "jsonl"], client({
    pages: [
      { events: [event(2)], hasMore: true, nextCursor: "next" },
      { events: [event(1)], hasMore: false, nextCursor: null },
    ],
  }));
  const rows = stdout.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(rows.map((row) => row["type"])).toEqual(["event", "event", "end"]);
  expect(rows[2]).toMatchObject({ returned: 2, complete: true, nextCursor: null });
  expect(stdout).not.toContain("secret-token-hash");
  expect(stdout).not.toContain("secret-password");
  expect(stdout).toContain('"safe":"kept"');
});

test("audit denial occurs before audit API I/O", async () => {
  let calls = 0;
  const admin = client({ capabilities: [] });
  (admin.api as unknown as { getSecurityAuditLog(): Promise<unknown> }).getSecurityAuditLog = async () => {
    calls += 1;
    return { events: [], hasMore: false, nextCursor: null };
  };
  await run(["security", "audit", "--format", "json"], admin);
  expect(calls).toBe(0);
  expect(JSON.parse(stdout)).toMatchObject({ ok: false, error: { code: "capability_denied" } });
});

test("approval revoke previews before explicit confirmation", async () => {
  let revokes = 0;
  const admin = client({ revoke: async () => { revokes += 1; return { ok: true }; } });
  await run(["security", "approvals", "revoke", approval.id, "--format", "json"], admin);
  expect(revokes).toBe(0);
  expect(JSON.parse(stdout)).toMatchObject({ data: { current: { id: approval.id }, proposed: "revoked" } });
});

test("approval revoke is idempotent when the approval is absent", async () => {
  let revokes = 0;
  await run(["security", "approvals", "revoke", approval.id, "--yes", "--format", "json"], client({
    approvals: [],
    revoke: async () => { revokes += 1; return { ok: true }; },
  }));
  expect(revokes).toBe(1);
  expect(JSON.parse(stdout)).toMatchObject({ data: { currentState: "revoked", stateChanged: false } });
});
