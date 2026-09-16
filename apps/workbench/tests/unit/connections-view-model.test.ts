import { describe, expect, test } from "bun:test";
import {
  buildConfigPayload,
  buildCreatePayload,
  buildTransport,
  canCreateMcp,
  computeNextExcludeTools,
  creatableTiers,
  describeServer,
  deriveRelayId,
  emptyForm,
  groupServers,
  healthDot,
  hostTier,
  joinCommaList,
  localCreateHint,
  parseCommaList,
  relayHostForId,
  relayIdFromHost,
  resolveHost,
  resolveRelayId,
  rowDisplay,
  scopeLabel,
  scopeDescription,
  serverTier,
  serverToConfig,
  serverToForm,
  sortServers,
  toolEnabled,
  transportLabel,
  type ConnectionFormValues,
} from "../../src/pages/connections/connections-view-model";
import type { McpServer } from "../../src/lib/mcp-servers-api";

function server(overrides: Partial<McpServer> & Pick<McpServer, "name">): McpServer {
  return {
    id: "id-1",
    host: "server",
    transportKind: "stdio",
    transport: {},
    envPassthrough: null,
    envLiteral: null,
    authRef: null,
    namespaceId: null,
    includeTools: null,
    excludeTools: null,
    enabled: false,
    trustTier: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

function form(overrides: Partial<ConnectionFormValues> = {}): ConnectionFormValues {
  return { ...emptyForm(), ...overrides };
}

describe("parseCommaList / joinCommaList round-trip", () => {
  test("parses, trims, and drops empties", () => {
    expect(parseCommaList("a, b ,, c ")).toEqual(["a", "b", "c"]);
  });

  test("empty / whitespace input → empty array", () => {
    expect(parseCommaList("")).toEqual([]);
    expect(parseCommaList("   ")).toEqual([]);
    expect(parseCommaList(" , , ")).toEqual([]);
  });

  test("join renders array back to a comma string", () => {
    expect(joinCommaList(["a", "b", "c"])).toBe("a, b, c");
    expect(joinCommaList(null)).toBe("");
    expect(joinCommaList(undefined)).toBe("");
  });

  test("round-trips array → string → array", () => {
    const arr = ["GITHUB_TOKEN", "API_KEY"];
    expect(parseCommaList(joinCommaList(arr))).toEqual(arr);
  });
});

describe("buildTransport", () => {
  test("stdio → command + args (args parsed from comma list)", () => {
    expect(
      buildTransport("stdio", { command: " npx ", args: "-y, pkg", url: "ignored" }),
    ).toEqual({ command: "npx", args: ["-y", "pkg"] });
  });

  test("stdio with no args → empty args array", () => {
    expect(buildTransport("stdio", { command: "run", args: "", url: "" })).toEqual({
      command: "run",
      args: [],
    });
  });

  test("streamable-http → url only (trimmed), no command/args", () => {
    expect(
      buildTransport("streamable-http", {
        command: "x",
        args: "a,b",
        url: " https://mcp.example.com ",
      }),
    ).toEqual({ url: "https://mcp.example.com" });
  });

  test("sse-legacy → url only", () => {
    expect(
      buildTransport("sse-legacy", { command: "", args: "", url: "https://sse.example.com" }),
    ).toEqual({ url: "https://sse.example.com" });
  });
});

describe("buildConfigPayload", () => {
  test("stdio config with namespace and tool lists", () => {
    const payload = buildConfigPayload(
      form({
        transportKind: "stdio",
        command: "npx",
        args: "-y, server",
        envPassthrough: "TOKEN",
        namespaceId: " work ",
        includeTools: "read, write",
        excludeTools: "danger",
        trustTier: "high",
      }),
    );
    expect(payload).toEqual({
      transportKind: "stdio",
      transport: { command: "npx", args: ["-y", "server"] },
      envPassthrough: ["TOKEN"],
      namespaceId: "work",
      includeTools: ["read", "write"],
      excludeTools: ["danger"],
      trustTier: "high",
      // default form tier is official → host "server"
      host: "server",
    });
  });

  test("blank namespace → null (global)", () => {
    expect(buildConfigPayload(form({ namespaceId: "   " })).namespaceId).toBeNull();
    expect(buildConfigPayload(form()).namespaceId).toBeNull();
  });

  test("http config uses url and omits command/args", () => {
    const payload = buildConfigPayload(
      form({ transportKind: "streamable-http", url: "https://x.dev" }),
    );
    expect(payload.transport).toEqual({ url: "https://x.dev" });
  });
});

describe("buildCreatePayload", () => {
  test("includes trimmed name and omits enabled/host", () => {
    const payload = buildCreatePayload(
      form({ name: "  github  ", transportKind: "stdio", command: "npx" }),
    );
    expect(payload.name).toBe("github");
    expect("enabled" in payload).toBe(false);
    // Official tier resolves to an explicit host="server" (D384).
    expect(payload.host).toBe("server");
    expect(payload.transportKind).toBe("stdio");
  });
});

describe("serverToForm", () => {
  test("derives editable form values from a server row", () => {
    const s = server({
      name: "gh",
      transportKind: "stdio",
      transport: { command: "npx", args: ["-y", "srv"] },
      envPassthrough: ["TOKEN"],
      namespaceId: "work",
      includeTools: ["read"],
      excludeTools: null,
      trustTier: "high",
    });
    expect(serverToForm(s)).toEqual({
      name: "gh",
      tier: "official",
      transportKind: "stdio",
      command: "npx",
      args: "-y, srv",
      url: "",
      envPassthrough: "TOKEN",
      namespaceId: "work",
      includeTools: "read",
      excludeTools: "",
      trustTier: "high",
    });
  });

  test("unknown trust tier falls back to standard", () => {
    expect(serverToForm(server({ name: "x", trustTier: "bogus" })).trustTier).toBe(
      "standard",
    );
    expect(serverToForm(server({ name: "y", trustTier: null })).trustTier).toBe(
      "standard",
    );
  });
});

describe("transportLabel / scopeLabel", () => {
  test("transport labels", () => {
    expect(transportLabel("stdio")).toBe("stdio");
    expect(transportLabel("streamable-http")).toBe("HTTP");
    expect(transportLabel("sse-legacy")).toBe("SSE");
  });

  test("scope label is 'global' when namespace is null", () => {
    expect(scopeLabel(null)).toBe("global");
    expect(scopeLabel("work")).toBe("work");
  });
});

describe("rowDisplay", () => {
  test("derives label, scope and enabled state (global when null)", () => {
    expect(
      rowDisplay(
        server({ name: "a", transportKind: "streamable-http", namespaceId: null, enabled: true }),
      ),
    ).toEqual({
      name: "a",
      transportLabel: "HTTP",
      scopeLabel: "global",
      scopeDescription: scopeDescription(null),
      enabled: true,
    });
  });

  test("scoped + disabled row", () => {
    expect(
      rowDisplay(server({ name: "b", transportKind: "stdio", namespaceId: "ns", enabled: false })),
    ).toEqual({
      name: "b",
      transportLabel: "stdio",
      scopeLabel: "ns",
      scopeDescription: scopeDescription("ns"),
      enabled: false,
    });
  });
});

describe("scopeDescription (UI5)", () => {
  test("null namespace → global, mentions every namespace", () => {
    const d = scopeDescription(null);
    expect(d).toContain("Global");
    expect(d.toLowerCase()).toContain("every");
  });
  test("set namespace → namespace-scoped, mentions the subset rule", () => {
    const d = scopeDescription("ns-a");
    expect(d).toContain("Namespace-scoped");
    expect(d.toLowerCase()).toContain("subset");
  });
  test("differs between global and scoped", () => {
    expect(scopeDescription(null)).not.toEqual(scopeDescription("ns-a"));
  });
});

describe("sortServers", () => {
  test("sorts alphabetically, case-insensitive, without mutating input", () => {
    const input = [server({ name: "Zeta" }), server({ name: "alpha" }), server({ name: "Beta" })];
    const out = sortServers(input);
    expect(out.map((s) => s.name)).toEqual(["alpha", "Beta", "Zeta"]);
    expect(input.map((s) => s.name)).toEqual(["Zeta", "alpha", "Beta"]);
  });
});

describe("host tier derivation (D384)", () => {
  test("hostTier: server → official, relay-* → local", () => {
    expect(hostTier("server")).toBe("official");
    expect(hostTier("relay-jordan-mbp")).toBe("local");
    expect(hostTier("anything-else")).toBe("official");
  });

  test("serverTier reads the row's host", () => {
    expect(serverTier(server({ name: "a", host: "server" }))).toBe("official");
    expect(serverTier(server({ name: "b", host: "relay-x" }))).toBe("local");
  });

  test("relayHostForId / relayIdFromHost round-trip", () => {
    expect(relayHostForId("jordan-mbp")).toBe("relay-jordan-mbp");
    expect(relayIdFromHost("relay-jordan-mbp")).toBe("jordan-mbp");
    expect(relayIdFromHost("server")).toBeNull();
  });

  test("deriveRelayId returns first local relay id, else null", () => {
    expect(
      deriveRelayId([
        server({ name: "a", host: "server" }),
        server({ name: "b", host: "relay-alex-mbp" }),
      ]),
    ).toBe("alex-mbp");
    expect(deriveRelayId([server({ name: "a", host: "server" })])).toBeNull();
    expect(deriveRelayId([])).toBeNull();
  });

  test("resolveRelayId prefers live endpoint, falls back to derive", () => {
    const servers = [
      server({ name: "a", host: "server" }),
      server({ name: "b", host: "relay-derived" }),
    ];
    expect(resolveRelayId("live-relay", servers)).toBe("live-relay");
    expect(resolveRelayId(null, servers)).toBe("derived");
    expect(resolveRelayId("", servers)).toBe("derived");
    expect(resolveRelayId(null, [])).toBeNull();
  });

  test("resolveHost: official→server; local needs a relay id", () => {
    expect(resolveHost("official", null)).toBe("server");
    expect(resolveHost("official", "x")).toBe("server");
    expect(resolveHost("local", "alex-mbp")).toBe("relay-alex-mbp");
    expect(resolveHost("local", null)).toBeNull();
  });
});

describe("groupServers", () => {
  test("splits into official/local, each sorted, ignores unknowns", () => {
    const grouped = groupServers([
      server({ name: "Zeta", host: "server" }),
      server({ name: "apple", host: "relay-mbp" }),
      server({ name: "beta", host: "server" }),
      server({ name: "notes", host: "relay-mbp" }),
    ]);
    expect(grouped.official.map((s) => s.name)).toEqual(["beta", "Zeta"]);
    expect(grouped.local.map((s) => s.name)).toEqual(["apple", "notes"]);
  });
});

describe("healthDot (UI6)", () => {
  test("maps known health states to a color", () => {
    expect(healthDot("connected")?.color).toBe("var(--success)");
    expect(healthDot("disconnected")?.color).toBe("var(--foreground-dim)");
    expect(healthDot("error")?.color).toBe("var(--error)");
    expect(healthDot("circuit-open")?.color).toBe("var(--warning)");
  });

  test("each known state carries a human label", () => {
    expect(healthDot("connected")?.label).toBe("Connected");
    expect(healthDot("circuit-open")?.label.toLowerCase()).toContain("circuit");
  });

  test("unknown/missing → null (graceful degrade, no dot)", () => {
    expect(healthDot("unknown")).toBeNull();
    expect(healthDot(null)).toBeNull();
    expect(healthDot(undefined)).toBeNull();
  });
});

describe("describeServer", () => {
  test("stdio → command + args", () => {
    expect(
      describeServer(
        server({ name: "x", transportKind: "stdio", transport: { command: "npx", args: ["-y", "srv"] } }),
      ),
    ).toBe("npx -y srv");
  });

  test("stdio with no command → generic fallback", () => {
    expect(
      describeServer(server({ name: "x", transportKind: "stdio", transport: {} })),
    ).toBe("Local stdio MCP server");
  });

  test("http → url (or fallback)", () => {
    expect(
      describeServer(
        server({ name: "x", transportKind: "streamable-http", transport: { url: "https://mcp.dev" } }),
      ),
    ).toBe("https://mcp.dev");
    expect(
      describeServer(server({ name: "x", transportKind: "streamable-http", transport: {} })),
    ).toBe("HTTP MCP server");
  });
});

describe("per-tool enable/disable (UI7)", () => {
  test("toolEnabled = not in excludeTools", () => {
    expect(toolEnabled("read", ["write"])).toBe(true);
    expect(toolEnabled("write", ["write"])).toBe(false);
    expect(toolEnabled("read", null)).toBe(true);
    expect(toolEnabled("read", undefined)).toBe(true);
  });

  test("computeNextExcludeTools: disable adds, enable removes (deduped)", () => {
    expect(computeNextExcludeTools([], "danger", false)).toEqual(["danger"]);
    expect(computeNextExcludeTools(["danger"], "danger", true)).toEqual([]);
    expect(computeNextExcludeTools(["danger"], "danger", false)).toEqual(["danger"]);
    expect(computeNextExcludeTools(null, "x", false)).toEqual(["x"]);
    expect(computeNextExcludeTools(["a", "b"], "c", false)).toEqual(["a", "b", "c"]);
  });
});

describe("serverToConfig", () => {
  test("maps a row back into a PUT config, coercing nulls to arrays", () => {
    const s = server({
      name: "gh",
      host: "relay-mbp",
      transportKind: "stdio",
      transport: { command: "npx", args: ["-y"] },
      envPassthrough: ["TOKEN"],
      namespaceId: "work",
      includeTools: null,
      excludeTools: ["danger"],
      trustTier: "high",
    });
    expect(serverToConfig(s)).toEqual({
      transportKind: "stdio",
      transport: { command: "npx", args: ["-y"] },
      envPassthrough: ["TOKEN"],
      namespaceId: "work",
      includeTools: [],
      excludeTools: ["danger"],
      trustTier: "high",
      host: "relay-mbp",
    });
  });
});

describe("creatableTiers / canCreateMcp (D384 5.5.3)", () => {
  test("admin + relay → both tiers", () => {
    expect(
      creatableTiers({ canManageOfficial: true, relayId: "mbp" }),
    ).toEqual(["official", "local"]);
    expect(canCreateMcp({ canManageOfficial: true, relayId: "mbp" })).toBe(true);
  });

  test("non-admin + relay → local only", () => {
    expect(
      creatableTiers({ canManageOfficial: false, relayId: "mbp" }),
    ).toEqual(["local"]);
    expect(canCreateMcp({ canManageOfficial: false, relayId: "mbp" })).toBe(true);
  });

  test("admin + no relay → official only", () => {
    expect(
      creatableTiers({ canManageOfficial: true, relayId: null }),
    ).toEqual(["official"]);
    expect(canCreateMcp({ canManageOfficial: true, relayId: null })).toBe(true);
  });

  test("non-admin + no relay → none", () => {
    expect(
      creatableTiers({ canManageOfficial: false, relayId: null }),
    ).toEqual([]);
    expect(canCreateMcp({ canManageOfficial: false, relayId: null })).toBe(false);
  });
});

describe("localCreateHint", () => {
  test("with relay → local-run hint", () => {
    expect(localCreateHint("mbp")).toContain("via your relay");
  });

  test("without relay → connect relay hint", () => {
    expect(localCreateHint(null)).toContain("Connect your relay");
    expect(localCreateHint(null)).toContain("nautilo-relay");
  });
});

describe("tier in form + payload host", () => {
  test("emptyForm defaults to official tier", () => {
    expect(emptyForm().tier).toBe("official");
  });

  test("serverToForm derives tier from host", () => {
    expect(serverToForm(server({ name: "a", host: "server" })).tier).toBe("official");
    expect(serverToForm(server({ name: "b", host: "relay-mbp" })).tier).toBe("local");
  });

  test("buildConfigPayload: official → host 'server'", () => {
    expect(buildConfigPayload(form({ tier: "official" })).host).toBe("server");
  });

  test("buildConfigPayload: local with relay id → relay-<id>", () => {
    expect(buildConfigPayload(form({ tier: "local" }), "alex-mbp").host).toBe(
      "relay-alex-mbp",
    );
  });

  test("buildConfigPayload: local without relay id → host omitted", () => {
    expect("host" in buildConfigPayload(form({ tier: "local" }), null)).toBe(false);
  });

  test("buildCreatePayload carries name + resolved host", () => {
    const payload = buildCreatePayload(
      form({ name: " notes ", tier: "local" }),
      "alex-mbp",
    );
    expect(payload.name).toBe("notes");
    expect(payload.host).toBe("relay-alex-mbp");
  });
});
