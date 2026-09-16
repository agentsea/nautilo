import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ApiError,
  NautiloApiClient,
  saveCliSession,
} from "@nautilo/api-client";
import type { InviteMutationReceipt } from "@nautilo/api-client";
import type { CommandModule } from "yargs";
import { parseDurationToMs } from "../../src/commands/invite.ts";

async function loadInviteModule(): Promise<{ inviteModule: CommandModule }> {
  return import(`../../src/commands/invite.ts?t=${Date.now()}`) as Promise<{
    inviteModule: CommandModule;
  }>;
}

const SESSION = {
  schemaVersion: 1 as const,
  instanceId: "i",
  serverUrl: "http://127.0.0.1:8",
  handle: "a",
  displayName: "A",
  externalId: "s",
  accessToken: "tok",
  tokenType: "Bearer" as const,
  expiresAt: Date.now() + 3600_000,
  scopes: [] as string[],
  source: "device" as const,
  obtainedAt: Date.now(),
};

const AGENT_UUID = "11111111-1111-1111-1111-111111111111";
const MOCK_MUTATION: InviteMutationReceipt = {
  stateChanged: true,
  auditRecorded: true,
  retrySafe: false,
  receiptId: "receipt-test",
  recovery: [],
};
const MOCK_PAGE = {
  returned: 0,
  complete: true,
  hasMore: false,
  nextCursor: null,
  continuationAvailable: true,
} as const;

describe("parseDurationToMs", () => {
  test("parses valid durations", () => {
    expect(parseDurationToMs("7d")).toBe(604_800_000);
    expect(parseDurationToMs("24h")).toBe(86_400_000);
    expect(parseDurationToMs("30m")).toBe(1_800_000);
    expect(parseDurationToMs("45s")).toBe(45_000);
    expect(parseDurationToMs("  7d  ")).toBe(604_800_000);
  });

  test("returns null for invalid input", () => {
    expect(parseDurationToMs("")).toBeNull();
    expect(parseDurationToMs("foo")).toBeNull();
    expect(parseDurationToMs("0d")).toBeNull();
    expect(parseDurationToMs("-1h")).toBeNull();
  });
});

describe("nautilo invite", () => {
  let dir: string;
  const originalIsTty = process.stdin.isTTY;

  beforeEach(() => {
    process.exitCode = undefined;
    dir = mkdtempSync(join(tmpdir(), "nautilo-invite-"));
    process.env["NAUTILO_HOME_OVERRIDE"] = dir;
  });

  afterEach(() => {
    Object.defineProperty(process.stdin, "isTTY", { value: originalIsTty, configurable: true });
    delete process.env["NAUTILO_HOME_OVERRIDE"];
    rmSync(dir, { recursive: true, force: true });
    process.exitCode = undefined;
  });

  test("create happy path JSON kind=server", async () => {
    await saveCliSession(SESSION);
    const createSpy = spyOn(NautiloApiClient.prototype, "createInvite").mockResolvedValue({
      id: "inv-1",
      url: "https://x/redeem/abc",
      token: "abc",
      kind: "server",
      expiresAt: null,
      maxUses: 1,
      mutation: MOCK_MUTATION,
    });
    const { inviteModule } = await loadInviteModule();
    let out = "";
    const ow = process.stdout.write.bind(process.stdout);
    process.stdout.write = (s: string | Uint8Array) => {
      out += typeof s === "string" ? s : Buffer.from(s).toString();
      return true;
    };
    const yargs = (await import("yargs/yargs")).default;
    const { hideBin } = await import("yargs/helpers");
    try {
      await yargs(
        hideBin([
          "node",
          "nautilo",
          "invite",
          "create",
          "--role=guest",
          "--yes",
          "--format",
          "json",
          "--server",
          "http://127.0.0.1:8",
        ]),
      )
        .command(inviteModule)
        .parseAsync();
      expect(process.exitCode ?? 0).toBe(0);
      const j = JSON.parse(out.trim()) as { id: string };
      expect(j.id).toBe("inv-1");
      expect(createSpy).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "server", targetGroupRoleSlug: "guest" }),
      );
    } finally {
      process.stdout.write = ow;
      createSpy.mockRestore();
    }
  });

  test("create happy path human kind=server", async () => {
    await saveCliSession(SESSION);
    const spy = spyOn(NautiloApiClient.prototype, "createInvite").mockResolvedValue({
      id: "inv-2",
      url: "https://x/redeem/group",
      token: "tok2",
      kind: "server",
      expiresAt: null,
      maxUses: 1,
      mutation: MOCK_MUTATION,
    });
    const { inviteModule } = await loadInviteModule();
    let out = "";
    const ow = process.stdout.write.bind(process.stdout);
    process.stdout.write = (s: string | Uint8Array) => {
      out += typeof s === "string" ? s : Buffer.from(s).toString();
      return true;
    };
    const yargs = (await import("yargs/yargs")).default;
    const { hideBin } = await import("yargs/helpers");
    try {
      await yargs(
        hideBin([
          "node",
          "nautilo",
          "invite",
          "create",
          "--yes",
          "--role=member",
          "--server",
          "http://127.0.0.1:8",
        ]),
      )
        .command(inviteModule)
        .parseAsync();
    } finally {
      process.stdout.write = ow;
      spy.mockRestore();
    }
    expect(process.exitCode ?? 0).toBe(0);
    expect(out).toContain("https://x/redeem/group");
    expect(out).toContain("kind:");
    expect(out).toContain("maxUses:");
    expect(out).toContain("expiresAt:");
  });

  test("create without --role on non-TTY", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    await saveCliSession(SESSION);
    const { inviteModule } = await loadInviteModule();
    let err = "";
    const ew = process.stderr.write.bind(process.stderr);
    process.stderr.write = (s: string | Uint8Array) => {
      err += typeof s === "string" ? s : Buffer.from(s).toString();
      return true;
    };
    const yargs = (await import("yargs/yargs")).default;
    const { hideBin } = await import("yargs/helpers");
    try {
      await yargs(
        hideBin([
          "node",
          "nautilo",
          "invite",
          "create",
          "--yes",
          "--server",
          "http://127.0.0.1:8",
        ]),
      )
        .command(inviteModule)
        .parseAsync();
    } finally {
      process.stderr.write = ew;
    }
    expect(process.exitCode).toBe(2);
    expect(err).toContain("missing --role");
  });

  test("create --expires-in=garbage", async () => {
    await saveCliSession(SESSION);
    const { inviteModule } = await loadInviteModule();
    let err = "";
    const ew = process.stderr.write.bind(process.stderr);
    process.stderr.write = (s: string | Uint8Array) => {
      err += typeof s === "string" ? s : Buffer.from(s).toString();
      return true;
    };
    const yargs = (await import("yargs/yargs")).default;
    const { hideBin } = await import("yargs/helpers");
    try {
      await yargs(
        hideBin([
          "node",
          "nautilo",
          "invite",
          "create",
          "--expires-in=garbage",
          "--role=guest",
          "--yes",
          "--server",
          "http://127.0.0.1:8",
        ]),
      )
        .command(inviteModule)
        .parseAsync();
    } finally {
      process.stderr.write = ew;
    }
    expect(process.exitCode).toBe(2);
    expect(err).toContain("Invalid --expires-in value");
  });

  test("create --max-uses=0", async () => {
    await saveCliSession(SESSION);
    const { inviteModule } = await loadInviteModule();
    let err = "";
    const ew = process.stderr.write.bind(process.stderr);
    process.stderr.write = (s: string | Uint8Array) => {
      err += typeof s === "string" ? s : Buffer.from(s).toString();
      return true;
    };
    const yargs = (await import("yargs/yargs")).default;
    const { hideBin } = await import("yargs/helpers");
    try {
      await yargs(
        hideBin([
          "node",
          "nautilo",
          "invite",
          "create",
          "--role=guest",
          "--max-uses=0",
          "--yes",
          "--server",
          "http://127.0.0.1:8",
        ]),
      )
        .command(inviteModule)
        .parseAsync();
    } finally {
      process.stderr.write = ew;
    }
    expect(process.exitCode).toBe(2);
    expect(err).toContain("must be >= 1");
  });

  test("list JSON returns invites", async () => {
    await saveCliSession(SESSION);
    const spy = spyOn(NautiloApiClient.prototype, "listMyInvites").mockResolvedValue({
      invites: [
        {
          id: "a",
          kind: "server",
          maxUses: 1,
          usedCount: 0,
          expiresAt: "2026-05-26T12:00:00.000Z",
          revokedAt: null,
          createdAt: "2026-05-19T00:00:00.000Z",
          displayName: "label-a",
          targetRoomId: null,
          targetRoomLabel: null,
          targetRoleSlug: null,
        },
        {
          id: "b",
          kind: "server",
          maxUses: null,
          usedCount: 2,
          expiresAt: null,
          revokedAt: "2026-05-20T00:00:00.000Z",
          createdAt: "2026-05-18T00:00:00.000Z",
          displayName: null,
          targetRoomId: null,
          targetRoomLabel: null,
          targetRoleSlug: "member",
        },
      ],
      page: { ...MOCK_PAGE, returned: 2 },
    });
    const { inviteModule } = await loadInviteModule();
    let out = "";
    const ow = process.stdout.write.bind(process.stdout);
    process.stdout.write = (s: string | Uint8Array) => {
      out += typeof s === "string" ? s : Buffer.from(s).toString();
      return true;
    };
    const yargs = (await import("yargs/yargs")).default;
    const { hideBin } = await import("yargs/helpers");
    try {
      await yargs(
        hideBin([
          "node",
          "nautilo",
          "invite",
          "list",
          "--format",
          "json",
          "--server",
          "http://127.0.0.1:8",
        ]),
      )
        .command(inviteModule)
        .parseAsync();
    } finally {
      process.stdout.write = ow;
      spy.mockRestore();
    }
    const j = JSON.parse(out.trim()) as { invites: unknown[] };
    expect(j.invites.length).toBe(2);
    expect(process.exitCode ?? 0).toBe(0);
  });

  test("list empty human", async () => {
    await saveCliSession(SESSION);
    const spy = spyOn(NautiloApiClient.prototype, "listMyInvites").mockResolvedValue({
      invites: [],
      page: MOCK_PAGE,
    });
    const { inviteModule } = await loadInviteModule();
    let out = "";
    const ow = process.stdout.write.bind(process.stdout);
    process.stdout.write = (s: string | Uint8Array) => {
      out += typeof s === "string" ? s : Buffer.from(s).toString();
      return true;
    };
    const yargs = (await import("yargs/yargs")).default;
    const { hideBin } = await import("yargs/helpers");
    try {
      await yargs(
        hideBin(["node", "nautilo", "invite", "list", "--server", "http://127.0.0.1:8"]),
      )
        .command(inviteModule)
        .parseAsync();
    } finally {
      process.stdout.write = ow;
      spy.mockRestore();
    }
    expect(out).toBe("No invites.\n");
    expect(process.exitCode ?? 0).toBe(0);
  });

  test("list human renders ROLE column and room label", async () => {
    await saveCliSession(SESSION);
    const spy = spyOn(NautiloApiClient.prototype, "listMyInvites").mockResolvedValue({
      invites: [
        {
          id: "inv-row",
          kind: "server",
          maxUses: 1,
          usedCount: 0,
          expiresAt: null,
          revokedAt: null,
          createdAt: "2026-05-19T00:00:00.000Z",
          displayName: null,
          targetRoomId: null,
          targetRoomLabel: "War Room",
          targetRoleSlug: "member",
        },
      ],
      page: { ...MOCK_PAGE, returned: 1 },
    });
    const { inviteModule } = await loadInviteModule();
    let out = "";
    const ow = process.stdout.write.bind(process.stdout);
    process.stdout.write = (s: string | Uint8Array) => {
      out += typeof s === "string" ? s : Buffer.from(s).toString();
      return true;
    };
    const yargs = (await import("yargs/yargs")).default;
    const { hideBin } = await import("yargs/helpers");
    try {
      await yargs(
        hideBin(["node", "nautilo", "invite", "list", "--server", "http://127.0.0.1:8"]),
      )
        .command(inviteModule)
        .parseAsync();
    } finally {
      process.stdout.write = ow;
      spy.mockRestore();
    }
    expect(process.exitCode ?? 0).toBe(0);
    expect(out).toContain("inv-row");
    expect(out).toContain("ROLE");
    expect(out).toContain("member");
    expect(out).toContain("War Room");
  });

  test("list human falls back to short room id when label missing", async () => {
    await saveCliSession(SESSION);
    const spy = spyOn(NautiloApiClient.prototype, "listMyInvites").mockResolvedValue({
      invites: [
        {
          id: "inv-row",
          kind: "server",
          maxUses: 1,
          usedCount: 0,
          expiresAt: null,
          revokedAt: null,
          createdAt: "2026-05-19T00:00:00.000Z",
          displayName: null,
          targetRoomId: AGENT_UUID,
          targetRoomLabel: null,
          targetRoleSlug: "member",
        },
      ],
      page: { ...MOCK_PAGE, returned: 1 },
    });
    const { inviteModule } = await loadInviteModule();
    let out = "";
    const ow = process.stdout.write.bind(process.stdout);
    process.stdout.write = (s: string | Uint8Array) => {
      out += typeof s === "string" ? s : Buffer.from(s).toString();
      return true;
    };
    const yargs = (await import("yargs/yargs")).default;
    const { hideBin } = await import("yargs/helpers");
    try {
      await yargs(
        hideBin(["node", "nautilo", "invite", "list", "--server", "http://127.0.0.1:8"]),
      )
        .command(inviteModule)
        .parseAsync();
    } finally {
      process.stdout.write = ow;
      spy.mockRestore();
    }
    expect(process.exitCode ?? 0).toBe(0);
    expect(out).toContain(`${AGENT_UUID.slice(0, 8)}…`);
    expect(out).not.toContain(AGENT_UUID);
  });

  test("list human shows dash when room fields are absent", async () => {
    await saveCliSession(SESSION);
    const spy = spyOn(NautiloApiClient.prototype, "listMyInvites").mockResolvedValue({
      invites: [
        {
          id: "inv-old",
          kind: "server",
          maxUses: 1,
          usedCount: 0,
          expiresAt: null,
          revokedAt: null,
          createdAt: "2026-05-19T00:00:00.000Z",
          displayName: null,
          targetRoomId: null,
          targetRoomLabel: null,
          targetRoleSlug: "guest",
        },
      ],
      page: { ...MOCK_PAGE, returned: 1 },
    });
    const { inviteModule } = await loadInviteModule();
    let out = "";
    const ow = process.stdout.write.bind(process.stdout);
    process.stdout.write = (s: string | Uint8Array) => {
      out += typeof s === "string" ? s : Buffer.from(s).toString();
      return true;
    };
    const yargs = (await import("yargs/yargs")).default;
    const { hideBin } = await import("yargs/helpers");
    try {
      await yargs(
        hideBin(["node", "nautilo", "invite", "list", "--server", "http://127.0.0.1:8"]),
      )
        .command(inviteModule)
        .parseAsync();
    } finally {
      process.stdout.write = ow;
      spy.mockRestore();
    }
    expect(process.exitCode ?? 0).toBe(0);
    expect(out).toContain("-");
    expect(out).not.toContain("undefined");
  });

  test("revoke with --yes", async () => {
    const id = "e3b0c442-98fc-1c14-9afb-f54893805000";
    await saveCliSession(SESSION);
    const spy = spyOn(NautiloApiClient.prototype, "revokeInvite").mockResolvedValue({
      ok: true,
      mutation: { ...MOCK_MUTATION, retrySafe: true },
    });
    const { inviteModule } = await loadInviteModule();
    let out = "";
    const ow = process.stdout.write.bind(process.stdout);
    process.stdout.write = (s: string | Uint8Array) => {
      out += typeof s === "string" ? s : Buffer.from(s).toString();
      return true;
    };
    const yargs = (await import("yargs/yargs")).default;
    const { hideBin } = await import("yargs/helpers");
    try {
      await yargs(
        hideBin([
          "node",
          "nautilo",
          "invite",
          "revoke",
          id,
          "--yes",
          "--server",
          "http://127.0.0.1:8",
        ]),
      )
        .command(inviteModule)
        .parseAsync();
    } finally {
      process.stdout.write = ow;
      spy.mockRestore();
    }
    expect(process.exitCode ?? 0).toBe(0);
    expect(out).toContain(`Revoked invite ${id}.`);
  });

  test("revoke 404", async () => {
    const id = "00000000-0000-0000-0000-000000000001";
    await saveCliSession(SESSION);
    const spy = spyOn(NautiloApiClient.prototype, "revokeInvite").mockImplementation(() => {
      throw new ApiError(404, "not_found");
    });
    const { inviteModule } = await loadInviteModule();
    let err = "";
    const ew = process.stderr.write.bind(process.stderr);
    process.stderr.write = (s: string | Uint8Array) => {
      err += typeof s === "string" ? s : Buffer.from(s).toString();
      return true;
    };
    const yargs = (await import("yargs/yargs")).default;
    const { hideBin } = await import("yargs/helpers");
    try {
      await yargs(
        hideBin(["node", "nautilo", "invite", "revoke", id, "--yes", "--server", "http://127.0.0.1:8"]),
      )
        .command(inviteModule)
        .parseAsync();
    } finally {
      process.stderr.write = ew;
      spy.mockRestore();
    }
    expect(process.exitCode).toBe(2);
    expect(err).toContain("Invite not found.");
  });

  test("revoke 403", async () => {
    const id = "00000000-0000-0000-0000-000000000002";
    await saveCliSession(SESSION);
    const spy = spyOn(NautiloApiClient.prototype, "revokeInvite").mockImplementation(() => {
      throw new ApiError(403, "forbidden");
    });
    const { inviteModule } = await loadInviteModule();
    let err = "";
    const ew = process.stderr.write.bind(process.stderr);
    process.stderr.write = (s: string | Uint8Array) => {
      err += typeof s === "string" ? s : Buffer.from(s).toString();
      return true;
    };
    const yargs = (await import("yargs/yargs")).default;
    const { hideBin } = await import("yargs/helpers");
    try {
      await yargs(
        hideBin(["node", "nautilo", "invite", "revoke", id, "--yes", "--server", "http://127.0.0.1:8"]),
      )
        .command(inviteModule)
        .parseAsync();
    } finally {
      process.stderr.write = ew;
      spy.mockRestore();
    }
    expect(process.exitCode).toBe(2);
    expect(err).toContain("You don't have permission");
  });

  test("revoke non-TTY without --yes", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    const id = "00000000-0000-0000-0000-000000000003";
    await saveCliSession(SESSION);
    const { inviteModule } = await loadInviteModule();
    let err = "";
    const ew = process.stderr.write.bind(process.stderr);
    process.stderr.write = (s: string | Uint8Array) => {
      err += typeof s === "string" ? s : Buffer.from(s).toString();
      return true;
    };
    const yargs = (await import("yargs/yargs")).default;
    const { hideBin } = await import("yargs/helpers");
    try {
      await yargs(
        hideBin(["node", "nautilo", "invite", "revoke", id, "--server", "http://127.0.0.1:8"]),
      )
        .command(inviteModule)
        .parseAsync();
    } finally {
      process.stderr.write = ew;
    }
    expect(process.exitCode).toBe(2);
    expect(err).toContain("Refusing to revoke non-interactively without --yes.");
  });
});
