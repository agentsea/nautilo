import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  ApiError,
  type AdminUserMutationResponse,
  type AdminPasswordResetResponse,
  type AdminProvisionMemberResponse,
  type AdminRolloutPlanResponse,
  type AdminRolloutApplyResponse,
  type AdminRolloutStatusResponse,
  type AdminUserDeleteResponse,
  type AdminUserRow,
  type AdminUsersListResponse,
  type OwnedSharedRoomsResponse,
  type CreateInviteResult,
  type InviteListResult,
  type RevokeInviteResult,
} from "@nautilo/api-client";
import yargs from "yargs/yargs";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createMembersModule,
  type MembersCommandDependencies,
} from "../../src/commands/members.ts";
import {
  AuthenticatedAdminClientError,
  type AuthenticatedAdminClient,
} from "../../src/lib/authenticated-admin-client.ts";
import type { ProtectedHandoffReservation } from "../../src/lib/protected-handoff.ts";

const MUTATION = {
  stateChanged: true,
  auditRecorded: true,
  retrySafe: false,
  receiptId: "receipt-1",
  recovery: [{ kind: "revoke_invite", inviteId: "invite-1" }],
} as const;

const CREATED: CreateInviteResult = {
  id: "invite-1",
  url: "https://nautilo.example/redeem/SECRET-CANARY",
  token: "SECRET-CANARY",
  kind: "server",
  expiresAt: null,
  maxUses: 1,
  mutation: { ...MUTATION, recovery: [...MUTATION.recovery] },
};

const ACTIVE_INVITE = {
  id: "invite-1",
  kind: "server" as const,
  maxUses: 1,
  usedCount: 0,
  expiresAt: null,
  revokedAt: null,
  createdAt: "2026-08-12T00:00:00.000Z",
  displayName: null,
  targetRoomId: null,
  targetRoomLabel: null,
  targetRoleSlug: "member",
};

const MEMBER_ID = "11111111-1111-4111-8111-111111111111";
const MEMBER: AdminUserRow = {
  id: MEMBER_ID,
  handle: "alex",
  displayName: "Alex",
  groups: [{ id: "group-1", type: "members", label: "Members", roleSlug: "member" }],
  server: null,
  lastSeenAt: null,
  createdAt: "2026-08-12T00:00:00.000Z",
  disabledAt: null,
  disabledBy: null,
  disabledReason: null,
};

function memberPage(users = [MEMBER]): AdminUsersListResponse {
  return {
    users,
    nextCursor: null,
    page: {
      returned: users.length,
      complete: true,
      hasMore: false,
      nextCursor: null,
      continuationAvailable: true,
    },
  };
}

function page(invites = [ACTIVE_INVITE]): InviteListResult {
  return {
    invites,
    page: {
      returned: invites.length,
      complete: true,
      hasMore: false,
      nextCursor: null,
      continuationAvailable: true,
    },
  };
}

function fakeClient(input: {
  capabilities?: string[];
  createInvite?: () => Promise<CreateInviteResult>;
  listInvites?: () => Promise<InviteListResult>;
  revokeInvite?: () => Promise<RevokeInviteResult>;
  listMembers?: () => Promise<AdminUsersListResponse>;
  getMember?: () => Promise<AdminUserRow>;
  disableMember?: () => Promise<AdminUserMutationResponse>;
  enableMember?: () => Promise<AdminUserMutationResponse>;
  resetPassword?: () => Promise<AdminPasswordResetResponse>;
  provisionMember?: (
    input: { handle: string; displayName: string; roleSlug: string },
    idempotencyKey: string,
  ) => Promise<AdminProvisionMemberResponse>;
  setPermanentCredentials?: (
    id: string,
    input: { password: string; pin: string },
  ) => Promise<{ ok: true; memberId: string; auditRecorded: boolean }>;
  planRollout?: (manifest: unknown) => Promise<AdminRolloutPlanResponse>;
  applyRollout?: (manifest: unknown, fingerprint: string, idempotencyKey: string) => Promise<AdminRolloutApplyResponse>;
  rolloutStatus?: (rolloutId: string) => Promise<AdminRolloutStatusResponse>;
  acknowledgeRollout?: (rolloutId: string, sequences: number[]) => Promise<AdminRolloutStatusResponse>;
  resumeRollout?: (rolloutId: string) => Promise<AdminRolloutApplyResponse>;
  deleteMember?: () => Promise<AdminUserDeleteResponse>;
  ownedRooms?: () => Promise<OwnedSharedRoomsResponse>;
  archiveRoom?: () => Promise<{ ok: boolean }>;
  transferRoom?: () => Promise<{ ok: boolean }>;
} = {}): AuthenticatedAdminClient {
  return {
    whoami: {
      capabilities: input.capabilities ?? ["manage_members"],
    },
    api: {
      createInvite: input.createInvite ?? (async () => CREATED),
      listInvites: input.listInvites ?? (async () => page()),
      revokeInvite: input.revokeInvite ?? (async () => ({
        ok: true,
        mutation: { ...MUTATION, retrySafe: true, recovery: [] },
      })),
      admin: {
        users: {
          planRollout: input.planRollout ?? (async () => ({
            ok: true,
            schemaVersion: 1,
            fingerprint: "f".repeat(64),
            serverInstanceId: "11111111-1111-4111-8111-111111111111",
            operations: [],
            warnings: [],
            bounds: { maxMembers: 100, requestedMembers: 1 },
          })),
          applyRollout: input.applyRollout ?? (async () => ({
            ok: true,
            rolloutId: "rollout-1",
            fingerprint: "f".repeat(64),
            status: "partial",
            createdAt: "2026-08-12T00:00:00.000Z",
            updatedAt: "2026-08-12T00:00:00.000Z",
            items: [],
            idempotent: false,
            credentials: [],
          })),
          rolloutStatus: input.rolloutStatus ?? (async () => ({
            ok: true,
            rolloutId: "rollout-1",
            fingerprint: "f".repeat(64),
            status: "complete",
            createdAt: "2026-08-12T00:00:00.000Z",
            updatedAt: "2026-08-12T00:00:00.000Z",
            items: [],
          })),
          acknowledgeRollout: input.acknowledgeRollout ?? (async () => ({
            ok: true,
            rolloutId: "rollout-1",
            fingerprint: "f".repeat(64),
            status: "complete",
            createdAt: "2026-08-12T00:00:00.000Z",
            updatedAt: "2026-08-12T00:00:00.000Z",
            items: [],
          })),
          resumeRollout: input.resumeRollout ?? (async () => ({
            ok: true,
            rolloutId: "rollout-1",
            fingerprint: "f".repeat(64),
            status: "complete",
            createdAt: "2026-08-12T00:00:00.000Z",
            updatedAt: "2026-08-12T00:00:00.000Z",
            items: [],
            credentials: [],
          })),
          provision: input.provisionMember ?? (async () => ({
            ok: true,
            receiptId: "provision-receipt",
            memberId: MEMBER_ID,
            actorId: "actor-1",
            landingRoomId: "room-1",
            roleSlug: "member",
            idempotent: false,
            auditRecorded: true,
            credential: {
              disposition: "issued" as const,
              temporaryPassword: "TEMP-CANARY",
              pin: "123456",
              recoveryCodes: ["RECOVERY-CANARY"],
            },
          })),
          setPermanentCredentials: input.setPermanentCredentials ?? (async () => ({
            ok: true,
            memberId: MEMBER_ID,
            auditRecorded: true,
          })),
          list: input.listMembers ?? (async () => memberPage()),
          get: input.getMember ?? (async () => MEMBER),
          disable: input.disableMember ?? (async () => ({
            ok: true,
            mutation: { ...MUTATION, retrySafe: true, recovery: [] },
          })),
          enable: input.enableMember ?? (async () => ({
            ok: true,
            mutation: { ...MUTATION, retrySafe: true, recovery: [] },
          })),
          resetPassword: input.resetPassword ?? (async () => ({
            ok: true,
            delivery: "one_time_url" as const,
            url: "https://nautilo.example/reset?token=RESET-CANARY",
            token: "RESET-CANARY",
            mutation: { ...MUTATION, retrySafe: false, recovery: [] },
          })),
          delete: input.deleteMember ?? (async () => ({
            ok: true,
            logtoRevoked: true,
            mutation: { ...MUTATION, retrySafe: false, recovery: [] },
          })),
          ownedSharedRooms: input.ownedRooms ?? (async () => ({ rooms: [] })),
        },
        rooms: {
          archive: input.archiveRoom ?? (async () => ({ ok: true })),
          transferOwner: input.transferRoom ?? (async () => ({ ok: true })),
        },
      },
    },
  } as unknown as AuthenticatedAdminClient;
}

type Captured = { stdout: string; stderr: string };
let captured: Captured;
let originalStdout: typeof process.stdout.write;
let originalStderr: typeof process.stderr.write;

beforeEach(() => {
  process.exitCode = undefined;
  captured = { stdout: "", stderr: "" };
  originalStdout = process.stdout.write;
  originalStderr = process.stderr.write;
  process.stdout.write = ((value: string | Uint8Array) => {
    captured.stdout += typeof value === "string" ? value : Buffer.from(value).toString();
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((value: string | Uint8Array) => {
    captured.stderr += typeof value === "string" ? value : Buffer.from(value).toString();
    return true;
  }) as typeof process.stderr.write;
});

afterEach(() => {
  process.stdout.write = originalStdout;
  process.stderr.write = originalStderr;
  process.exitCode = undefined;
});

async function run(args: string[], overrides: Partial<MembersCommandDependencies>): Promise<void> {
  await yargs(args)
    .exitProcess(false)
    .command(createMembersModule({
      authenticate: async () => fakeClient(),
      reserveHandoff: async () => ({ write: async () => {}, discard: async () => {} }),
      prompt: async () => "yes",
      isInteractive: () => false,
      now: () => Date.parse("2026-08-12T00:00:00.000Z"),
      ...overrides,
    }))
    .strict()
    .parseAsync();
}

describe("signed members invite", () => {
  test("interactive intent signs in once, rebuilds auth, and only then mutates", async () => {
    const order: string[] = [];
    const createInvite = mock(async () => {
      order.push("mutate");
      return CREATED;
    });
    let authAttempt = 0;

    await run(["members", "invite"], {
      isInteractive: () => true,
      authenticate: async () => {
        order.push("authenticate");
        authAttempt += 1;
        if (authAttempt === 1) throw new AuthenticatedAdminClientError("login_required");
        return fakeClient({ createInvite });
      },
      login: async () => { order.push("login"); },
    });

    expect(order).toEqual(["authenticate", "login", "authenticate", "mutate"]);
    expect(createInvite).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(0);
  });

  test("noninteractive missing login fails before login or mutation", async () => {
    const login = mock(async () => {});
    const createInvite = mock(async () => CREATED);

    await run(
      ["members", "invite", "--format", "json", "--handoff-file", "/safe/invite.json"],
      {
        authenticate: async () => { throw new AuthenticatedAdminClientError("login_required"); },
        login,
      },
    );

    expect(login).not.toHaveBeenCalled();
    expect(createInvite).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
    expect(JSON.parse(captured.stdout)).toMatchObject({
      ok: false,
      error: { code: "login_required" },
    });
  });

  test("requires and reserves a protected JSON handoff before authentication or mutation", async () => {
    const authenticate = mock(async () => fakeClient());
    await run(["members", "invite", "--format", "json"], { authenticate });

    expect(authenticate).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
    expect(JSON.parse(captured.stdout)).toMatchObject({
      ok: false,
      error: { code: "handoff_required" },
    });
  });

  test("writes the only token copy to the reserved file and emits a nonsecret receipt", async () => {
    const order: string[] = [];
    let handoff: Record<string, unknown> | undefined;
    const reservation: ProtectedHandoffReservation = {
      write: async (value) => { order.push("write"); handoff = value; },
      discard: async () => { order.push("discard"); },
    };
    const createInvite = mock(async () => { order.push("mutate"); return CREATED; });

    await run(
      ["members", "invite", "--format", "json", "--handoff-file", "/safe/invite.json"],
      {
        reserveHandoff: async () => { order.push("reserve"); return reservation; },
        authenticate: async () => { order.push("authenticate"); return fakeClient({ createInvite }); },
      },
    );

    expect(order).toEqual(["reserve", "authenticate", "mutate", "write", "discard"]);
    expect(handoff).toMatchObject({ token: "SECRET-CANARY", url: CREATED.url });
    expect(captured.stdout).not.toContain("SECRET-CANARY");
    expect(captured.stdout).not.toContain("redeem/");
    expect(JSON.parse(captured.stdout)).toMatchObject({
      ok: true,
      data: { inviteId: "invite-1", handoff: "protected_file" },
    });
  });

  test("rejects an unsafe invite URL before terminal or handoff disclosure", async () => {
    const write = mock(async () => {});
    await run(
      ["members", "invite", "--format", "json", "--handoff-file", "/safe/invite.json"],
      {
        reserveHandoff: async () => ({ write, discard: async () => {} }),
        authenticate: async () => fakeClient({
          createInvite: async () => ({ ...CREATED, url: "javascript:SECRET-CANARY" }),
        }),
      },
    );

    expect(write).not.toHaveBeenCalled();
    expect(captured.stdout).not.toContain("SECRET-CANARY");
    expect(JSON.parse(captured.stdout)).toMatchObject({
      ok: false,
      error: { code: "invite_outcome_unknown" },
    });
  });

  test("capability denial happens before the invite API and discards the reservation", async () => {
    const createInvite = mock(async () => CREATED);
    const discard = mock(async () => {});
    await run(
      ["members", "invite", "--format", "json", "--handoff-file", "/safe/invite.json"],
      {
        reserveHandoff: async () => ({ write: async () => {}, discard }),
        authenticate: async () => fakeClient({ capabilities: [], createInvite }),
      },
    );

    expect(createInvite).not.toHaveBeenCalled();
    expect(discard).toHaveBeenCalledTimes(1);
    expect(JSON.parse(captured.stdout)).toMatchObject({ ok: false, error: { code: "capability_denied" } });
  });

  test("lists bounded page facts and never returns bearer material", async () => {
    const listInvites = mock(async () => ({
      ...page(),
      page: { ...page().page, complete: false, hasMore: true, nextCursor: "cursor-2" },
    }));
    await run(["members", "invite", "list", "--all", "--limit", "25", "--format", "json"], {
      authenticate: async () => fakeClient({ listInvites }),
    });

    expect(listInvites).toHaveBeenCalledTimes(1);
    const output = JSON.parse(captured.stdout) as { data: { page: { complete: boolean; nextCursor: string } } };
    expect(output.data.page).toMatchObject({ complete: false, nextCursor: "cursor-2" });
    expect(captured.stdout).not.toContain("token");
    expect(captured.stdout).not.toContain("url");
  });

  test("observes before confirmed revocation and returns the server receipt", async () => {
    const listInvites = mock(async () => page());
    const revokeInvite = mock(async () => ({
      ok: true as const,
      mutation: { ...MUTATION, retrySafe: true, recovery: [] },
    }));
    await run(["members", "invite", "revoke", "invite-1", "--yes", "--format", "json"], {
      authenticate: async () => fakeClient({ listInvites, revokeInvite }),
    });

    expect(listInvites).toHaveBeenCalledTimes(1);
    expect(revokeInvite).toHaveBeenCalledTimes(1);
    expect(JSON.parse(captured.stdout)).toMatchObject({
      ok: true,
      data: { inviteId: "invite-1", currentState: "active", proposedState: "revoked" },
    });
  });
});

describe("signed member lifecycle", () => {
  test("rollout plan reads locally then emits a server-bound write-free preview", async () => {
    const manifest = { schemaVersion: 1, members: [{ handle: "newperson", displayName: "New Person", roleSlug: "member" }] };
    const planRollout = mock(async () => ({
      ok: true as const,
      schemaVersion: 1 as const,
      fingerprint: "a".repeat(64),
      serverInstanceId: "11111111-1111-4111-8111-111111111111",
      operations: [{ index: 0, handle: "newperson", displayName: "New Person", roleSlug: "member", idempotencyKey: "rollout:key:0" }],
      warnings: [],
      bounds: { maxMembers: 100, requestedMembers: 1 },
    }));
    await run(["members", "rollout", "plan", "--file", "/safe/rollout.json", "--format", "json"], {
      readManifest: async () => manifest,
      authenticate: async () => fakeClient({ planRollout }),
    });
    expect(planRollout).toHaveBeenCalledWith(manifest);
    expect(JSON.parse(captured.stdout)).toMatchObject({
      ok: true,
      data: { fingerprint: "a".repeat(64), operations: [{ handle: "newperson", roleSlug: "member" }] },
    });
  });

  test("rollout apply reserves custody before mutation and redacts credentials from JSON", async () => {
    const order: string[] = [];
    let handoff: Record<string, unknown> | undefined;
    const applyRollout = mock(async () => {
      order.push("apply");
      return {
        ok: true as const,
        rolloutId: "rollout-1",
        fingerprint: "a".repeat(64),
        status: "partial",
        createdAt: "2026-08-12T00:00:00.000Z",
        updatedAt: "2026-08-12T00:00:00.000Z",
        items: [],
        idempotent: false,
        credentials: [{
          sequence: 0,
          handle: "newperson",
          temporaryPassword: "ROLLOUT-PASSWORD-CANARY",
          pin: "654321",
          recoveryCodes: ["ROLLOUT-RECOVERY-CANARY"],
        }],
      };
    });
    const acknowledgeRollout = mock(async () => ({
      ok: true as const,
      rolloutId: "rollout-1",
      fingerprint: "a".repeat(64),
      status: "complete",
      createdAt: "2026-08-12T00:00:00.000Z",
      updatedAt: "2026-08-12T00:00:01.000Z",
      items: [],
    }));
    await run([
      "members", "rollout", "apply",
      "--file", "/safe/rollout.json",
      "--fingerprint", "a".repeat(64),
      "--handoff-file", "/safe/rollout-handoff.json",
      "--format", "json",
    ], {
      readManifest: async () => ({ schemaVersion: 1, members: [] }),
      reserveHandoff: async () => {
        order.push("reserve");
        return {
          write: async (value) => { order.push("write"); handoff = value; },
          discard: async () => { order.push("discard"); },
        };
      },
      authenticate: async () => fakeClient({ applyRollout, acknowledgeRollout }),
    });

    expect(order).toEqual(["reserve", "apply", "write"]);
    expect(acknowledgeRollout).toHaveBeenCalledWith("rollout-1", [0]);
    expect(JSON.stringify(handoff)).toContain("ROLLOUT-PASSWORD-CANARY");
    expect(captured.stdout).not.toContain("ROLLOUT-PASSWORD-CANARY");
    expect(captured.stdout).not.toContain("ROLLOUT-RECOVERY-CANARY");
    expect(JSON.parse(captured.stdout)).toMatchObject({
      ok: true,
      data: { rolloutId: "rollout-1", status: "complete", handoff: "protected_file" },
    });
  });

  test("rollout status is observation-only and resume requires custody before remote work", async () => {
    const status = mock(async () => ({
      ok: true as const,
      rolloutId: "rollout-1",
      fingerprint: "a".repeat(64),
      status: "repair_required",
      createdAt: "2026-08-12T00:00:00.000Z",
      updatedAt: "2026-08-12T00:00:01.000Z",
      items: [{
        sequence: 0,
        handle: "newperson",
        roleSlug: "member",
        state: "unknown",
        receiptId: null,
        memberId: null,
        errorCode: "outcome_unknown",
        credentialDisposition: "none",
        updatedAt: "2026-08-12T00:00:01.000Z",
      }],
    }));
    await run(["members", "rollout", "status", "rollout-1", "--format", "json"], {
      authenticate: async () => fakeClient({ rolloutStatus: status }),
    });
    expect(status).toHaveBeenCalledWith("rollout-1");
    expect(JSON.parse(captured.stdout)).toMatchObject({
      data: { status: "repair_required", items: [{ state: "unknown" }] },
    });

    captured.stdout = "";
    const authenticate = mock(async () => fakeClient());
    await run(["members", "rollout", "resume", "rollout-1", "--format", "json"], { authenticate });
    expect(authenticate).not.toHaveBeenCalled();
    expect(JSON.parse(captured.stdout)).toMatchObject({ ok: false, error: { code: "handoff_required" } });
  });

  test("reserves protected custody before direct provisioning and redacts every credential", async () => {
    const order: string[] = [];
    let handoff: Record<string, unknown> | undefined;
    const provisionMember = mock(async () => {
      order.push("provision");
      return {
        ok: true as const,
        receiptId: "provision-receipt",
        memberId: MEMBER_ID,
        actorId: "actor-1",
        landingRoomId: "room-1",
        roleSlug: "member",
        idempotent: false,
        auditRecorded: true,
        credential: {
          disposition: "issued" as const,
          temporaryPassword: "TEMP-PASSWORD-CANARY",
          pin: "654321",
          recoveryCodes: ["RECOVERY-CANARY"],
        },
      };
    });
    await run([
      "members", "provision",
      "--handle", "newperson",
      "--display-name", "New Person",
      "--role", "member",
      "--handoff-file", "/safe/provision.json",
      "--format", "json",
    ], {
      createIdempotencyKey: () => "generated-provision-key",
      reserveHandoff: async () => {
        order.push("reserve");
        return {
          write: async (value) => { order.push("write"); handoff = value; },
          discard: async () => {},
        };
      },
      authenticate: async () => fakeClient({ provisionMember }),
    });

    expect(order).toEqual(["reserve", "provision", "write"]);
    expect(provisionMember).toHaveBeenCalledWith({
      handle: "newperson",
      displayName: "New Person",
      roleSlug: "member",
    }, "generated-provision-key");
    expect(handoff).toMatchObject({
      kind: "nautilo.provisioned-member-handoff",
      temporaryPassword: "TEMP-PASSWORD-CANARY",
      pin: "654321",
      recoveryCodes: ["RECOVERY-CANARY"],
      mustChangePassword: true,
    });
    expect(captured.stdout).not.toContain("CANARY");
    expect(captured.stdout).not.toContain("654321");
    expect(JSON.parse(captured.stdout)).toMatchObject({
      ok: true,
      data: { credentialDisposition: "issued", handoff: "protected_file" },
    });
  });

  test("restores an existing permanent member from owner-only credentials without emitting secrets", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "nautilo-permanent-member-")));
    const path = join(root, "credential.json");
    const password = "PERMANENT-PASSWORD-CANARY";
    await writeFile(path, JSON.stringify({ handle: "alex", temporaryPassword: password, pin: "123456" }), { mode: 0o600 });
    await chmod(path, 0o600);
    const setPermanentCredentials = mock(async () => ({ ok: true as const, memberId: MEMBER_ID, auditRecorded: true }));
    try {
      await run([
        "members", "ensure-permanent",
        "--handle", "alex",
        "--display-name", "Alex",
        "--credential-file", path,
        "--format", "json",
      ], { authenticate: async () => fakeClient({ setPermanentCredentials }) });
      expect(setPermanentCredentials).toHaveBeenCalledWith(MEMBER_ID, { password, pin: "123456" });
      expect(captured.stdout).not.toContain(password);
      expect(captured.stdout).not.toContain("123456");
      expect(JSON.parse(captured.stdout)).toMatchObject({
        ok: true,
        data: { action: "restored", passwordChangeRequired: false },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("recreates a missing permanent member with the exact protected credentials", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "nautilo-permanent-member-")));
    const path = join(root, "credential.json");
    const password = "PERMANENT-PASSWORD-CANARY";
    await writeFile(path, JSON.stringify({ handle: "alex", password, pin: "123456" }), { mode: 0o600 });
    const provisionMember = mock(async () => ({
      ok: true as const,
      receiptId: "provision-receipt",
      memberId: MEMBER_ID,
      actorId: "actor-1",
      landingRoomId: "room-1",
      roleSlug: "member",
      idempotent: false,
      auditRecorded: true,
      credential: {
        disposition: "provided" as const,
        recoveryCodes: ["RECOVERY-CANARY"],
      },
    }));
    try {
      await run([
        "members", "ensure-permanent",
        "--handle", "alex",
        "--display-name", "Alex",
        "--credential-file", path,
        "--format", "json",
      ], {
        authenticate: async () => fakeClient({
          listMembers: async () => memberPage([]),
          provisionMember,
        }),
        createIdempotencyKey: () => "durable-recreate-key",
      });
      expect(provisionMember).toHaveBeenCalledWith({
        handle: "alex",
        displayName: "Alex",
        roleSlug: "member",
        permanentCredential: { password, pin: "123456" },
      }, "durable-recreate-key");
      expect(captured.stdout).not.toContain(password);
      expect(captured.stdout).not.toContain("123456");
      expect(captured.stdout).not.toContain("RECOVERY-CANARY");
      expect(JSON.parse(captured.stdout)).toMatchObject({ ok: true, data: { action: "recreated" } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("lists bounded directory state and origin", async () => {
    const listMembers = mock(async () => memberPage());
    await run(["members", "list", "--format", "json", "--limit", "25"], {
      authenticate: async () => fakeClient({ listMembers }),
    });

    expect(listMembers).toHaveBeenCalledTimes(1);
    expect(JSON.parse(captured.stdout)).toMatchObject({
      ok: true,
      data: {
        members: [{ id: MEMBER_ID, state: "enabled", origin: "local" }],
        page: { complete: true, returned: 1 },
      },
    });
  });

  test("rejects a colliding normalized selector without mutating", async () => {
    const second = { ...MEMBER, id: "22222222-2222-4222-8222-222222222222", handle: "Ａｌｅｘ" };
    const disableMember = mock(async () => ({
      ok: true,
      mutation: { ...MUTATION, retrySafe: true, recovery: [] },
    }));
    await run(["members", "disable", "alex", "--yes", "--format", "json"], {
      authenticate: async () => fakeClient({
        listMembers: async () => memberPage([MEMBER, second]),
        disableMember,
      }),
    });

    expect(disableMember).not.toHaveBeenCalled();
    expect(JSON.parse(captured.stdout)).toMatchObject({ ok: false, error: { code: "member_conflict" } });
  });

  test("scans all pages and rejects Unicode-normalized collisions", async () => {
    const unicodeMember = {
      ...MEMBER,
      id: "22222222-2222-4222-8222-222222222222",
      handle: "Ａlex",
      displayName: "Full Width Alex",
    };
    const listMembers = mock(async (input?: { cursor?: string }) => input?.cursor
      ? memberPage([unicodeMember])
      : {
          ...memberPage([MEMBER]),
          nextCursor: "page-2",
          page: {
            returned: 1,
            complete: false,
            hasMore: true,
            nextCursor: "page-2",
            continuationAvailable: true,
          },
        });
    const disableMember = mock(async () => ({
      ok: true,
      mutation: { ...MUTATION, retrySafe: true, recovery: [] },
    }));

    await run(["members", "disable", "alex", "--yes", "--format", "json"], {
      authenticate: async () => fakeClient({ listMembers, disableMember }),
    });

    expect(listMembers).toHaveBeenCalledTimes(2);
    expect(disableMember).not.toHaveBeenCalled();
    expect(JSON.parse(captured.stdout)).toMatchObject({
      ok: false,
      error: { code: "member_conflict" },
    });
  });

  test("member authority denial happens before directory access", async () => {
    const listMembers = mock(async () => memberPage());
    await run(["members", "list", "--format", "json"], {
      authenticate: async () => fakeClient({ capabilities: [], listMembers }),
    });

    expect(listMembers).not.toHaveBeenCalled();
    expect(JSON.parse(captured.stdout)).toMatchObject({
      ok: false,
      error: { code: "capability_denied" },
    });
  });

  test("observes a stable ID before disable and emits the idempotent receipt", async () => {
    const getMember = mock(async () => MEMBER);
    const disableMember = mock(async () => ({
      ok: true,
      mutation: { ...MUTATION, retrySafe: true, recovery: [] },
    }));
    await run(["members", "disable", MEMBER_ID, "--reason", "security", "--yes", "--format", "json"], {
      authenticate: async () => fakeClient({ getMember, disableMember }),
    });

    expect(getMember).toHaveBeenCalledTimes(1);
    expect(disableMember).toHaveBeenCalledTimes(1);
    expect(JSON.parse(captured.stdout)).toMatchObject({
      ok: true,
      data: { memberId: MEMBER_ID, previousState: "enabled", currentState: "disabled" },
    });
  });

  test("requires confirmation before a noninteractive state mutation", async () => {
    const disableMember = mock(async () => ({
      ok: true,
      mutation: { ...MUTATION, retrySafe: true, recovery: [] },
    }));
    await run(["members", "disable", MEMBER_ID, "--format", "json"], {
      authenticate: async () => fakeClient({ disableMember }),
    });

    expect(disableMember).not.toHaveBeenCalled();
    expect(JSON.parse(captured.stdout)).toMatchObject({ ok: false, error: { code: "confirmation_required" } });
  });

  test("reserves password-reset custody before issuing and redacts ordinary output", async () => {
    const order: string[] = [];
    let handoff: Record<string, unknown> | undefined;
    const resetPassword = mock(async () => {
      order.push("reset");
      return {
        ok: true,
        delivery: "one_time_url" as const,
        url: "https://nautilo.example/reset?token=RESET-CANARY",
        token: "RESET-CANARY",
        mutation: { ...MUTATION, retrySafe: false, recovery: [] },
      };
    });
    await run(
      ["members", "reset-password", MEMBER_ID, "--yes", "--handoff-file", "/safe/reset.json", "--format", "json"],
      {
        reserveHandoff: async () => {
          order.push("reserve");
          return { write: async (value) => { order.push("write"); handoff = value; }, discard: async () => {} };
        },
        authenticate: async () => fakeClient({ resetPassword }),
      },
    );

    expect(order).toEqual(["reserve", "reset", "write"]);
    expect(handoff).toMatchObject({ token: "RESET-CANARY" });
    expect(captured.stdout).not.toContain("RESET-CANARY");
    expect(captured.stdout).not.toContain("reset?token");
  });

  test("writes a forced-change temporary password only to the protected handoff", async () => {
    let handoff: Record<string, unknown> | undefined;
    await run(
      ["members", "reset-password", MEMBER_ID, "--yes", "--handoff-file", "/safe/reset.json", "--format", "json"],
      {
        reserveHandoff: async () => ({
          write: async (value) => { handoff = value; },
          discard: async () => {},
        }),
        authenticate: async () => fakeClient({
          resetPassword: async () => ({
            ok: true,
            delivery: "temporary_password",
            temporaryPassword: "TEMP-PASSWORD-CANARY",
            mustChangePassword: true,
            mutation: { ...MUTATION, retrySafe: true, recovery: [] },
          }),
        }),
      },
    );

    expect(handoff).toMatchObject({
      kind: "nautilo.temporary-password-handoff",
      delivery: "temporary_password",
      temporaryPassword: "TEMP-PASSWORD-CANARY",
      mustChangePassword: true,
    });
    expect(captured.stdout).not.toContain("TEMP-PASSWORD-CANARY");
    expect(JSON.parse(captured.stdout)).toMatchObject({
      ok: true,
      data: { delivery: "temporary_password", handoff: "protected_file" },
    });
  });

  test("remove without --yes is a fresh non-mutating plan", async () => {
    const deleteMember = mock(async () => ({
      ok: true,
      logtoRevoked: true,
      mutation: { ...MUTATION, retrySafe: false, recovery: [] },
    }));
    await run(["members", "remove", MEMBER_ID, "--format", "json"], {
      authenticate: async () => fakeClient({ deleteMember }),
    });

    expect(deleteMember).not.toHaveBeenCalled();
    expect(JSON.parse(captured.stdout)).toMatchObject({
      ok: true,
      data: { executable: true, member: { id: MEMBER_ID } },
    });
  });

  test("refuses self-removal before blocker observation or deletion", async () => {
    const ownedRooms = mock(async () => ({ rooms: [] }));
    const deleteMember = mock(async () => ({
      ok: true,
      logtoRevoked: true,
      mutation: { ...MUTATION, retrySafe: false, recovery: [] },
    }));
    const selfClient = fakeClient({ ownedRooms, deleteMember }) as AuthenticatedAdminClient & {
      whoami: { sessionUserId?: string; capabilities: string[] };
    };
    selfClient.whoami.sessionUserId = MEMBER_ID;

    await run(["members", "remove", MEMBER_ID, "--yes", "--format", "json"], {
      authenticate: async () => selfClient,
    });

    expect(ownedRooms).not.toHaveBeenCalled();
    expect(deleteMember).not.toHaveBeenCalled();
    expect(JSON.parse(captured.stdout)).toMatchObject({
      ok: false,
      error: { code: "member_conflict" },
    });
  });

  test("confirmed removal re-observes before delete and preserves Logto truth", async () => {
    const getMember = mock(async () => MEMBER);
    const deleteMember = mock(async () => ({
      ok: true,
      logtoRevoked: false,
      mutation: { ...MUTATION, retrySafe: false, recovery: [{ kind: "reconcile_logto_user", userId: MEMBER_ID }] },
    }));
    await run(["members", "remove", MEMBER_ID, "--yes", "--format", "json"], {
      authenticate: async () => fakeClient({ getMember, deleteMember }),
    });

    expect(getMember).toHaveBeenCalledTimes(2);
    expect(deleteMember).toHaveBeenCalledTimes(1);
    expect(JSON.parse(captured.stdout)).toMatchObject({
      ok: true,
      data: { memberId: MEMBER_ID, currentState: "removed", logtoRevoked: false },
    });
  });

  test("lost delete response re-observes committed removal without blind retry", async () => {
    let getAttempt = 0;
    const getMember = mock(async () => {
      getAttempt += 1;
      if (getAttempt < 3) return MEMBER;
      throw new ApiError(404, "gone");
    });
    const deleteMember = mock(async () => {
      throw new Error("disconnect after commit");
    });

    await run(["members", "remove", MEMBER_ID, "--yes", "--format", "json"], {
      authenticate: async () => fakeClient({ getMember, deleteMember }),
    });

    expect(deleteMember).toHaveBeenCalledTimes(1);
    expect(getMember).toHaveBeenCalledTimes(3);
    expect(JSON.parse(captured.stdout)).toMatchObject({
      ok: true,
      data: {
        currentState: "removed",
        logtoRevoked: "unknown",
        mutation: {
          stateChanged: "unknown",
          retrySafe: false,
          recovery: [{ kind: "reconcile_logto_user", userId: MEMBER_ID }],
        },
      },
    });
  });

  test("requires exact shared-room recovery and re-observes it before delete", async () => {
    const roomId = "33333333-3333-4333-8333-333333333333";
    let observation = 0;
    const ownedRooms = mock(async () => {
      observation += 1;
      return observation === 1
        ? { rooms: [{ roomId, label: "Shared Room", eligibleNewOwners: [] }] }
        : { rooms: [] };
    });
    const archiveRoom = mock(async () => ({ ok: true }));
    const deleteMember = mock(async () => ({
      ok: true,
      logtoRevoked: true,
      mutation: { ...MUTATION, retrySafe: false, recovery: [] },
    }));
    await run(
      ["members", "remove", MEMBER_ID, "--archive-room", roomId, "--yes", "--format", "json"],
      { authenticate: async () => fakeClient({ ownedRooms, archiveRoom, deleteMember }) },
    );

    expect(archiveRoom).toHaveBeenCalledTimes(1);
    expect(ownedRooms).toHaveBeenCalledTimes(2);
    expect(deleteMember).toHaveBeenCalledTimes(1);
  });
});
