/**
 * Stack 195 / W3.2.6 — HTTP contract + Zod shape coverage for the typed
 * preview/apply api-client methods. Mocked fetch (no network).
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { NautiloApiClient, ApiError } from "../../src/client";
import {
  accessControlOperationSchema,
  applyResponseSchema,
  previewResponseSchema,
} from "../../src/schemas/access-control-mutations";

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  return typeof input === "string" ? input : (input as URL).toString();
}

const PREVIEW = {
  ok: true,
  operation: {
    kind: "role.create",
    slug: "mobile-dev",
    label: "Mobile Dev",
    capabilities: ["use_terminal", "control_browser"],
  },
  checks: [{ code: "ok", passed: true }],
  failures: [],
  currentAuthority: [],
  proposedAuthority: ["use_terminal", "control_browser"],
  authorityDelta: { added: ["use_terminal", "control_browser"], removed: [], unchanged: [] },
  auditPreview: { kind: "rbac_role_created", actorId: "a-1", roleId: "r-1", roleSlug: "mobile-dev", capabilities: ["use_terminal", "control_browser"] },
  fingerprint: "v1:abc",
};

const APPLY = { applied: true, auditRecorded: true, fingerprint: "v1:abc" };

describe("access-control-mutation schemas parse canonical shapes", () => {
  test("accessControlOperationSchema parses a role.create", () => {
    const op = accessControlOperationSchema.parse(PREVIEW.operation);
    expect(op.kind).toBe("role.create");
  });

  test("previewResponseSchema parses a full preview", () => {
    const parsed = previewResponseSchema.parse(PREVIEW);
    expect(parsed.ok).toBe(true);
    expect(parsed.authorityDelta?.added).toEqual(["use_terminal", "control_browser"]);
    expect(parsed.auditPreview.kind).toBe("rbac_role_created");
  });

  test("applyResponseSchema parses a success", () => {
    const parsed = applyResponseSchema.parse(APPLY);
    expect(parsed.applied).toBe(true);
    expect(parsed.auditRecorded).toBe(true);
  });

  test("previewResponseSchema parses a deletion consequence", () => {
    const withDel = {
      ...PREVIEW,
      deletionConsequence: {
        targetKind: "group",
        targetId: "g-1",
        targetLabel: "Mobile",
        membersRemoved: 3,
        approvalChallengesRemoved: 2,
        roleAssignmentsRemoved: 1,
      },
    };
    const parsed = previewResponseSchema.parse(withDel);
    expect(parsed.deletionConsequence?.approvalChallengesRemoved).toBe(2);
  });

  test("previewResponseSchema parses a shared-edit affectedUserDeltas array with unchanged", () => {
    const withDeltas = {
      ...PREVIEW,
      affectedUserDeltas: [
        { userId: "u-1", added: ["use_terminal"], removed: ["control_browser"], unchanged: ["use_workstation_profiles"] },
        { userId: "u-2", added: [], removed: ["control_browser"], unchanged: ["use_terminal"] },
      ],
    };
    const parsed = previewResponseSchema.parse(withDeltas);
    expect(parsed.affectedUserDeltas?.length).toBe(2);
    expect(parsed.affectedUserDeltas?.[0]?.unchanged).toEqual(["use_workstation_profiles"]);
  });

  test("accessControlOperationSchema parses a shared_access.create composite", () => {
    const op = accessControlOperationSchema.parse({
      kind: "shared_access.create",
      role: { slug: "qa", label: "QA", capabilities: ["use_terminal"] },
      group: { groupType: "custom:qa", label: "QA", ownerUserId: "u-1" },
      memberUserIds: ["u-2", "u-3"],
    });
    expect(op.kind).toBe("shared_access.create");
  });

  test("accessControlOperationSchema parses a shared_access.assign_existing composite", () => {
    const op = accessControlOperationSchema.parse({
      kind: "shared_access.assign_existing",
      roleSlug: "mobile-dev",
      group: { groupType: "custom:qa", label: "QA", ownerUserId: "u-1" },
      memberUserIds: ["u-2", "u-3"],
    });
    expect(op.kind).toBe("shared_access.assign_existing");
  });
});

describe("access-control-mutation api-client HTTP contract (mocked fetch)", () => {
  let realFetch: typeof fetch;

  beforeEach(() => {
    realFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function mockFetch(
    responder: (url: string, init?: RequestInit) => { body: unknown; status: number },
  ): typeof fetch {
    const mock = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const { body, status } = responder(requestUrl(input), init);
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    };
    return Object.assign(mock, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;
  }

  test("admin.accessControl.previewChange — POST preview", async () => {
    let seenUrl = "";
    let seenMethod = "";
    let seenBody: unknown = null;
    globalThis.fetch = mockFetch((url, init) => {
      seenUrl = url;
      seenMethod = init?.method ?? "GET";
      seenBody = init?.body ? JSON.parse(init.body as string) : null;
      return { body: PREVIEW, status: 200 };
    });
    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    const out = await client.admin.accessControl.previewChange({
      kind: "role.create",
      slug: "mobile-dev",
      label: "Mobile Dev",
      capabilities: ["use_terminal"],
    });
    expect(seenMethod).toBe("POST");
    expect(seenUrl).toBe("http://127.0.0.1:9/api/admin/access-control/changes/preview");
    expect((seenBody as { operation: { kind: string } }).operation.kind).toBe("role.create");
    expect(out.ok).toBe(true);
    expect(out.fingerprint).toBe("v1:abc");
  });

  test("admin.accessControl.applyChange — POST apply success", async () => {
    let seenUrl = "";
    let seenBody: unknown = null;
    globalThis.fetch = mockFetch((url, init) => {
      seenUrl = url;
      seenBody = init?.body ? JSON.parse(init.body as string) : null;
      return { body: APPLY, status: 200 };
    });
    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    const out = await client.admin.accessControl.applyChange(
      { kind: "role.create", slug: "mobile-dev", label: "Mobile Dev", capabilities: ["use_terminal"] },
      "v1:abc",
    );
    expect(seenUrl).toBe("http://127.0.0.1:9/api/admin/access-control/changes/apply");
    expect((seenBody as { fingerprint: string }).fingerprint).toBe("v1:abc");
    expect(out.applied).toBe(true);
    expect(out.auditRecorded).toBe(true);
  });

  test("admin.accessControl.applyChange — 409 stale_preview surfaces as ApiError(409)", async () => {
    globalThis.fetch = mockFetch(() => ({
      body: { code: "stale_preview", reason: "state drifted since preview" },
      status: 409,
    }));
    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    let caught: { status: number; message: string } | null = null;
    try {
      await client.admin.accessControl.applyChange(
        { kind: "role.create", slug: "x", label: "X", capabilities: [] },
        "v1:abc",
      );
    } catch (err) {
      const e = err as ApiError;
      caught = { status: e.status, message: e.message };
    }
    expect(caught).not.toBeNull();
    expect(caught!.status).toBe(409);
    expect(caught!.message).toBe("stale_preview");
  });

  test("admin.accessControl.previewChange — 403 unauthorized surfaces as ApiError", async () => {
    globalThis.fetch = mockFetch(() => ({ body: { error: "Forbidden" }, status: 403 }));
    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    let caught: { status: number } | null = null;
    try {
      await client.admin.accessControl.previewChange({ kind: "role.create", slug: "x", label: "X", capabilities: [] });
    } catch (err) {
      caught = { status: (err as ApiError).status };
    }
    expect(caught).not.toBeNull();
    expect(caught!.status).toBe(403);
  });

  test("admin.accessControl.previewChange — composite shared_access.create posts the composite op", async () => {
    let seenBody: unknown = null;
    globalThis.fetch = mockFetch((_url, init) => {
      seenBody = init?.body ? JSON.parse(init.body as string) : null;
      return { body: PREVIEW, status: 200 };
    });
    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    await client.admin.accessControl.previewChange({
      kind: "shared_access.create",
      role: { slug: "qa", label: "QA", capabilities: ["use_terminal"] },
      group: { groupType: "custom:qa", label: "QA", ownerUserId: "u-1" },
      memberUserIds: ["u-2", "u-3"],
    });
    expect((seenBody as { operation: { kind: string } }).operation.kind).toBe("shared_access.create");
  });

  test("admin.accessControl.previewChange — composite shared_access.assign_existing posts the composite op", async () => {
    let seenBody: unknown = null;
    globalThis.fetch = mockFetch((_url, init) => {
      seenBody = init?.body ? JSON.parse(init.body as string) : null;
      return { body: PREVIEW, status: 200 };
    });
    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    await client.admin.accessControl.previewChange({
      kind: "shared_access.assign_existing",
      roleSlug: "mobile-dev",
      group: { groupType: "custom:qa", label: "QA", ownerUserId: "u-1" },
      memberUserIds: ["u-2", "u-3"],
    });
    expect((seenBody as { operation: { kind: string } }).operation.kind).toBe("shared_access.assign_existing");
  });
});
