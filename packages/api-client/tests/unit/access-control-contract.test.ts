/**
 * Stack 195 / W3.1.2 — HTTP contract + Zod shape coverage for the typed
 * access-control api-client methods. Mocked fetch (no network).
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { NautiloApiClient } from "../../src/client";
import {
  accessControlCatalogueSchema,
  accessControlHumanListSchema,
  effectiveAccessResponseSchema,
} from "../../src/schemas/access-control";

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  return typeof input === "string" ? input : (input as URL).toString();
}

const PROVENANCE = {
  groupId: "g-1",
  groupType: "members",
  groupLabel: "Members",
  groupIsSystem: true,
  groupOwnerId: null,
  roleSlug: "member",
  roleLabel: "Member",
  roleIsSystem: true,
};

const EFFECTIVE_ACCESS = {
  user: { id: "u-1", handle: "ada", displayName: "Ada", server: null },
  highestRole: "member",
  capabilities: [
    {
      slug: "use_workstation_profiles",
      description: "Activate a profile",
      category: "devices",
      granted: true,
      provenance: [PROVENANCE],
    },
    {
      slug: "control_desktop",
      description: "Desktop",
      category: "devices",
      granted: false,
      provenance: [],
    },
  ],
  groups: [
    { id: "g-1", type: "members", label: "Members", isSystem: true, ownerId: null, roleSlugs: ["member"] },
  ],
  roles: [{ slug: "member", label: "Member", isSystem: true, capabilitySlugs: ["use_workstation_profiles"] }],
  groupRoleFacts: [
    {
      groupId: "g-1",
      groupType: "members",
      groupLabel: "Members",
      groupIsSystem: true,
      groupOwnerId: null,
      roleSlug: "member",
      roleLabel: "Member",
      roleIsSystem: true,
      capabilitySlugs: ["use_workstation_profiles"],
    },
  ],
};

const CATALOGUE = {
  capabilities: [
    { slug: "use_workstation_profiles", description: "Activate a profile", category: "devices" },
  ],
  roles: [
    {
      id: "r-1",
      slug: "member",
      label: "Member",
      isSystem: true,
      capabilitySlugs: ["use_workstation_profiles"],
      groupCount: 1,
    },
  ],
  groups: [
    {
      id: "g-1",
      type: "members",
      label: "Members",
      isSystem: true,
      ownerId: null,
      roleSlugs: ["member"],
      memberCount: 3,
    },
  ],
};

describe("access-control schemas parse canonical shapes", () => {
  test("effectiveAccessResponseSchema parses a full response", () => {
    const parsed = effectiveAccessResponseSchema.parse(EFFECTIVE_ACCESS);
    expect(parsed.highestRole).toBe("member");
    expect(parsed.capabilities).toHaveLength(2);
    expect(parsed.capabilities[0]!.provenance).toHaveLength(1);
  });

  test("accessControlCatalogueSchema parses a full catalogue", () => {
    const parsed = accessControlCatalogueSchema.parse(CATALOGUE);
    expect(parsed.roles[0]!.groupCount).toBe(1);
    expect(parsed.groups[0]!.memberCount).toBe(3);
  });

  test("accessControlHumanListSchema parses a minimal human directory", () => {
    const HUMANS = [
      { userId: "u-1", displayName: "Ada Lovelace", handle: "ada" },
      { userId: "u-2", displayName: "Bob", handle: null },
    ];
    const parsed = accessControlHumanListSchema.parse(HUMANS);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]!.userId).toBe("u-1");
    expect(parsed[0]!.displayName).toBe("Ada Lovelace");
    expect(parsed[0]!.handle).toBe("ada");
    expect(parsed[1]!.handle).toBeNull();
  });

  test("accessControlHumanListSchema strips any unexpected extras to the three safe fields", () => {
    // Defense-in-depth: even if a buggy server leaked email / external IDs
    // / disabled metadata, the parsed client result surfaces only the
    // three selection fields — sensitive extras never reach consumers.
    const leaky = [
      {
        userId: "u-1",
        displayName: "Ada",
        handle: "ada",
        email: "ada@test.local",
        externalId: "logto-sub",
        disabledAt: null,
      },
    ];
    const parsed = accessControlHumanListSchema.parse(leaky);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!).toEqual({
      userId: "u-1",
      displayName: "Ada",
      handle: "ada",
    });
  });

  test("schemas tolerate unknown future capability slugs", () => {
    const withFuture = {
      ...EFFECTIVE_ACCESS,
      capabilities: [
        ...EFFECTIVE_ACCESS.capabilities,
        {
          slug: "future_cap",
          description: "Future",
          category: "tools",
          granted: true,
          provenance: [
            { ...PROVENANCE, roleSlug: "future-role", roleIsSystem: false },
          ],
        },
      ],
    };
    expect(() => effectiveAccessResponseSchema.parse(withFuture)).not.toThrow();
  });

  test("schemas retain Community and provider-key capabilities", () => {
    const parsed = effectiveAccessResponseSchema.parse({
      ...EFFECTIVE_ACCESS,
      highestRole: "community",
      capabilities: [
        { slug: "invoke_other_agents", description: "Invoke other agents", category: "agents", granted: false, provenance: [] },
        { slug: "use_personal_provider_credentials", description: "Use personal credentials", category: "providers", granted: true, provenance: [] },
        { slug: "use_server_provider_credentials", description: "Use server credentials", category: "providers", granted: false, provenance: [] },
      ],
    });

    expect(parsed.highestRole).toBe("community");
    expect(parsed.capabilities.map((capability) => capability.slug)).toEqual([
      "invoke_other_agents",
      "use_personal_provider_credentials",
      "use_server_provider_credentials",
    ]);
  });
});

describe("access-control api-client HTTP contract (mocked fetch)", () => {
  let realFetch: typeof fetch;

  beforeEach(() => {
    realFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function mockFetch(
    responder: (
      url: string,
      init?: RequestInit,
    ) => { url: string; body: unknown; status: number },
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

  test("accessControl.getMyEffectiveAccess — GET self endpoint", async () => {
    let seenUrl = "";
    let seenMethod = "";
    globalThis.fetch = mockFetch((url, init) => {
      seenUrl = url;
      seenMethod = init?.method ?? "GET";
      return { url, body: EFFECTIVE_ACCESS, status: 200 };
    });

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    const out = await client.accessControl.getMyEffectiveAccess();
    expect(seenMethod).toBe("GET");
    expect(seenUrl).toBe("http://127.0.0.1:9/api/access-control/me/effective-access");
    expect(out.highestRole).toBe("member");
    expect(out.capabilities).toHaveLength(2);
  });

  test("admin.accessControl.getEffectiveAccess — GET target user endpoint", async () => {
    let seenUrl = "";
    globalThis.fetch = mockFetch((url) => {
      seenUrl = url;
      return { url, body: EFFECTIVE_ACCESS, status: 200 };
    });

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    const out = await client.admin.accessControl.getEffectiveAccess("u-target");
    expect(seenUrl).toBe(
      "http://127.0.0.1:9/api/admin/access-control/users/u-target/effective-access",
    );
    expect(out.user.id).toBe("u-1");
  });

  test("admin.accessControl.getEffectiveAccess — 404 unknown target surfaces as ApiError", async () => {
    globalThis.fetch = mockFetch(() => ({
      url: "",
      body: { error: "user_not_found" },
      status: 404,
    }));

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    let caught: { status: number; message: string } | null = null;
    try {
      await client.admin.accessControl.getEffectiveAccess("unknown");
    } catch (err) {
      const e = err as { status: number; message: string };
      caught = { status: e.status, message: e.message };
    }
    expect(caught).not.toBeNull();
    expect(caught!.status).toBe(404);
  });

  test("admin.accessControl.getCatalogue — GET catalogue endpoint", async () => {
    let seenUrl = "";
    globalThis.fetch = mockFetch((url) => {
      seenUrl = url;
      return { url, body: CATALOGUE, status: 200 };
    });

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    const out = await client.admin.accessControl.getCatalogue();
    expect(seenUrl).toBe("http://127.0.0.1:9/api/admin/access-control/catalogue");
    expect(out.capabilities).toHaveLength(1);
    expect(out.roles[0]!.groupCount).toBe(1);
    expect(out.groups[0]!.memberCount).toBe(3);
  });

  test("admin.accessControl.getCatalogue — 403 unauthorized surfaces as ApiError", async () => {
    globalThis.fetch = mockFetch(() => ({
      url: "",
      body: { error: "Forbidden" },
      status: 403,
    }));

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    let caught: { status: number } | null = null;
    try {
      await client.admin.accessControl.getCatalogue();
    } catch (err) {
      caught = { status: (err as { status: number }).status };
    }
    expect(caught).not.toBeNull();
    expect(caught!.status).toBe(403);
  });

  test("admin.accessControl.listHumans — GET human directory endpoint", async () => {
    let seenUrl = "";
    let seenMethod = "";
    globalThis.fetch = mockFetch((url, init) => {
      seenUrl = url;
      seenMethod = init?.method ?? "GET";
      return {
        url,
        body: [
          { userId: "u-1", displayName: "Ada Lovelace", handle: "ada" },
          { userId: "u-2", displayName: "Bob", handle: null },
        ],
        status: 200,
      };
    });

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    const out = await client.admin.accessControl.listHumans();
    expect(seenMethod).toBe("GET");
    expect(seenUrl).toBe("http://127.0.0.1:9/api/admin/access-control/users");
    expect(out).toHaveLength(2);
    expect(out[0]!.userId).toBe("u-1");
    expect(out[0]!.displayName).toBe("Ada Lovelace");
    expect(out[0]!.handle).toBe("ada");
    expect(out[1]!.handle).toBeNull();
  });

  test("admin.accessControl.listHumans — 403 unauthorized surfaces as ApiError", async () => {
    globalThis.fetch = mockFetch(() => ({
      url: "",
      body: { error: "Forbidden" },
      status: 403,
    }));

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    let caught: { status: number } | null = null;
    try {
      await client.admin.accessControl.listHumans();
    } catch (err) {
      caught = { status: (err as { status: number }).status };
    }
    expect(caught).not.toBeNull();
    expect(caught!.status).toBe(403);
  });

  test("admin.accessControl.listHumans — 401 anonymous surfaces as ApiError", async () => {
    globalThis.fetch = mockFetch(() => ({
      url: "",
      body: { error: "Unauthorized" },
      status: 401,
    }));

    const client = new NautiloApiClient("http://127.0.0.1:9");
    let caught: { status: number } | null = null;
    try {
      await client.admin.accessControl.listHumans();
    } catch (err) {
      caught = { status: (err as { status: number }).status };
    }
    expect(caught).not.toBeNull();
    expect(caught!.status).toBe(401);
  });
});
