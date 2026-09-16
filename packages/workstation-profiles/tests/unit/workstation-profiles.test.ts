import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import {
  compileWorkstationProfile,
  parseWorkstationProfile,
  PROFILE_CAPABILITIES,
  PROFILE_CAPABILITY_BACKENDS,
  PROFILE_DISCOVERY_PROVIDERS,
  WORKSTATION_PROFILE_SCHEMA_VERSION,
  type WorkstationProfile,
  type WorkstationProfileCompileErrorCode,
  type WorkstationProfileValidationErrorCode,
} from "../../src/index";

const NOW = new Date("2030-01-01T00:00:00.000Z");
const PARENT_ROOT = path.join(path.sep, "Users", "alice", "projects");
const BREW_ROOT = path.join(path.sep, "opt", "homebrew");

function rootRule(p: string, access: readonly string[]) {
  return { path: p, access };
}

function toolchainCapability(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "cap-bun",
    kind: "toolchain",
    discoveredFrom: "fixed_argv",
    executable: path.join(path.sep, "Users", "alice", ".bun", "bin", "bun"),
    roots: [rootRule(path.join(path.sep, "Users", "alice", ".bun"), ["read", "create_modify"])],
    environmentKeys: ["BUN_INSTALL"],
    backend: "sandboxed",
    operations: ["run"],
    ...overrides,
  };
}

function validProfile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: WORKSTATION_PROFILE_SCHEMA_VERSION,
    id: "profile-developer-workstation",
    revision: 1,
    name: "Developer Workstation",
    roots: [
      rootRule(PARENT_ROOT, ["read", "create_modify", "delete", "execute"]),
      rootRule(BREW_ROOT, ["read", "create_modify"]),
    ],
    discoveryProviders: ["bun", "homebrew"],
    environmentKeys: ["BUN_INSTALL", "JAVA_HOME"],
    executableRules: [
      {
        id: "exec-bun",
        executable: path.join(path.sep, "Users", "alice", ".bun", "bin", "bun"),
        argv: ["install", "run"],
        backend: "sandboxed",
      },
    ],
    network: { mode: "host", allow: [] },
    capabilities: ["background_processes", "mcp_hosts"],
    toolchainCapabilities: [toolchainCapability()],
    protectedPolicyVersion: 1,
    createdAt: "2030-01-01T00:00:00.000Z",
    updatedAt: "2030-01-02T00:00:00.000Z",
    ...overrides,
  };
}

function parse(value: unknown) {
  return parseWorkstationProfile(value, { now: NOW });
}

function expectRejected(value: unknown, code: WorkstationProfileValidationErrorCode) {
  const result = parse(value);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.code).toBe(code);
}

function validFacts(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    roots: [
      {
        path: path.join(PARENT_ROOT, "my-app"),
        access: ["read", "create_modify"],
        sourceProvider: "bun",
      },
    ],
    environmentKeys: ["BUN_INSTALL"],
    capabilities: [
      {
        id: "cap-bun",
        executable: path.join(path.sep, "Users", "alice", ".bun", "bin", "bun"),
        roots: [
          {
            path: path.join(path.sep, "Users", "alice", ".bun", "cache"),
            access: ["read", "create_modify"],
          },
        ],
        environmentKeys: ["BUN_INSTALL"],
        backend: "sandboxed",
        operations: ["run"],
      },
    ],
    ...overrides,
  };
}

function compile(profile: WorkstationProfile, facts: unknown) {
  return compileWorkstationProfile(profile, facts, { now: NOW });
}

function expectCompileRejected(
  profile: WorkstationProfile,
  facts: unknown,
  code: WorkstationProfileCompileErrorCode,
) {
  const result = compile(profile, facts);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.code).toBe(code);
}

describe("parseWorkstationProfile — valid profiles", () => {
  test("accepts a fully formed developer workstation profile", () => {
    const result = parse(validProfile());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.profile.schemaVersion).toBe(WORKSTATION_PROFILE_SCHEMA_VERSION);
      expect(result.profile.roots).toHaveLength(2);
      expect(result.profile.capabilities).toEqual(["background_processes", "mcp_hosts"]);
      expect(result.profile.toolchainCapabilities[0]?.backend).toBe("sandboxed");
    }
  });

  test("normalizes root paths using host path semantics", () => {
    const rawRoot = path.join(PARENT_ROOT, "..", "projects", "");
    const result = parse(validProfile({ roots: [rootRule(rawRoot, ["read"])] }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.profile.roots[0]?.path).toBe(path.normalize(rawRoot));
  });

  test("accepts a proxy-allowlist network policy with well-formed rules", () => {
    const result = parse(
      validProfile({
        network: {
          mode: "proxy_allowlist",
          allow: [
            { id: "registry", kind: "domain", value: "registry.npmjs.org" },
            { id: "metro", kind: "port", value: "8081" },
            { id: "lab", kind: "cidr", value: "10.0.0.0/8" },
          ],
        },
      }),
    );
    expect(result.ok).toBe(true);
  });

  test("accepts every supported capability flag, backend, and discovery provider", () => {
    for (const capability of PROFILE_CAPABILITIES) {
      expect(parse(validProfile({ capabilities: [capability] })).ok).toBe(true);
    }
    for (const backend of PROFILE_CAPABILITY_BACKENDS) {
      expect(parse(validProfile({ toolchainCapabilities: [toolchainCapability({ backend })] })).ok).toBe(true);
    }
    for (const provider of PROFILE_DISCOVERY_PROVIDERS) {
      expect(parse(validProfile({ discoveryProviders: [provider] })).ok).toBe(true);
    }
  });

  test("accepts typed docker_compose and os_signing capabilities with backend and operations", () => {
    const docker = toolchainCapability({
      id: "cap-compose",
      kind: "docker_compose",
      discoveredFrom: "admin",
      executable: path.join(path.sep, "usr", "local", "bin", "docker"),
      roots: [rootRule(path.join(PARENT_ROOT, "compose"), ["read", "create_modify"])],
      environmentKeys: [],
      backend: "brokered_host_service",
      operations: ["compose_up", "compose_down"],
    });
    const signing = toolchainCapability({
      id: "cap-signing",
      kind: "os_signing",
      discoveredFrom: "admin",
      executable: path.join(path.sep, "usr", "bin", "codesign"),
      roots: [],
      environmentKeys: [],
      backend: "brokered_host_service",
      operations: ["codesign_verify"],
    });
    const result = parse(validProfile({ toolchainCapabilities: [docker, signing] }));
    expect(result.ok).toBe(true);
  });
});

describe("parseWorkstationProfile — schema and identity rejection", () => {
  test("rejects non-record and unknown schema versions", () => {
    expectRejected(null, "invalid_record");
    expectRejected(validProfile({ schemaVersion: 2 }), "unknown_schema_version");
    expectRejected(validProfile({ schemaVersion: "1" }), "unknown_schema_version");
  });

  test("rejects unknown fields to fail closed across schema versions", () => {
    expectRejected(validProfile({ unexpected: true }), "unknown_field");
  });

  test("rejects malformed ids, revisions, and names", () => {
    expectRejected(validProfile({ id: "" }), "invalid_id");
    expectRejected(validProfile({ id: "id\nwith-control" }), "invalid_id");
    expectRejected(validProfile({ revision: 0 }), "invalid_revision");
    expectRejected(validProfile({ revision: 1.5 }), "invalid_revision");
    expectRejected(validProfile({ name: "   " }), "invalid_name");
    expectRejected(validProfile({ name: "name\nbreak" }), "invalid_name");
  });

  test("rejects duplicate environment keys", () => {
    expectRejected(validProfile({ environmentKeys: ["BUN_INSTALL", "BUN_INSTALL"] }), "duplicate_environment_key");
  });

  test("rejects duplicate root paths and duplicate capability ids", () => {
    expectRejected(
      validProfile({ roots: [rootRule(PARENT_ROOT, ["read"]), rootRule(PARENT_ROOT, ["read"])] }),
      "duplicate_root",
    );
    expectRejected(
      validProfile({ toolchainCapabilities: [toolchainCapability(), toolchainCapability()] }),
      "duplicate_toolchain_capability_id",
    );
  });

  test("rejects duplicate executable and network rule ids", () => {
    expectRejected(
      validProfile({
        executableRules: [
          { id: "dup", executable: "a", argv: [], backend: "sandboxed" },
          { id: "dup", executable: "b", argv: [], backend: "sandboxed" },
        ],
      }),
      "duplicate_executable_rule_id",
    );
    expectRejected(
      validProfile({
        network: {
          mode: "proxy_allowlist",
          allow: [
            { id: "dup", kind: "domain", value: "a.example" },
            { id: "dup", kind: "domain", value: "b.example" },
          ],
        },
      }),
      "invalid_network",
    );
  });
});

describe("parseWorkstationProfile — root and path rejection", () => {
  test("rejects relative, traversal, control-byte, and literal filesystem-root paths", () => {
    expectRejected(validProfile({ roots: [rootRule("relative/root", ["read"])] }), "invalid_root_path");
    expectRejected(validProfile({ roots: [rootRule(`${PARENT_ROOT}\0`, ["read"])] }), "invalid_root_path");
    expectRejected(validProfile({ roots: [rootRule(path.sep, ["read"])] }), "invalid_root_path");
  });

  test("rejects malformed root access", () => {
    expectRejected(validProfile({ roots: [rootRule(PARENT_ROOT, [])] }), "invalid_root_path");
    expectRejected(validProfile({ roots: [rootRule(PARENT_ROOT, ["read", "read"])] }), "invalid_root_path");
    expectRejected(validProfile({ roots: [rootRule(PARENT_ROOT, ["read", "write"])] }), "invalid_root_path");
  });
});

describe("parseWorkstationProfile — discovery, network, and capability rejection", () => {
  test("rejects unknown and duplicate discovery provider ids", () => {
    expectRejected(validProfile({ discoveryProviders: ["unknown_provider"] }), "unknown_discovery_provider");
    expectRejected(validProfile({ discoveryProviders: ["bun", "bun"] }), "duplicate_discovery_provider");
  });

  test("rejects bad network modes and malformed network rules", () => {
    expectRejected(validProfile({ network: { mode: "open", allow: [] } }), "invalid_network");
    expectRejected(validProfile({ network: { mode: "proxy_allowlist", allow: [] } }), "invalid_network");
    expectRejected(
      validProfile({
        network: { mode: "proxy_allowlist", allow: [{ id: "p", kind: "port", value: "99999" }] },
      }),
      "invalid_network",
    );
    expectRejected(
      validProfile({
        network: { mode: "proxy_allowlist", allow: [{ id: "p", kind: "port", value: "abc" }] },
      }),
      "invalid_network",
    );
    expectRejected(
      validProfile({
        network: { mode: "proxy_allowlist", allow: [{ id: "c", kind: "cidr", value: "10.0.0.0" }] },
      }),
      "invalid_network",
    );
    expectRejected(
      validProfile({
        network: { mode: "proxy_allowlist", allow: [{ id: "h", kind: "host", value: "has space" }] },
      }),
      "invalid_network",
    );
  });

  test("rejects executable rules missing an explicit backend", () => {
    expectRejected(
      validProfile({ executableRules: [{ id: "exec-x", executable: "x", argv: [] }] }),
      "invalid_executable_rule",
    );
  });

  test("rejects toolchain capabilities missing an explicit backend", () => {
    expectRejected(
      validProfile({ toolchainCapabilities: [toolchainCapability({ backend: "unsandboxed" })] }),
      "missing_capability_backend",
    );
  });

  test("rejects docker_compose and os_signing without typed operation identifiers", () => {
    expectRejected(
      validProfile({ toolchainCapabilities: [toolchainCapability({ id: "c", kind: "docker_compose", operations: [] })] }),
      "missing_capability_backend",
    );
    expectRejected(
      validProfile({ toolchainCapabilities: [toolchainCapability({ id: "c", kind: "os_signing", operations: [] })] }),
      "missing_capability_backend",
    );
  });

  test("rejects escape capabilities expressed as bare profile capability flags", () => {
    expectRejected(validProfile({ capabilities: ["docker_socket"] }), "forbidden_capability");
    expectRejected(validProfile({ capabilities: ["raw_host"] }), "forbidden_capability");
    expectRejected(validProfile({ capabilities: ["unrestricted_host"] }), "forbidden_capability");
    expectRejected(validProfile({ capabilities: ["docker_compose"] }), "forbidden_capability");
    expectRejected(validProfile({ capabilities: ["os_signing"] }), "forbidden_capability");
  });

  test("rejects escape operation identifiers inside typed capabilities", () => {
    expectRejected(
      validProfile({
        toolchainCapabilities: [
          toolchainCapability({ id: "c", kind: "docker_compose", operations: ["docker_socket"] }),
        ],
      }),
      "missing_capability_backend",
    );
    expectRejected(
      validProfile({
        toolchainCapabilities: [
          toolchainCapability({ id: "c", kind: "toolchain", operations: ["unrestricted_host"] }),
        ],
      }),
      "missing_capability_backend",
    );
  });
});

describe("parseWorkstationProfile — timestamps and protected policy version", () => {
  test("rejects malformed and illogical timestamps", () => {
    expectRejected(validProfile({ createdAt: "not-a-date" }), "invalid_created_at");
    expectRejected(validProfile({ createdAt: "2030-01-01T00:00:00+02:00" }), "invalid_created_at");
    expectRejected(validProfile({ updatedAt: "not-a-date" }), "invalid_updated_at");
    expectRejected(
      validProfile({ createdAt: "2030-02-01T00:00:00.000Z", updatedAt: "2030-01-01T00:00:00.000Z" }),
      "invalid_updated_at",
    );
  });

  test("rejects invalid protected policy versions", () => {
    expectRejected(validProfile({ protectedPolicyVersion: 0 }), "invalid_protected_policy_version");
    expectRejected(validProfile({ protectedPolicyVersion: 1.5 }), "invalid_protected_policy_version");
  });
});

test("validated result is assignable to the persisted profile contract", () => {
  const result = parse(validProfile());
  expect(result.ok).toBe(true);
  if (result.ok) {
    const persisted: WorkstationProfile = result.profile;
    expect(persisted.schemaVersion).toBe(WORKSTATION_PROFILE_SCHEMA_VERSION);
  }
});

describe("compileWorkstationProfile — pure compilation", () => {
  test("compiles discovered facts that sit within the bound profile", () => {
    const parsed = parse(validProfile());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const result = compile(parsed.profile, validFacts());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.compiled.profileId).toBe("profile-developer-workstation");
      expect(result.compiled.profileRevision).toBe(1);
      expect(result.compiled.roots).toHaveLength(1);
      expect(result.compiled.environmentKeys).toEqual(["BUN_INSTALL"]);
      expect(result.compiled.capabilities[0]?.backend).toBe("sandboxed");
      expect(result.compiled.compiledAt).toBe("2030-01-01T00:00:00.000Z");
    }
  });

  test("rejects discovered roots outside any profile root rule", () => {
    const parsed = parse(validProfile());
    if (!parsed.ok) return;
    expectCompileRejected(
      parsed.profile,
      validFacts({ roots: [{ path: path.join(path.sep, "etc", "secret"), access: ["read"] }] }),
      "discovered_root_not_allowed",
    );
  });

  test("rejects discovered roots whose access exceeds the profile rule", () => {
    const parsed = parse(validProfile());
    if (!parsed.ok) return;
    expectCompileRejected(
      parsed.profile,
      validFacts({
        roots: [{ path: path.join(BREW_ROOT, "bin"), access: ["read", "delete"] }],
      }),
      "discovered_root_not_allowed",
    );
  });

  test("rejects discovered environment keys not declared by the profile", () => {
    const parsed = parse(validProfile());
    if (!parsed.ok) return;
    expectCompileRejected(
      parsed.profile,
      validFacts({ environmentKeys: ["AWS_SECRET_ACCESS_KEY"] }),
      "discovered_environment_key_not_allowed",
    );
  });

  test("rejects discovered capabilities not declared by the profile", () => {
    const parsed = parse(validProfile());
    if (!parsed.ok) return;
    expectCompileRejected(
      parsed.profile,
      validFacts({
        capabilities: [
          {
            id: "cap-unknown",
            executable: "x",
            roots: [{ path: path.join(PARENT_ROOT, "x"), access: ["read"] }],
            environmentKeys: ["BUN_INSTALL"],
            backend: "sandboxed",
            operations: ["run"],
          },
        ],
      }),
      "discovered_capability_not_allowed",
    );
  });

  test("rejects a discovered capability backend that mismatches the profile", () => {
    const parsed = parse(validProfile());
    if (!parsed.ok) return;
    expectCompileRejected(
      parsed.profile,
      validFacts({
        capabilities: [
          {
            id: "cap-bun",
            executable: path.join(path.sep, "Users", "alice", ".bun", "bin", "bun"),
            roots: [{ path: path.join(path.sep, "Users", "alice", ".bun", "cache"), access: ["read"] }],
            environmentKeys: ["BUN_INSTALL"],
            backend: "brokered_host_service",
            operations: ["run"],
          },
        ],
      }),
      "discovered_capability_backend_mismatch",
    );
  });

  test("rejects discovered capability operations not declared by the profile", () => {
    const parsed = parse(validProfile());
    if (!parsed.ok) return;
    expectCompileRejected(
      parsed.profile,
      validFacts({
        capabilities: [
          {
            id: "cap-bun",
            executable: path.join(path.sep, "Users", "alice", ".bun", "bin", "bun"),
            roots: [{ path: path.join(path.sep, "Users", "alice", ".bun", "cache"), access: ["read"] }],
            environmentKeys: ["BUN_INSTALL"],
            backend: "sandboxed",
            operations: ["run", "install"],
          },
        ],
      }),
      "discovered_capability_operation_not_allowed",
    );
  });

  test("rejects malformed discovered facts rather than silently compiling", () => {
    const parsed = parse(validProfile());
    if (!parsed.ok) return;
    expectCompileRejected(parsed.profile, { roots: "not-an-array" }, "invalid_discovered_facts");
    expectCompileRejected(
      parsed.profile,
      validFacts({ roots: [{ path: "relative", access: ["read"] }] }),
      "invalid_discovered_facts",
    );
    expectCompileRejected(
      parsed.profile,
      validFacts({
        capabilities: [
          {
            id: "cap-bun",
            executable: "x",
            roots: [{ path: path.join(PARENT_ROOT, "x"), access: ["read"] }],
            environmentKeys: ["BUN_INSTALL"],
            backend: "sandboxed",
            operations: ["docker_socket"],
          },
        ],
      }),
      "invalid_discovered_facts",
    );
  });

  test("does not mutate the bound profile", () => {
    const parsed = parse(validProfile());
    if (!parsed.ok) return;
    const before = JSON.stringify(parsed.profile);
    compile(parsed.profile, validFacts());
    expect(JSON.stringify(parsed.profile)).toBe(before);
  });
});
