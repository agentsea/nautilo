import { describe, expect, test } from "bun:test";
import {
  RELAY_WORKSTATION_SHELL_BINDING_VERSION,
  RELAY_WORKSTATION_SHELL_BINDING_EXECUTION_CLASS,
  parseRelayWorkstationShellBinding,
  type RelayDispatchMessage,
  type RelayWorkstationShellBinding,
} from "../../src/protocol";

const BINDING: RelayWorkstationShellBinding = {
  version: RELAY_WORKSTATION_SHELL_BINDING_VERSION,
  toolCallId: "tc-run_shell",
  relayId: "relay-1",
  desktopSessionId: "desktop-1",
  serverBindingId: "server-binding-1",
  pairingGeneration: "pairing-1",
  profileId: "profile-1",
  profileRevision: 3,
  grantIds: ["grant-1", "grant-2"],
  capabilityRevision: 7,
  currentFolder: "/Users/test/project",
  grantRevision: 11,
  protectedPolicyVersion: 4,
  subject: {
    userId: "user-1",
    instanceId: "instance-1",
    relayId: "relay-1",
    agentScope: "all_owned_agents",
  },
  operation: "execute",
  executionClass: RELAY_WORKSTATION_SHELL_BINDING_EXECUTION_CLASS,
};

describe("D440 Phase 1 — workstation shell-binding protocol v2", () => {
  test("parses the strict v2 revision-coherent shell binding", () => {
    expect(RELAY_WORKSTATION_SHELL_BINDING_VERSION).toBe(2);
    expect(RELAY_WORKSTATION_SHELL_BINDING_EXECUTION_CLASS).toBe("profile_bound_sandbox");
    expect(parseRelayWorkstationShellBinding(BINDING)).toEqual({ ok: true, binding: BINDING });
  });

  test("carries only opaque ids / binding / operation metadata — no roots or paths", () => {
    const dispatch: RelayDispatchMessage = {
      type: "relay:dispatch",
      correlationId: "corr-1",
      toolName: "run_shell",
      args: { command: "echo hi" },
      impact: "high",
      approvalObtained: true,
      allowedRoots: ["/untrusted-server-root"],
      workstationShellBinding: BINDING,
    };

    expect(dispatch.workstationShellBinding).toEqual(BINDING);
    // allowedRoots rides alongside but is never authority for the binding.
    expect(dispatch.allowedRoots).toEqual(["/untrusted-server-root"]);
    expect(Object.keys(BINDING).sort()).toEqual([
      "capabilityRevision",
      "currentFolder",
      "desktopSessionId",
      "executionClass",
      "grantIds",
      "grantRevision",
      "operation",
      "pairingGeneration",
      "profileId",
      "profileRevision",
      "protectedPolicyVersion",
      "relayId",
      "serverBindingId",
      "subject",
      "toolCallId",
      "version",
    ]);
    // No root/path/filesystem-identity field exists on the binding.
    expect(BINDING).not.toHaveProperty("requestedRoot");
    expect(BINDING).not.toHaveProperty("roots");
    expect(BINDING).not.toHaveProperty("canonicalRoot");
  });

  test("fails closed for unknown versions and unsupported fields", () => {
    expect(
      parseRelayWorkstationShellBinding({ ...BINDING, version: 1 }),
    ).toMatchObject({ ok: false });
    expect(
      parseRelayWorkstationShellBinding({
        ...BINDING,
        requestedRoot: "/must-never-cross-the-wire",
      }),
    ).toMatchObject({ ok: false });
    expect(
      parseRelayWorkstationShellBinding({
        ...BINDING,
        platformAuthorization: "must-never-cross-the-wire",
      }),
    ).toMatchObject({ ok: false });
  });

  test("fails closed for malformed subject, ids, revisions, and grant ids", () => {
    expect(
      parseRelayWorkstationShellBinding({ ...BINDING, relayId: "" }),
    ).toMatchObject({ ok: false });
    expect(
      parseRelayWorkstationShellBinding({ ...BINDING, desktopSessionId: "" }),
    ).toMatchObject({ ok: false });
    expect(
      parseRelayWorkstationShellBinding({ ...BINDING, profileRevision: 0 }),
    ).toMatchObject({ ok: false });
    expect(
      parseRelayWorkstationShellBinding({ ...BINDING, capabilityRevision: -1 }),
    ).toMatchObject({ ok: false });
    expect(
      parseRelayWorkstationShellBinding({ ...BINDING, currentFolder: "relative/project" }),
    ).toMatchObject({ ok: false });
    expect(
      parseRelayWorkstationShellBinding({ ...BINDING, grantRevision: -1 }),
    ).toMatchObject({ ok: false });
    expect(
      parseRelayWorkstationShellBinding({ ...BINDING, protectedPolicyVersion: 0 }),
    ).toMatchObject({ ok: false });
    expect(
      parseRelayWorkstationShellBinding({ ...BINDING, grantIds: ["grant-1", "grant-1"] }),
    ).toMatchObject({ ok: false });
    expect(
      parseRelayWorkstationShellBinding({ ...BINDING, grantIds: [] }),
    ).toMatchObject({ ok: false });
    expect(
      parseRelayWorkstationShellBinding({
        ...BINDING,
        subject: { ...BINDING.subject, agentScope: "" },
      }),
    ).toMatchObject({ ok: false });
    // D418 Commit 2 — the server-derived pairingGeneration is a mandatory
    // binding field; an empty / missing value fails closed.
    expect(
      parseRelayWorkstationShellBinding({ ...BINDING, pairingGeneration: "" }),
    ).toMatchObject({ ok: false });
    const { pairingGeneration: _omitted, ...withoutPairing } = BINDING;
    expect(
      parseRelayWorkstationShellBinding(withoutPairing),
    ).toMatchObject({ ok: false });
    for (const field of [
      "currentFolder",
      "grantRevision",
      "protectedPolicyVersion",
    ] as const) {
      const copy = { ...BINDING } as Record<string, unknown>;
      delete copy[field];
      expect(parseRelayWorkstationShellBinding(copy)).toMatchObject({ ok: false });
    }
    // Cross-field consistency (subject.relayId === binding.relayId) is enforced
    // by the relay-side revalidation, not the strict shape parser — a non-blank
    // subject.relayId is shape-valid here.
    expect(
      parseRelayWorkstationShellBinding({
        ...BINDING,
        subject: { ...BINDING.subject, relayId: "relay-other" },
      }),
    ).toMatchObject({ ok: true });
  });

  test("fails closed for unsupported operation and execution class", () => {
    // The parser admits any valid DesktopFilesystemAccessOperation; the relay-side
    // revalidation enforces operation === derived ("execute" for run_shell).
    // "write" is not a valid operation at all → parser rejects.
    expect(
      parseRelayWorkstationShellBinding({ ...BINDING, operation: "write" }),
    ).toMatchObject({ ok: false });
    expect(
      parseRelayWorkstationShellBinding({ ...BINDING, executionClass: "typed_broker" }),
    ).toMatchObject({ ok: false });
  });

  test("D418 default-instance — subject.instanceId accepts the canonical default and named ids", () => {
    expect(
      parseRelayWorkstationShellBinding({
        ...BINDING,
        subject: { ...BINDING.subject, instanceId: "" },
      }),
    ).toEqual({
      ok: true,
      binding: { ...BINDING, subject: { ...BINDING.subject, instanceId: "" } },
    });
    expect(
      parseRelayWorkstationShellBinding({
        ...BINDING,
        subject: { ...BINDING.subject, instanceId: "stack-b" },
      }),
    ).toEqual({
      ok: true,
      binding: { ...BINDING, subject: { ...BINDING.subject, instanceId: "stack-b" } },
    });
  });

  test("D418 default-instance — subject.instanceId rejects whitespace and noncanonical ids", () => {
    for (const bad of ["  ", "\t", "instance-1 ", " instance-1", "Instance-1", "-bad", "bad!"]) {
      expect(
        parseRelayWorkstationShellBinding({
          ...BINDING,
          subject: { ...BINDING.subject, instanceId: bad },
        }),
      ).toMatchObject({ ok: false });
    }
    expect(
      parseRelayWorkstationShellBinding({
        ...BINDING,
        subject: { ...BINDING.subject, instanceId: 0 },
      }),
    ).toMatchObject({ ok: false });
  });

  test("non-object input fails closed", () => {
    expect(parseRelayWorkstationShellBinding(null)).toMatchObject({ ok: false });
    expect(parseRelayWorkstationShellBinding("not-an-object")).toMatchObject({ ok: false });
    expect(parseRelayWorkstationShellBinding([])).toMatchObject({ ok: false });
  });
});
