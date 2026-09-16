/**
 * Tests for security-audit-log writer — D060 Sprint 1 G5.3.d.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import {
  readSecurityAuditLog,
  writeSecurityAuditEvent,
  type PostureChangedAuditEvent,
  type CapabilityCheckFailedAuditEvent,
  type ApprovalReplyAuditEvent,
  type ConnectionVaultToolAuditEvent,
  type InviteBindLogtoUserSucceededAuditEvent,
  type InviteBindLogtoUserFailedAuditEvent,
  type LogtoTokenMintFailedAuditEvent,
  type RecoverySessionOpenedAuditEvent,
  type RecoverySessionRejectedAuditEvent,
  type RecoveryRelayReadDeniedAuditEvent,
  type RecoveryRelayCodeUnmatchedAuditEvent,
  type WorkstationAdmissionAuditEvent,
  type UncontainedHostCommandsAuditEvent,
  type GroupMemberAddedAuditEvent,
  type GroupMemberRemovedAuditEvent,
  type EncryptionTransitionPolicyChangeRequestedAuditEvent,
} from "../../src/lib/security-audit-log";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "nautilo-audit-log-"));
});

describe("readSecurityAuditLog", () => {
  test("returns newest-first rows with limit + hasMore", () => {
    const path = join(tmp, "security-audit.log");
    const common = {
      actorId: "owner-actor",
      ip: "127.0.0.1",
      userAgent: undefined,
    };
    for (let i = 0; i < 3; i++) {
      writeSecurityAuditEvent(path, {
        kind: "posture_changed",
        ...common,
        ts: `2026-04-24T12:0${i}:00.000Z`,
        prev: { deploymentMode: "desktop-permissive", securityLevel: "cautious" },
        next: { deploymentMode: "server", securityLevel: "paranoid" },
      });
    }

    const result = readSecurityAuditLog(path, { limit: 2 });
    expect(result.events.map((e) => e.ts)).toEqual([
      "2026-04-24T12:02:00.000Z",
      "2026-04-24T12:01:00.000Z",
    ]);
    expect(result.hasMore).toBe(true);
    expect(result.nextCursor).not.toBeNull();
    if (!result.nextCursor) throw new Error("expected continuation");
    const next = readSecurityAuditLog(path, { limit: 2, cursor: result.nextCursor });
    expect(next.events.map((event) => event.ts)).toEqual(["2026-04-24T12:00:00.000Z"]);
    expect(next.hasMore).toBe(false);
    expect(next.nextCursor).toBeNull();
  });

  test("rejects a continuation after the filtered snapshot changes", () => {
    const path = join(tmp, "security-audit.log");
    const event = (ts: string) => ({
      kind: "posture_changed" as const,
      ts,
      actorId: "owner-actor",
      ip: "127.0.0.1",
      userAgent: undefined,
      prev: { deploymentMode: "desktop-permissive" as const, securityLevel: "cautious" as const },
      next: { deploymentMode: "server" as const, securityLevel: "paranoid" as const },
    });
    writeSecurityAuditEvent(path, event("2026-04-24T12:00:00.000Z"));
    writeSecurityAuditEvent(path, event("2026-04-24T12:01:00.000Z"));
    const first = readSecurityAuditLog(path, { limit: 1 });
    writeSecurityAuditEvent(path, event("2026-04-24T12:02:00.000Z"));
    if (!first.nextCursor) throw new Error("expected continuation");
    const cursor = first.nextCursor;
    expect(() => readSecurityAuditLog(path, { limit: 1, cursor }))
      .toThrow("stale_audit_cursor");
  });

  test("binds continuation to the exact query and page size", () => {
    const path = join(tmp, "security-audit.log");
    for (let index = 0; index < 3; index += 1) {
      writeSecurityAuditEvent(path, {
        kind: "posture_changed",
        ts: `2026-04-24T12:0${index}:00.000Z`,
        actorId: "owner-actor",
        ip: "127.0.0.1",
        userAgent: undefined,
        prev: { deploymentMode: "desktop-permissive", securityLevel: "cautious" },
        next: { deploymentMode: "server", securityLevel: "paranoid" },
      });
    }
    const first = readSecurityAuditLog(path, { limit: 1, actorId: "owner-actor" });
    if (!first.nextCursor) throw new Error("expected continuation");
    const cursor = first.nextCursor;
    expect(() => readSecurityAuditLog(path, { limit: 2, actorId: "owner-actor", cursor }))
      .toThrow("stale_audit_cursor");
    expect(() => readSecurityAuditLog(path, { limit: 1, cursor }))
      .toThrow("stale_audit_cursor");
  });

  test("totally orders equal-timestamp rows", () => {
    const path = join(tmp, "security-audit.log");
    for (const actorId of ["zeta", "alpha"]) {
      writeSecurityAuditEvent(path, {
        kind: "capability_check_failed",
        ts: "2026-04-24T12:00:00.000Z",
        actorId,
        ip: "127.0.0.1",
        userAgent: undefined,
        capability: "manage_server_security",
        attemptedRoute: "PUT /api/security/posture",
      });
    }
    const result = readSecurityAuditLog(path, { limit: 1 });
    if (!result.nextCursor) throw new Error("expected continuation");
    const next = readSecurityAuditLog(path, { limit: 1, cursor: result.nextCursor });
    expect([result.events[0]?.actorId, next.events[0]?.actorId].sort()).toEqual(["alpha", "zeta"]);
  });

  test("filters by actor, kind, and since", () => {
    const path = join(tmp, "security-audit.log");
    writeSecurityAuditEvent(path, {
      kind: "posture_changed",
      ts: "2026-04-24T12:00:00.000Z",
      actorId: "owner-actor",
      ip: "127.0.0.1",
      userAgent: undefined,
      prev: { deploymentMode: "desktop-permissive", securityLevel: "cautious" },
      next: { deploymentMode: "server", securityLevel: "paranoid" },
    });
    writeSecurityAuditEvent(path, {
      kind: "capability_check_failed",
      ts: "2026-04-24T12:05:00.000Z",
      actorId: "household-actor",
      ip: "127.0.0.1",
      userAgent: undefined,
      capability: "manage_server_security",
      attemptedRoute: "PUT /api/security/posture",
    });

    const result = readSecurityAuditLog(path, {
      actorId: "household-actor",
      kinds: ["capability_check_failed"],
      since: "2026-04-24T12:01:00.000Z",
    });
    expect(result.events.length).toBe(1);
    expect(result.events[0]?.kind).toBe("capability_check_failed");
    expect(result.events[0]?.actorId).toBe("household-actor");
  });

  test("filters connection_vault_tool kind (D041)", () => {
    const path = join(tmp, "security-audit.log");
    writeSecurityAuditEvent(path, {
      kind: "posture_changed",
      ts: "2026-04-24T12:00:00.000Z",
      actorId: "owner-actor",
      ip: "127.0.0.1",
      userAgent: undefined,
      prev: { deploymentMode: "desktop-permissive", securityLevel: "cautious" },
      next: { deploymentMode: "server", securityLevel: "paranoid" },
    });
    const vaultEvt: ConnectionVaultToolAuditEvent = {
      kind: "connection_vault_tool",
      ts: "2026-04-28T10:00:00.000Z",
      actorId: "actor-9",
      ip: "10.0.0.2",
      userAgent: undefined,
      action: "list",
      tool: "list_connections",
      outcome: "ok",
    };
    writeSecurityAuditEvent(path, vaultEvt);

    const result = readSecurityAuditLog(path, { kinds: ["connection_vault_tool"] });
    expect(result.events.length).toBe(1);
    expect(result.events[0]?.kind).toBe("connection_vault_tool");
    expect((result.events[0] as ConnectionVaultToolAuditEvent).tool).toBe("list_connections");
  });
});

afterEach(() => {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

describe("writeSecurityAuditEvent", () => {
  test("round-trips the audit-before-CAS encryption policy request", () => {
    const path = join(tmp, "security-audit.log");
    const event: EncryptionTransitionPolicyChangeRequestedAuditEvent = {
      kind: "encryption_transition_policy_change_requested",
      ts: "2026-08-15T12:00:00.000Z",
      actorId: "owner-actor",
      ip: "127.0.0.1",
      userAgent: "test-client/1.0",
      before: {
        mode: "plaintext_only",
        shadowBehavior: "fallback",
        revision: 2,
      },
      requested: {
        mode: "shadow_encryption",
        shadowBehavior: "strict",
        expectedRevision: 2,
      },
    };
    writeSecurityAuditEvent(path, event);
    expect(readSecurityAuditLog(path, {
      kinds: ["encryption_transition_policy_change_requested"],
      limit: 1,
    }).events).toEqual([event]);
  });

  test("persists only redacted uncontained-host-command lifecycle evidence", () => {
    const path = join(tmp, "security-audit.log");
    const event: UncontainedHostCommandsAuditEvent = {
      kind: "uncontained_host_commands_activated",
      ts: "2026-08-17T12:00:00.000Z",
      actorId: "actor-1",
      ip: "127.0.0.1",
      userAgent: "test-client",
      userId: "user-1",
      relayId: "relay-1",
      desktopSessionId: "desktop-1",
      serverBindingId: "server-1",
      capabilityRevision: 4,
      route: "POST /api/security/uncontained-host-commands/activate",
    };
    writeSecurityAuditEvent(path, event);
    const raw = readFileSync(path, "utf-8");
    expect(raw).toContain("uncontained_host_commands_activated");
    for (const forbidden of ["pin", "command", "path", "environment", "grant", "output"]) {
      expect(raw).not.toContain(`"${forbidden}"`);
    }
  });

  test("persists redacted D538 dispatch evidence without command or path data", () => {
    const path = join(tmp, "security-audit-dispatch.log");
    writeSecurityAuditEvent(path, {
      kind: "uncontained_host_commands_dispatch_denied",
      ts: "2026-08-17T12:00:00.000Z",
      actorId: "actor-1",
      ip: "127.0.0.1",
      userAgent: "test-client",
      userId: "user-1",
      relayId: "relay-1",
      desktopSessionId: "desktop-1",
      serverBindingId: "server-1",
      capabilityRevision: 4,
      reason: "session_binding_mismatch",
      route: "relay:dispatch/run_shell",
    } satisfies UncontainedHostCommandsAuditEvent);
    const raw = readFileSync(path, "utf-8");
    expect(raw).toContain("uncontained_host_commands_dispatch_denied");
    for (const forbidden of ["command", "path", "pin", "secret", "output"]) {
      expect(raw).not.toContain(`"${forbidden}"`);
    }
  });

  test("appends a single JSONL line for a posture_changed event", () => {
    const path = join(tmp, "security-audit.log");
    const event: PostureChangedAuditEvent = {
      kind: "posture_changed",
      ts: "2026-04-24T12:00:00.000Z",
      actorId: "owner-actor",
      ip: "127.0.0.1",
      userAgent: "test-client/1.0",
      prev: { deploymentMode: "desktop-permissive", securityLevel: "cautious" },
      next: { deploymentMode: "server", securityLevel: "paranoid" },
    };

    writeSecurityAuditEvent(path, event);

    const body = readFileSync(path, "utf-8");
    expect(body.endsWith("\n")).toBe(true);
    const lines = body.trim().split("\n");
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]!) as PostureChangedAuditEvent;
    expect(parsed).toEqual(event);
  });

  test("appends multiple events without overwriting", () => {
    const path = join(tmp, "security-audit.log");
    const common = {
      ts: "2026-04-24T12:00:00.000Z",
      actorId: "owner-actor",
      ip: "127.0.0.1",
      userAgent: undefined,
    };
    writeSecurityAuditEvent(path, {
      kind: "posture_changed",
      ...common,
      prev: { deploymentMode: "desktop-permissive", securityLevel: "cautious" },
      next: { deploymentMode: "server", securityLevel: "paranoid" },
    });
    writeSecurityAuditEvent(path, {
      kind: "capability_check_failed",
      ...common,
      capability: "manage_server_security",
      attemptedRoute: "PUT /api/security/posture",
    });

    const body = readFileSync(path, "utf-8");
    const lines = body.trim().split("\n");
    expect(lines.length).toBe(2);
    const first = JSON.parse(lines[0]!) as PostureChangedAuditEvent;
    const second = JSON.parse(lines[1]!) as CapabilityCheckFailedAuditEvent;
    expect(first.kind).toBe("posture_changed");
    expect(second.kind).toBe("capability_check_failed");
    expect(second.capability).toBe("manage_server_security");
  });

  test("creates the parent directory when missing (first-run case)", () => {
    const nestedDir = join(tmp, "nested", "deeper", ".nautilo");
    const path = join(nestedDir, "security-audit.log");
    writeSecurityAuditEvent(path, {
      kind: "posture_changed",
      ts: "2026-04-24T12:00:00.000Z",
      actorId: "owner-actor",
      ip: "127.0.0.1",
      userAgent: undefined,
      prev: { deploymentMode: "desktop-permissive", securityLevel: "cautious" },
      next: { deploymentMode: "server", securityLevel: "paranoid" },
    });

    const stat = statSync(path);
    expect(stat.isFile()).toBe(true);
    expect(stat.size).toBeGreaterThan(0);
  });

  test("file is created with 0600 mode (owner-only read/write)", () => {
    const path = join(tmp, "security-audit.log");
    writeSecurityAuditEvent(path, {
      kind: "posture_changed",
      ts: "2026-04-24T12:00:00.000Z",
      actorId: "owner-actor",
      ip: "127.0.0.1",
      userAgent: undefined,
      prev: { deploymentMode: "desktop-permissive", securityLevel: "cautious" },
      next: { deploymentMode: "server", securityLevel: "paranoid" },
    });

    // On Windows the mode check is meaningless; skip when the path
    // separator is not POSIX-style.
    if (sep !== "/") return;
    const stat = statSync(path);
    const mode = stat.mode & 0o777;
    // Audit log holds actor_id, ip, user_agent — treat as PII-bearing
    // and don't let siblings read. 0600 is the target; some systems
    // apply umask so we accept 0600 or stricter (0400).
    expect(mode & 0o077).toBe(0);
  });

  test("writes valid JSONL — one complete JSON object per line, no trailing comma", () => {
    const path = join(tmp, "security-audit.log");
    for (let i = 0; i < 5; i++) {
      writeSecurityAuditEvent(path, {
        kind: "posture_changed",
        ts: `2026-04-24T12:00:0${i}.000Z`,
        actorId: "owner-actor",
        ip: "127.0.0.1",
        userAgent: undefined,
        prev: { deploymentMode: "desktop-permissive", securityLevel: "cautious" },
        next: { deploymentMode: "server", securityLevel: "paranoid" },
      });
    }

    const body = readFileSync(path, "utf-8");
    const lines = body.split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBe(5);
    for (const line of lines) {
      // Each line must parse standalone — pillar of JSONL.
      expect(() => {
        JSON.parse(line);
      }).not.toThrow();
    }
  });

  test("appends URL-redacted approval audit event with network context", () => {
    const path = join(tmp, "security-audit.log");
    const event: ApprovalReplyAuditEvent = {
      kind: "approval_granted",
      ts: "2026-04-29T12:00:00.000Z",
      actorId: "owner-actor",
      ip: "127.0.0.1",
      userAgent: "test-client/1.0",
      route: "POST /api/auth/approval-reply",
      threadId: "thread-net",
      laneKey: "lane-net",
      verb: "room",
      network: {
        host: "api.weather.com",
        port: 443,
        reason: "no allow rule matched",
        suggestedRule: {
          type: "domain",
          host: "api.weather.com",
          ports: [443],
        },
      },
    };

    writeSecurityAuditEvent(path, event);

    const body = readFileSync(path, "utf-8");
    const parsed = JSON.parse(body.trim()) as ApprovalReplyAuditEvent;
    expect(parsed).toEqual(event);
    expect(body).not.toContain("private");
    expect(body).not.toContain("token=");
  });

  test("round-trips connection_vault_tool JSONL (D041)", () => {
    const path = join(tmp, "security-audit.log");
    const event: ConnectionVaultToolAuditEvent = {
      kind: "connection_vault_tool",
      ts: "2026-04-28T11:00:00.000Z",
      actorId: "actor-x",
      ip: "192.168.1.5",
      userAgent: "nautilo-test/1",
      action: "delete",
      tool: "delete_connection",
      outcome: "missing",
      service: "api",
      field: "key",
    };
    writeSecurityAuditEvent(path, event);
    const line = readFileSync(path, "utf-8").trim().split("\n")[0]!;
    expect(JSON.parse(line) as ConnectionVaultToolAuditEvent).toEqual(event);
  });

  test("round-trips logto_token_mint_failed JSONL (D112 Phase 6)", () => {
    const path = join(tmp, "security-audit.log");
    const event: LogtoTokenMintFailedAuditEvent = {
      kind: "logto_token_mint_failed",
      ts: "2026-05-07T12:00:00.000Z",
      actorId: null,
      ip: "127.0.0.1",
      userAgent: "nautilo-test/1",
      logtoSub: "logto-user-1",
    };
    writeSecurityAuditEvent(path, event);
    const line = readFileSync(path, "utf-8").trim();
    expect(JSON.parse(line) as LogtoTokenMintFailedAuditEvent).toEqual(event);
  });

  test("round-trips invite bind audit rows without raw invite or handle", () => {
    const path = join(tmp, "security-audit.log");
    const success: InviteBindLogtoUserSucceededAuditEvent = {
      kind: "invite_bind_logto_user_succeeded",
      ts: "2026-05-29T10:00:00.000Z",
      actorId: "actor-1",
      ip: "127.0.0.1",
      userAgent: "nautilo-test/1",
      tokenHash: "token-hash",
      inviteKind: "server",
      targetGroupId: "group-1",
      targetRoomId: "room-1",
      userId: "user-1",
      logtoSub: "logto-sub-1",
      handleHash: "handle-hash",
    };
    const failure: InviteBindLogtoUserFailedAuditEvent = {
      kind: "invite_bind_logto_user_failed",
      ts: "2026-05-29T10:00:01.000Z",
      actorId: null,
      ip: "127.0.0.1",
      userAgent: "nautilo-test/1",
      tokenHash: "token-hash",
      inviteKind: "server",
      targetGroupId: "group-1",
      targetRoomId: "room-1",
      logtoSub: "logto-sub-1",
      handleHash: "handle-hash",
      reason: "handle_mismatch",
    };

    writeSecurityAuditEvent(path, success);
    writeSecurityAuditEvent(path, failure);

    const body = readFileSync(path, "utf-8");
    const lines = body.trim().split("\n");
    const first = JSON.parse(lines[0]!) as InviteBindLogtoUserSucceededAuditEvent;
    const second = JSON.parse(lines[1]!) as InviteBindLogtoUserFailedAuditEvent;
    expect(first).toEqual(success);
    expect(second).toEqual(failure);
    expect(body).not.toContain("inv_");
    expect(body).not.toContain("alice");
  });

  test("round-trips M120 recovery audit rows without codes, tokens, or emails", () => {
    const path = join(tmp, "security-audit.log");
    const opened: RecoverySessionOpenedAuditEvent = {
      kind: "recovery_session_opened",
      ts: "2026-06-04T10:00:00.000Z",
      actorId: null,
      ip: "127.0.0.1",
      userAgent: "nautilo-test/1",
      handleHash: "handle-hash",
    };
    const rejected: RecoverySessionRejectedAuditEvent = {
      kind: "recovery_session_rejected",
      ts: "2026-06-04T10:00:01.000Z",
      actorId: null,
      ip: "127.0.0.1",
      userAgent: "nautilo-test/1",
      handleHash: "handle-hash",
      reason: "logto_unavailable",
    };
    const relayDenied: RecoveryRelayReadDeniedAuditEvent = {
      kind: "recovery_relay_read_denied",
      ts: "2026-06-04T10:00:02.000Z",
      actorId: null,
      ip: "127.0.0.1",
      userAgent: "nautilo-test/1",
      reason: "not_found",
    };
    const unmatched: RecoveryRelayCodeUnmatchedAuditEvent = {
      kind: "recovery_relay_code_unmatched",
      ts: "2026-06-04T10:00:03.000Z",
      actorId: null,
      ip: "127.0.0.1",
      userAgent: "nautilo-test/1",
    };

    writeSecurityAuditEvent(path, opened);
    writeSecurityAuditEvent(path, rejected);
    writeSecurityAuditEvent(path, relayDenied);
    writeSecurityAuditEvent(path, unmatched);

    const lines = readFileSync(path, "utf-8").trim().split("\n");
    expect(JSON.parse(lines[0]!) as RecoverySessionOpenedAuditEvent).toEqual(opened);
    expect(JSON.parse(lines[1]!) as RecoverySessionRejectedAuditEvent).toEqual(rejected);
    expect(JSON.parse(lines[2]!) as RecoveryRelayReadDeniedAuditEvent).toEqual(relayDenied);
    expect(JSON.parse(lines[3]!) as RecoveryRelayCodeUnmatchedAuditEvent).toEqual(unmatched);

    // The rows carry no synthetic email and no `code`/`sessionToken` fields
    // (kind names legitimately contain the substring "code", so we assert on
    // structure + representative secret values, not bare substrings).
    const body = readFileSync(path, "utf-8");
    expect(body).not.toContain("@nautilo.local");
    for (const line of lines) {
      const row = JSON.parse(line) as Record<string, unknown>;
      expect(row).not.toHaveProperty("code");
      expect(row).not.toHaveProperty("sessionToken");
      expect(row).not.toHaveProperty("recoveryCode");
      expect(row).not.toHaveProperty("email");
    }
  });

  test("round-trips a redacted D418 workstation_admission audit row (Commit 4)", () => {
    const path = join(tmp, "security-audit.log");
    // An `auto` admission row: outcome=auto, reason=auto_admitted. Carries
    // execution class + tool/tool-call id + OPAQUE session/plan binding ids.
    const auto: WorkstationAdmissionAuditEvent = {
      kind: "workstation_admission",
      ts: "2026-07-14T12:00:00.000Z",
      actorId: "owner-actor",
      ip: "127.0.0.1",
      userAgent: "nautilo-test/1",
      userId: "owner-user",
      toolName: "run_shell",
      toolCallId: "tc-admit-1",
      executionClass: "profile_bound_sandbox",
      outcome: "auto",
      reason: "auto_admitted",
      relayId: "relay-1",
      desktopSessionId: "desktop-session-1",
      serverBindingId: "server-binding-1",
      pairingGeneration: "pairing-1",
      profileId: "profile-1",
      profileRevision: 1,
      capabilityRevision: 10,
    };
    // A `none` admission row: outcome=none, reason=critical_or_elevation_command.
    const none: WorkstationAdmissionAuditEvent = {
      kind: "workstation_admission",
      ts: "2026-07-14T12:00:01.000Z",
      actorId: "owner-actor",
      ip: "127.0.0.1",
      userAgent: undefined,
      userId: "owner-user",
      toolName: "run_shell",
      toolCallId: "tc-admit-2",
      executionClass: "profile_bound_sandbox",
      outcome: "none",
      reason: "critical_or_elevation_command",
      relayId: "relay-1",
      desktopSessionId: "desktop-session-1",
      serverBindingId: "server-binding-1",
      pairingGeneration: "pairing-1",
      profileId: "profile-1",
      profileRevision: 1,
      capabilityRevision: 10,
    };

    writeSecurityAuditEvent(path, auto);
    writeSecurityAuditEvent(path, none);

    const lines = readFileSync(path, "utf-8").trim().split("\n");
    expect(JSON.parse(lines[0]!) as WorkstationAdmissionAuditEvent).toEqual(auto);
    expect(JSON.parse(lines[1]!) as WorkstationAdmissionAuditEvent).toEqual(none);

    // Redaction: the admission row never carries authority material. The
    // command string / secret never appear, and no authority keys exist on
    // the row.
    const body = readFileSync(path, "utf-8");
    expect(body).not.toContain("rm -rf");
    expect(body).not.toContain("secret");
    for (const line of lines) {
      const row = JSON.parse(line) as Record<string, unknown>;
      expect(row).not.toHaveProperty("command");
      expect(row).not.toHaveProperty("commandOutput");
      expect(row).not.toHaveProperty("output");
      expect(row).not.toHaveProperty("roots");
      expect(row).not.toHaveProperty("allowedRoots");
      expect(row).not.toHaveProperty("env");
      expect(row).not.toHaveProperty("token");
      expect(row).not.toHaveProperty("pin");
      expect(row).not.toHaveProperty("grantIds");
    }
  });

  test("round-trips Stack 195 group_member_added / group_member_removed audit rows (W3.0.2f)", () => {
    const path = join(tmp, "security-audit.log");
    const added: GroupMemberAddedAuditEvent = {
      kind: "group_member_added",
      ts: "2026-07-17T12:00:00.000Z",
      actorId: "owner-actor",
      ip: "127.0.0.1",
      userAgent: "nautilo-test/1",
      groupId: "g-admins",
      groupType: "admins",
      targetUserId: "user-2",
    };
    const removed: GroupMemberRemovedAuditEvent = {
      kind: "group_member_removed",
      ts: "2026-07-17T12:00:01.000Z",
      actorId: "owner-actor",
      ip: "127.0.0.1",
      userAgent: undefined,
      groupId: "g-admins",
      groupType: "admins",
      targetUserId: "user-2",
      bypassedRail: false,
    };

    writeSecurityAuditEvent(path, added);
    writeSecurityAuditEvent(path, removed);

    const lines = readFileSync(path, "utf-8").trim().split("\n");
    expect(JSON.parse(lines[0]!) as GroupMemberAddedAuditEvent).toEqual(added);
    expect(JSON.parse(lines[1]!) as GroupMemberRemovedAuditEvent).toEqual(removed);

    // Redaction: the membership rows carry only opaque identifiers + the
    // actor envelope — never a bearer, PIN, or any secret.
    const body = readFileSync(path, "utf-8");
    expect(body).not.toContain("Bearer ");
    for (const line of lines) {
      const row = JSON.parse(line) as Record<string, unknown>;
      expect(row).not.toHaveProperty("token");
      expect(row).not.toHaveProperty("pin");
      expect(row).not.toHaveProperty("bearer");
      expect(row).not.toHaveProperty("secret");
    }
  });
});
