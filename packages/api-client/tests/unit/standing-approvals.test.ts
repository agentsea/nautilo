import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NautiloApiClient } from "../../src/client";
import {
  commandApprovalRowSchema,
  standingApprovalsListSchema,
} from "../../src/schemas/standing-approvals";

function reqUrl(input: Parameters<typeof fetch>[0]): string {
  return typeof input === "string" ? input : (input as URL).toString();
}

const sampleListPayload = {
  approvals: [
    {
      id: "apr_room_1",
      scope: "room" as const,
      roomId: "room_abc",
      roomLabel: "Ops channel",
      toolPattern: "bash",
      label: "bash rm -rf /tmp/nautilo-*",
      approvalKind: "tool" as const,
      capabilitySlug: null,
      active: true,
      createdAt: "2026-06-01T12:00:00.000Z",
    },
    {
      id: "apr_server_1",
      scope: "server" as const,
      roomId: null,
      roomLabel: null,
      toolPattern: "web_fetch",
      label: "web_fetch GET https://example.com/*",
      approvalKind: "tool" as const,
      capabilitySlug: null,
      active: true,
      createdAt: "2026-06-02T08:30:00.000Z",
    },
    {
      id: "apr_cap_1",
      scope: "server" as const,
      roomId: null,
      roomLabel: null,
      toolPattern: "_capability",
      label: "capability: network.external",
      approvalKind: "capability" as const,
      capabilitySlug: "network.external",
      active: true,
      createdAt: "2026-06-03T15:45:00.000Z",
    },
  ],
};

describe("standing approvals schema", () => {
  test("standingApprovalsListSchema parses realistic M037 list payload", () => {
    const parsed = standingApprovalsListSchema.parse(sampleListPayload);
    expect(parsed.approvals).toHaveLength(3);

    const roomRow = parsed.approvals[0];
    expect(roomRow?.scope).toBe("room");
    expect(roomRow?.roomId).toBe("room_abc");
    expect(roomRow?.roomLabel).toBe("Ops channel");
    expect(roomRow?.approvalKind).toBe("tool");

    const serverRow = parsed.approvals[1];
    expect(serverRow?.scope).toBe("server");
    expect(serverRow?.roomId).toBeNull();
    expect(serverRow?.roomLabel).toBeNull();

    const capabilityRow = parsed.approvals[2];
    expect(capabilityRow?.approvalKind).toBe("capability");
    expect(capabilityRow?.capabilitySlug).toBe("network.external");
    expect(capabilityRow?.toolPattern).toBe("_capability");
  });

  test("commandApprovalRowSchema rejects missing approvalKind", () => {
    const { approvalKind: _omit, ...badRow } = sampleListPayload.approvals[0]!;
    expect(() => commandApprovalRowSchema.parse(badRow)).toThrow();
  });
});

describe("standing approvals client (mocked fetch)", () => {
  const base = "http://127.0.0.1:9";
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("listStandingApprovals calls GET /api/security/standing-approvals and returns parsed rows", async () => {
    const client = new NautiloApiClient(base);
    client.setToken("tok-approvals");

    globalThis.fetch = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      expect(reqUrl(url)).toBe(`${base}/api/security/standing-approvals`);
      expect(init?.method ?? "GET").toBe("GET");
      const h = new Headers(init?.headers);
      expect(h.get("authorization")).toBe("Bearer tok-approvals");
      return new Response(JSON.stringify(sampleListPayload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const out = await client.listStandingApprovals();
    expect(out).toHaveLength(3);
    expect(out[0]?.id).toBe("apr_room_1");
    expect(out[1]?.scope).toBe("server");
    expect(out[2]?.approvalKind).toBe("capability");
    expect(out[2]?.capabilitySlug).toBe("network.external");
  });

  test("revokeStandingApproval calls DELETE /api/security/standing-approvals/:id", async () => {
    const client = new NautiloApiClient(base);
    client.setToken("tok-approvals");

    globalThis.fetch = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      expect(reqUrl(url)).toBe(`${base}/api/security/standing-approvals/apr_room_1`);
      expect(init?.method).toBe("DELETE");
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const out = await client.revokeStandingApproval("apr_room_1");
    expect(out).toEqual({ ok: true });
  });

  test("getSecurityAuditLog forwards deterministic continuation and filters", async () => {
    const client = new NautiloApiClient(base);
    client.setToken("tok-audit");
    globalThis.fetch = (async (url: Parameters<typeof fetch>[0]) => {
      const parsed = new URL(reqUrl(url));
      expect(parsed.pathname).toBe("/api/security/audit-log");
      expect(Object.fromEntries(parsed.searchParams)).toEqual({
        limit: "25",
        since: "2026-08-01T00:00:00.000Z",
        actorId: "actor-1",
        correlationId: "rollout-1",
        kinds: "posture_changed,standing_approval_revoked",
        cursor: "opaque-next",
      });
      return new Response(JSON.stringify({ events: [], hasMore: false, nextCursor: null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const result = await client.getSecurityAuditLog({
      limit: 25,
      since: "2026-08-01T00:00:00.000Z",
      actorId: "actor-1",
      correlationId: "rollout-1",
      kinds: ["posture_changed", "standing_approval_revoked"],
      cursor: "opaque-next",
    });
    expect(result).toEqual({ events: [], hasMore: false, nextCursor: null });
  });
});
