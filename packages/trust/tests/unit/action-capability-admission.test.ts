import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AmbiguousAgentOwnerError } from "../../src/queries";
import {
  AgentInvocationDeniedError,
  AgentInvocationTargetUnavailableError,
  ArtifactWriteDeniedError,
  ServerProviderCredentialsDeniedError,
  assertAcceptedInvocationAuthoritySubject,
  assertCanInvokeAgent,
  assertCanUseServerProviderCredentials,
  assertCanWriteArtifacts,
  createAcceptedInvocationAuthority,
  getAcceptedInvocationAuthoritySubject,
  getAcceptedInvocationAuthorityOrigin,
  bindAcceptedInvocationAuthorityOrigin,
  toActionCapabilityDenialDiagnostic,
  toActionCapabilityHttpDenial,
  toAgentInvocationTargetUnavailableHttpDenial,
  type AcceptedInvocationAuthority,
  type ActionCapabilityAdmissionDeps,
  type AgentInvocationOrigin,
} from "../../src/action-capability-admission";

const AGENT_INVOCATION_ORIGINS = [
  "room_message",
  "background_job",
  "task_create",
  "task_update",
  "task_unpause",
  "task_dispatch",
  "task_human_reply",
  "foreground_resume",
] as const satisfies readonly AgentInvocationOrigin[];

function capabilityDeps(
  resultForCall: (call: number, humanUserId: string) => string[],
  ownerForAgent: (agentId: string) => string | null = () => null,
): ActionCapabilityAdmissionDeps & {
  readonly calls: string[];
  readonly ownerCalls: string[];
} {
  const calls: string[] = [];
  const ownerCalls: string[] = [];
  return {
    calls,
    ownerCalls,
    isInvocationAccessAllowed: async () => true,
    getUserCapabilities: async (humanUserId) => {
      calls.push(humanUserId);
      return resultForCall(calls.length, humanUserId);
    },
    findAgentOwnerUserId: async (agentId) => {
      ownerCalls.push(agentId);
      return ownerForAgent(agentId);
    },
  };
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected promise to reject");
}

describe("M246 dormant action-Capability admission", () => {
  test("preserves the complete bounded Agent invocation origin vocabulary", () => {
    expect(AGENT_INVOCATION_ORIGINS).toEqual([
      "room_message",
      "background_job",
      "task_create",
      "task_update",
      "task_unpause",
      "task_dispatch",
      "task_human_reply",
      "foreground_resume",
    ]);
  });

  test("allows Agent invocation and Artifact writes through current Human RBAC", async () => {
    const deps = capabilityDeps(() => ["invoke_agents", "write_artifacts"]);

    expect(
      await assertCanInvokeAgent(
        { humanUserId: "user-1", origin: "room_message", roomId: "room-1" },
        deps,
      ),
    ).toBeUndefined();
    expect(
      await assertCanWriteArtifacts(
        { humanUserId: "user-1", namespaceId: "namespace-1" },
        deps,
      ),
    ).toBeUndefined();

    expect(deps.calls).toEqual(["user-1", "user-1"]);
  });

  test("performs a fresh effective-Capability lookup for every assertion", async () => {
    const deps = capabilityDeps((call) =>
      call === 1 ? ["invoke_agents"] : [],
    );
    const input = {
      humanUserId: "user-changing-authority",
      origin: "background_job",
    } as const;

    expect(await assertCanInvokeAgent(input, deps)).toBeUndefined();
    let denial: unknown;
    try {
      await assertCanInvokeAgent(input, deps);
    } catch (error) {
      denial = error;
    }
    expect(denial).toBeInstanceOf(AgentInvocationDeniedError);
    expect(deps.calls).toEqual([
      "user-changing-authority",
      "user-changing-authority",
    ]);
  });

  test("keeps a no-target assertion as the base pre-routing check", async () => {
    const deps = capabilityDeps(() => ["invoke_agents"]);

    expect(await assertCanInvokeAgent(
      { humanUserId: "human-1", origin: "room_message" },
      deps,
    )).toBeUndefined();

    expect(deps.calls).toEqual(["human-1"]);
    expect(deps.ownerCalls).toEqual([]);
  });

  test("allows an exact Genie owned by the initiating Human", async () => {
    const deps = capabilityDeps(
      () => ["invoke_agents"],
      (agentId) => agentId === "agent-own" ? "human-1" : null,
    );

    expect(await assertCanInvokeAgent(
      {
        humanUserId: "human-1",
        origin: "room_message",
        agentId: "agent-own",
      },
      deps,
    )).toBeUndefined();

    expect(deps.ownerCalls).toEqual(["agent-own"]);
  });

  test("requires invoke_other_agents for a foreign exact Genie", async () => {
    const deps = capabilityDeps(
      () => ["invoke_agents"],
      () => "human-2",
    );
    const input = {
      humanUserId: "human-1",
      origin: "task_dispatch",
      roomId: "room-1",
      agentId: "agent-foreign",
    } as const;

    expect(await rejectionOf(assertCanInvokeAgent(input, deps))).toMatchObject({
      name: "AgentInvocationDeniedError",
      message: "invoke_other_agents_required",
      code: "invoke_other_agents_required",
      capability: "invoke_other_agents",
      humanUserId: "human-1",
      roomId: "room-1",
      agentId: "agent-foreign",
    });
  });

  test("allows a foreign exact Genie through additive effective authority", async () => {
    const deps = capabilityDeps(
      () => ["invoke_agents", "invoke_other_agents"],
      () => "human-2",
    );

    expect(await assertCanInvokeAgent(
      {
        humanUserId: "human-1",
        origin: "foreground_resume",
        agentId: "agent-foreign",
      },
      deps,
    )).toBeUndefined();
  });

  test("denies an unresolved exact target regardless of cross-Genie authority", async () => {
    for (const capabilities of [
      ["invoke_agents"],
      ["invoke_agents", "invoke_other_agents"],
    ]) {
      const deps = capabilityDeps(() => capabilities, () => null);
      const input = {
        humanUserId: "human-1",
        origin: "task_create",
        agentId: "agent-missing",
      } as const;

      let denial: AgentInvocationTargetUnavailableError | undefined;
      try {
        await assertCanInvokeAgent(input, deps);
      } catch (error) {
        expect(error).toBeInstanceOf(AgentInvocationTargetUnavailableError);
        expect(error).toBeInstanceOf(AgentInvocationDeniedError);
        denial = error as AgentInvocationTargetUnavailableError;
      }
      expect(denial).toMatchObject({
        code: "agent_target_unavailable",
        humanUserId: "human-1",
        agentId: "agent-missing",
      });
      expect(toAgentInvocationTargetUnavailableHttpDenial(denial!)).toEqual({
        error: "agent_target_unavailable",
        code: "agent_target_unavailable",
      });
      expect(toActionCapabilityHttpDenial(denial!)).toEqual({
        error: "agent_target_unavailable",
        code: "agent_target_unavailable",
        capability: "invoke_agents",
      });
    }
  });

  test("checks base authority before resolving exact Genie ownership", async () => {
    const deps = capabilityDeps(() => [], () => "human-1");

    expect(await rejectionOf(assertCanInvokeAgent(
      {
        humanUserId: "human-1",
        origin: "room_message",
        agentId: "agent-own",
      },
      deps,
    ))).toMatchObject({ code: "invoke_agents_required" });

    expect(deps.ownerCalls).toEqual([]);
  });

  test("propagates ownership lookup failures instead of mapping them to absence", async () => {
    const deps = capabilityDeps(() => ["invoke_agents"]);
    deps.findAgentOwnerUserId = async () => {
      throw new Error("owner lookup failed");
    };

    expect(await rejectionOf(assertCanInvokeAgent(
      {
        humanUserId: "human-1",
        origin: "room_message",
        agentId: "agent-1",
      },
      deps,
    ))).toEqual(new Error("owner lookup failed"));
  });

  test("maps ambiguous exact Genie ownership to the stable target-unavailable denial", async () => {
    const deps = capabilityDeps(() => ["invoke_agents", "invoke_other_agents"]);
    deps.findAgentOwnerUserId = async () => { throw new AmbiguousAgentOwnerError(); };
    expect(await rejectionOf(assertCanInvokeAgent({
      humanUserId: "human-1", origin: "room_message", agentId: "agent-1",
    }, deps))).toMatchObject({ code: "agent_target_unavailable" });
  });

  test("denies a missing initiating Human before any capability or Genie lookup", async () => {
    const deps = capabilityDeps(() => ["invoke_agents", "use_server_provider_credentials"], () => "owner-1");
    expect(await rejectionOf(assertCanInvokeAgent({
      humanUserId: "", origin: "room_message", agentId: "agent-1",
    }, deps))).toMatchObject({ code: "invoke_agents_required", humanUserId: "" });
    expect(await rejectionOf(assertCanUseServerProviderCredentials("", "chat_model", deps)))
      .toMatchObject({ code: "server_provider_credentials_required", humanUserId: "" });
    expect(deps.calls).toEqual([]);
    expect(deps.ownerCalls).toEqual([]);
  });

  test("allows current server-provider credential authority", async () => {
    const deps = capabilityDeps(() => ["use_server_provider_credentials"]);

    expect(await assertCanUseServerProviderCredentials(
      "human-1",
      "foreground_model",
      deps,
    )).toBeUndefined();
    expect(deps.calls).toEqual(["human-1"]);
    expect(deps.ownerCalls).toEqual([]);
  });

  test("returns a stable denial when server-provider credential authority is absent", async () => {
    const deps = capabilityDeps(() => ["invoke_agents"]);
    let denial: ServerProviderCredentialsDeniedError | undefined;

    try {
      await assertCanUseServerProviderCredentials(
        "human-1",
        "task_model",
        deps,
      );
    } catch (error) {
      expect(error).toBeInstanceOf(ServerProviderCredentialsDeniedError);
      denial = error as ServerProviderCredentialsDeniedError;
    }

    expect(denial).toMatchObject({
      message: "server_provider_credentials_required",
      code: "server_provider_credentials_required",
      capability: "use_server_provider_credentials",
      humanUserId: "human-1",
      origin: "task_model",
    });
    expect(toActionCapabilityHttpDenial(denial!)).toEqual({
      error: "server_provider_credentials_required",
      code: "server_provider_credentials_required",
      capability: "use_server_provider_credentials",
    });
  });

  test("re-reads server-provider credential authority for every dispatch", async () => {
    const deps = capabilityDeps((call) =>
      call === 1 ? ["use_server_provider_credentials"] : [],
    );

    expect(await assertCanUseServerProviderCredentials(
      "human-changing",
      undefined,
      deps,
    )).toBeUndefined();
    expect(await rejectionOf(assertCanUseServerProviderCredentials(
      "human-changing",
      undefined,
      deps,
    ))).toMatchObject({ code: "server_provider_credentials_required" });
    expect(deps.calls).toEqual(["human-changing", "human-changing"]);
  });

  test("throws the exact typed Agent denial and maps stable content-free output", async () => {
    const deps = capabilityDeps(() => ["write_artifacts"]);
    const input = {
      humanUserId: "human-7",
      origin: "task_human_reply",
      roomId: "room-4",
      agentId: "agent-2",
    } as const;

    let denial: AgentInvocationDeniedError | undefined;
    try {
      await assertCanInvokeAgent(input, deps);
    } catch (error) {
      expect(error).toBeInstanceOf(AgentInvocationDeniedError);
      denial = error as AgentInvocationDeniedError;
    }

    expect(denial).toBeDefined();
    expect(denial?.message).toBe("invoke_agents_required");
    expect(toActionCapabilityHttpDenial(denial!)).toEqual({
      error: "invoke_agents_required",
      code: "invoke_agents_required",
      capability: "invoke_agents",
    });
    expect(
      toActionCapabilityDenialDiagnostic(
        denial!,
        new Date("2026-08-11T12:34:56.000Z"),
      ),
    ).toEqual({
      event: "action_capability_denied",
      code: "invoke_agents_required",
      capability: "invoke_agents",
      humanUserId: "human-7",
      origin: "task_human_reply",
      occurredAt: "2026-08-11T12:34:56.000Z",
      roomId: "room-4",
      agentId: "agent-2",
    });
  });

  test("throws the exact typed Artifact denial with only bounded identifiers", async () => {
    const deps = capabilityDeps(() => ["invoke_agents"]);
    const input = {
      humanUserId: "human-8",
      roomId: "room-5",
      namespaceId: "namespace-3",
      artifactId: "artifact-9",
    } as const;

    let denial: ArtifactWriteDeniedError | undefined;
    try {
      await assertCanWriteArtifacts(input, deps);
    } catch (error) {
      expect(error).toBeInstanceOf(ArtifactWriteDeniedError);
      denial = error as ArtifactWriteDeniedError;
    }

    expect(denial).toBeDefined();
    expect(denial?.message).toBe("write_artifacts_required");
    expect(toActionCapabilityHttpDenial(denial!)).toEqual({
      error: "write_artifacts_required",
      code: "write_artifacts_required",
      capability: "write_artifacts",
    });
    const diagnostic = toActionCapabilityDenialDiagnostic(
      denial!,
      new Date("2026-08-11T12:34:56.000Z"),
    );
    expect(diagnostic).toEqual({
      event: "action_capability_denied",
      code: "write_artifacts_required",
      capability: "write_artifacts",
      humanUserId: "human-8",
      origin: "artifact_write",
      occurredAt: "2026-08-11T12:34:56.000Z",
      roomId: "room-5",
      namespaceId: "namespace-3",
      artifactId: "artifact-9",
    });
    expect(Object.keys(diagnostic).sort()).toEqual(
      [
        "artifactId",
        "capability",
        "code",
        "event",
        "humanUserId",
        "namespaceId",
        "occurredAt",
        "origin",
        "roomId",
      ].sort(),
    );
  });
});

describe("M254 accepted invocation authority", () => {
  test("binds opaque in-process authority to the canonical Human", () => {
    const authority = createAcceptedInvocationAuthority("human-1");

    expect(() =>
      assertAcceptedInvocationAuthoritySubject(authority, "human-1"),
    ).not.toThrow();
    expect(() =>
      assertAcceptedInvocationAuthoritySubject(authority, "human-2"),
    ).toThrow("Accepted invocation authority subject mismatch");
    expect(getAcceptedInvocationAuthoritySubject(authority)).toBe("human-1");
    expect(Object.keys(authority)).toEqual([]);
  });

  test("cannot be reconstructed from parsed payloads or serialized", () => {
    const authority = createAcceptedInvocationAuthority("human-1");
    const parsed = JSON.parse("{}") as typeof authority;

    expect(() =>
      assertAcceptedInvocationAuthoritySubject(parsed, "human-1"),
    ).toThrow("Accepted invocation authority subject mismatch");
    expect(() => getAcceptedInvocationAuthoritySubject(parsed)).toThrow(
      "Accepted invocation authority subject mismatch",
    );
    expect(() => JSON.stringify(authority)).toThrow(
      "Accepted invocation authority cannot be serialized",
    );
    const cloned = structuredClone(authority);
    expect(() =>
      assertAcceptedInvocationAuthoritySubject(cloned, "human-1"),
    ).toThrow("Accepted invocation authority subject mismatch");
  });

  test("copies and freezes source authority outside serializable payloads", () => {
    const source = { originRoomId: "source-room" };
    const authority = createAcceptedInvocationAuthority("human-1", source);
    source.originRoomId = "replacement-room";
    expect(getAcceptedInvocationAuthorityOrigin(authority)).toEqual({ originRoomId: "source-room" });
    expect(Object.isFrozen(getAcceptedInvocationAuthorityOrigin(authority))).toBe(true);
    expect(bindAcceptedInvocationAuthorityOrigin(authority, { originRoomId: "replacement-room" })).toBe(authority);
    expect(getAcceptedInvocationAuthorityOrigin(authority)).toEqual({ originRoomId: "source-room" });
    expect(() => getAcceptedInvocationAuthorityOrigin({} as AcceptedInvocationAuthority)).toThrow();
  });

  test("does not confuse arbitrary or maintenance-shaped values with authority", () => {
    for (const forged of [null, {}, Object.freeze({}), "human-1"]) {
      expect(() =>
        assertAcceptedInvocationAuthoritySubject(
          forged as AcceptedInvocationAuthority,
          "human-1",
        ),
      ).toThrow("Accepted invocation authority subject mismatch");
    }
  });
});

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..");
const PRODUCTION_ROOTS = ["apps", "bin", "packages"] as const;
const INVOCATION_ADMISSION_PATTERN = /\bassertCanInvokeAgent\s*\(/;
const SERVER_INVOCATION_ADAPTER_PATTERN = /\brequireAgentInvocation\s*\(/;
const ARTIFACT_WRITE_ADMISSION_PATTERN = /\bassertCanWriteArtifacts\s*\(/;
const SERVER_ARTIFACT_WRITE_ADAPTER_PATTERN = /\brequireArtifactWrite\s*\(/;
const WORKSPACE_ARTIFACT_WRITE_ADAPTER_PATTERN =
  /\brequireWorkspaceArtifactWrite\s*\(/;
const INVOCATION_AUTHORITY_FACTORY_PATTERN =
  /\bcreateAcceptedInvocationAuthority\s*\(/;
const INVOCATION_AUTHORITY_CONTEXT_PATTERN =
  /\b(?:getCurrentAcceptedInvocationAuthority|runWithAcceptedInvocationAuthority|runWithAcceptedWorkAuthorities)\b/;

function collectProductionTypeScriptFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const absolute = join(root, entry.name);
    if (entry.isDirectory()) {
      if (
        entry.name === "node_modules" ||
        entry.name === "dist" ||
        entry.name === ".turbo" ||
        entry.name === "tests" ||
        entry.name === "test"
      ) {
        continue;
      }
      files.push(...collectProductionTypeScriptFiles(absolute));
      continue;
    }
    if (
      (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) &&
      !entry.name.includes(".test.")
    ) {
      files.push(absolute);
    }
  }
  return files;
}

function productionFilesMatching(pattern: RegExp): string[] {
  return PRODUCTION_ROOTS.flatMap((root) =>
    collectProductionTypeScriptFiles(join(REPO_ROOT, root)),
  )
    .filter((file) => pattern.test(readFileSync(file, "utf8")))
    .map((file) => file.slice(REPO_ROOT.length + 1))
    .sort();
}

test("M254 invocation admission and authority mint sites stay mechanically inventoried", () => {
  expect(productionFilesMatching(INVOCATION_ADMISSION_PATTERN)).toEqual([
    "packages/runtime/src/tasks/report-back.ts",
    "packages/server/src/messaging/await-resume.ts",
    "packages/trust/src/action-capability-admission.ts",
  ]);

  expect(productionFilesMatching(SERVER_INVOCATION_ADAPTER_PATTERN)).toEqual([
    "packages/server/src/lib/agent-invocation-admission.ts",
    "packages/server/src/routes/auth.ts",
    "packages/server/src/routes/chat.ts",
    "packages/server/src/routes/codex-requests.ts",
    "packages/server/src/routes/jobs.ts",
    "packages/server/src/routes/ordinary-content-access-recovery.ts",
    "packages/server/src/routes/rooms.ts",
    "packages/server/src/routes/tasks.ts",
    "packages/server/src/routes/workspace-artifacts.ts",
  ]);

  expect(productionFilesMatching(INVOCATION_AUTHORITY_FACTORY_PATTERN)).toEqual([
    "packages/runtime/src/job-manager.ts",
    "packages/runtime/src/tasks/dispatch-task-run.ts",
    "packages/runtime/src/tasks/report-back.ts",
    "packages/server/src/connected-web-accounts/operation-wake.ts",
    "packages/server/src/media-generation/production-worker.ts",
    "packages/server/src/messaging/await-resume.ts",
    "packages/server/src/messaging/dispatch.ts",
    "packages/server/src/routes/auth.ts",
    "packages/server/src/routes/chat.ts",
    "packages/server/src/routes/codex-requests.ts",
    "packages/server/src/routes/jobs.ts",
    "packages/server/src/routes/ordinary-content-access-recovery.ts",
    "packages/server/src/routes/task-content-access-recovery.ts",
    "packages/server/src/routes/task-protected-composition.ts",
    "packages/server/src/routes/tasks.ts",
    "packages/server/src/routes/workspace-artifacts.ts",
    "packages/trust/src/action-capability-admission.ts",
  ]);

  expect(productionFilesMatching(INVOCATION_AUTHORITY_CONTEXT_PATTERN)).toEqual([
    "packages/runtime/src/index.ts",
    "packages/runtime/src/job-manager.ts",
    "packages/runtime/src/tasks/create-task.ts",
    "packages/runtime/src/tasks/resume-task-approval.ts",
  ]);
});

test("M259 Artifact-write admission sites stay mechanically inventoried", () => {
  expect(productionFilesMatching(ARTIFACT_WRITE_ADMISSION_PATTERN)).toEqual([
    "packages/agent/src/tools/file/artifact-store.ts",
    "packages/agent/src/tools/file/share-artifact.ts",
    "packages/agent/src/tools/file/user-patch.ts",
    "packages/agent/src/tools/file/user-save.ts",
    "packages/server/src/document-mutations/workspace-agent-mutation-coordinator.ts",
    "packages/server/src/lib/slide-template-service.ts",
    "packages/server/src/routes/wopi.ts",
    "packages/trust/src/action-capability-admission.ts",
  ]);

  expect(productionFilesMatching(SERVER_ARTIFACT_WRITE_ADAPTER_PATTERN)).toEqual([
    "packages/server/src/lib/artifact-write-admission.ts",
    "packages/server/src/routes/human-edit-leases.ts",
    "packages/server/src/routes/profile-bundle.ts",
    "packages/server/src/routes/slide-templates.ts",
    "packages/server/src/routes/wopi.ts",
    "packages/server/src/routes/workspace-artifacts.ts",
    "packages/server/src/routes/workspace-sharing.ts",
  ]);

  expect(
    productionFilesMatching(WORKSPACE_ARTIFACT_WRITE_ADAPTER_PATTERN),
  ).toEqual([
    "packages/server/src/routes/workspace-artifacts.ts",
  ]);
});

type InvocationCallsiteClass =
  | "external_new_admission"
  | "fresh_durable_dispatch"
  | "accepted_continuation"
  | "neutral_internal_work";

type InventoriedCallsite = {
  file: string;
  count: number;
  classification: InvocationCallsiteClass;
};

const EXECUTION_PRIMITIVE_INVENTORY: ReadonlyArray<{
  primitive: string;
  pattern: RegExp;
  excludePattern?: RegExp;
  callsites: readonly InventoriedCallsite[];
}> = [
  {
    primitive: "createForegroundJob",
    pattern: /\.\s*createForegroundJob\s*\(/g,
    callsites: [
      {
        file: "packages/runtime/src/tasks/dispatch-task-run.ts",
        count: 2,
        classification: "fresh_durable_dispatch",
      },
      {
        file: "packages/server/src/messaging/agent-mediated.ts",
        count: 1,
        classification: "external_new_admission",
      },
    ],
  },
  {
    primitive: "createBackgroundJob",
    pattern: /\.\s*createBackgroundJob\s*\(/g,
    callsites: [
      {
        file: "packages/server/src/routes/jobs.ts",
        count: 1,
        classification: "external_new_admission",
      },
    ],
  },
  {
    primitive: "createSystemForegroundJob",
    pattern: /\.\s*createSystemForegroundJob\s*\(/g,
    callsites: [
      {
        file: "packages/runtime/src/tasks/report-back.ts",
        count: 1,
        classification: "accepted_continuation",
      },
      {
        // Durable operation custody supplies the exact initiating owner,
        // Genie and lane; current policy rebuilds the Human actor envelope.
        file: "packages/server/src/connected-web-accounts/operation-wake.ts",
        count: 1,
        classification: "accepted_continuation",
      },
      {
        file: "packages/server/src/media-generation/production-worker.ts",
        count: 1,
        classification: "accepted_continuation",
      },
    ],
  },
  {
    primitive: "runtimeCreateTask",
    pattern: /\bruntimeCreateTask\s*\(/g,
    callsites: [
      {
        file: "packages/server/src/app.ts",
        count: 1,
        classification: "accepted_continuation",
      },
      {
        file: "packages/server/src/routes/task-protected-composition.ts",
        count: 1,
        classification: "external_new_admission",
      },
      {
        file: "packages/server/src/routes/tasks.ts",
        count: 1,
        classification: "external_new_admission",
      },
      {
        file: "packages/server/src/routes/workspace-artifacts.ts",
        count: 1,
        classification: "external_new_admission",
      },
    ],
  },
  {
    primitive: "Task tool createTask adapters",
    pattern: /\.\s*createTask\s*\(/g,
    callsites: [
      {
        file: "packages/agent/src/tools/research/run-deep-research.ts",
        count: 1,
        classification: "accepted_continuation",
      },
      {
        file: "packages/agent/src/tools/tasks/dispatch.ts",
        count: 1,
        classification: "accepted_continuation",
      },
      {
        file: "packages/agent/src/tools/tasks/shortcuts/ask-peer.ts",
        count: 1,
        classification: "accepted_continuation",
      },
      {
        file: "packages/agent/src/tools/tasks/shortcuts/generate-repo-docs.ts",
        count: 1,
        classification: "accepted_continuation",
      },
      {
        file: "packages/agent/src/tools/tasks/shortcuts/in-background.ts",
        count: 1,
        classification: "accepted_continuation",
      },
      {
        file: "packages/agent/src/tools/tasks/shortcuts/in-private-namespace.ts",
        count: 1,
        classification: "accepted_continuation",
      },
      {
        file: "packages/agent/src/tools/tasks/shortcuts/in-scope.ts",
        count: 1,
        classification: "accepted_continuation",
      },
      {
        file: "packages/agent/src/tools/tasks/shortcuts/schedule.ts",
        count: 1,
        classification: "accepted_continuation",
      },
      {
        file: "packages/server/src/acp/harness-task.ts",
        count: 1,
        classification: "accepted_continuation",
      },
      {
        file: "packages/server/src/acp/opencode-harness-task.ts",
        count: 1,
        classification: "accepted_continuation",
      },
      {
        file: "packages/server/src/claude/harness-task.ts",
        count: 1,
        classification: "accepted_continuation",
      },
      {
        file: "packages/server/src/codex/harness-task.ts",
        count: 1,
        classification: "accepted_continuation",
      },
    ],
  },
  {
    primitive: "runResumeJobLifecycle",
    pattern: /\.\s*runResumeJobLifecycle\s*\(/g,
    callsites: [
      {
        file: "packages/runtime/src/job-manager.ts",
        // Exact failed sharing continuation holds the canonical thread lock,
        // rechecks durable Job identity, and consumes current route admission.
        count: 1,
        classification: "accepted_continuation",
      },
      {
        file: "packages/runtime/src/tasks/resume-task-approval.ts",
        // Consumes the approval route's accepted requestor authority; the
        // lifecycle wrapper validates its subject before graph continuation.
        count: 1,
        classification: "accepted_continuation",
      },
      {
        file: "packages/server/src/messaging/await-resume.ts",
        // Current responder/requestor RBAC and maintenance admission precede
        // minting the authority now carried by the cancellable Job wrapper.
        count: 1,
        classification: "external_new_admission",
      },
      {
        file: "packages/server/src/routes/auth.ts",
        // One policy/sink wrapper preserves the six admitted entry points below.
        count: 1,
        classification: "external_new_admission",
      },
    ],
  },
  {
    primitive: "runResumeJobLifecycleWithCurrentPolicy",
    pattern: /\brunResumeJobLifecycleWithCurrentPolicy\s*\(/g,
    excludePattern: /async function runResumeJobLifecycleWithCurrentPolicy\s*\(/g,
    callsites: [
      {
        file: "packages/server/src/routes/auth.ts",
        count: 6,
        classification: "external_new_admission",
      },
    ],
  },
  {
    primitive: "resumeGraphWith*",
    pattern:
      /\bresumeGraphWith(?:Approval|AskReply|Identity|HostChoice|HumanReply|ConnectedWebAction)\s*\(/g,
    excludePattern:
      /\bfunction\s+resumeGraphWith(?:Approval|AskReply|Identity|HostChoice|HumanReply|ConnectedWebAction)\s*\(/g,
    callsites: [
      {
        file: "packages/runtime/src/tasks/resume-task-approval.ts",
        count: 3,
        classification: "accepted_continuation",
      },
      {
        file: "packages/server/src/messaging/await-resume.ts",
        count: 1,
        classification: "accepted_continuation",
      },
      {
        file: "packages/server/src/routes/auth.ts",
        // Includes exact connected-website Done and safer failed-resume Cancel.
        count: 7,
        classification: "external_new_admission",
      },
    ],
  },
  {
    primitive: "runOrdinaryContentAccessRecovery",
    pattern: /\.\s*runOrdinaryContentAccessRecovery\s*\(/g,
    callsites: [{ file: "packages/server/src/routes/ordinary-content-access-recovery.ts",
      // Explicit Human action; current Room membership and invoke_agents
      // admission precede exact, content-free checkpoint selection.
      count: 1, classification: "external_new_admission" }],
  },
  {
    primitive: "resumeOrdinaryContentAccessRecovery",
    pattern: /\bresumeOrdinaryContentAccessRecovery\s*\(/g,
    excludePattern: /\bfunction\s+resumeOrdinaryContentAccessRecovery\s*\(/g,
    callsites: [{ file: "packages/runtime/src/job-manager.ts",
      count: 1, classification: "accepted_continuation" },
    { file: "packages/runtime/src/tasks/resume-task-approval.ts",
      count: 1, classification: "accepted_continuation" }],
  },
];

function productionOccurrenceCounts(sources: readonly { file: string; source: string }[], pattern: RegExp, excludePattern?: RegExp): Array<{
  file: string;
  count: number;
}> {
  return sources
    .map(({ file, source }) => {
      const matcher = new RegExp(pattern.source, pattern.flags);
      const searchable = excludePattern
        ? source.replace(
            new RegExp(excludePattern.source, excludePattern.flags),
            "",
          )
        : source;
      return {
        file: file.slice(REPO_ROOT.length + 1),
        count: [...searchable.matchAll(matcher)].length,
      };
    })
    .filter(({ count }) => count > 0)
    .sort((a, b) => a.file.localeCompare(b.file));
}

test("M254 execution primitive callsites stay positively classified", () => {
  // Every primitive inspects the same source snapshot. Read it once instead of
  // walking and rereading the entire production tree for every inventory entry.
  const sources = PRODUCTION_ROOTS.flatMap((root) =>
    collectProductionTypeScriptFiles(join(REPO_ROOT, root)),
  ).map((file) => ({ file, source: readFileSync(file, "utf8") }));
  for (const entry of EXECUTION_PRIMITIVE_INVENTORY) {
    expect(
      productionOccurrenceCounts(sources, entry.pattern, entry.excludePattern),
      `${entry.primitive} callsite inventory changed`,
    ).toEqual(
      entry.callsites
        .map(({ file, count }) => ({ file, count }))
        .sort((a, b) => a.file.localeCompare(b.file)),
    );
    expect(entry.callsites.every(({ classification }) =>
      classification === "external_new_admission" ||
      classification === "fresh_durable_dispatch" ||
      classification === "accepted_continuation" ||
      classification === "neutral_internal_work"
    )).toBe(true);
  }
});


describe("current invocation admission", () => {
  test("every work origin rechecks Human and Room access despite a retained capability", async () => {
    const checked: unknown[] = [];
    const deps = { ...capabilityDeps(() => ["invoke_agents"]),
      isInvocationAccessAllowed: async (input: unknown) => { checked.push(input); return false; } };
    for (const origin of AGENT_INVOCATION_ORIGINS) {
      const input = { humanUserId: "withdrawn-human", origin, roomId: "restricted-room" };
      await Promise.resolve(expect(assertCanInvokeAgent(input, deps)).rejects.toMatchObject({
        code: "invocation_access_withdrawn", humanUserId: input.humanUserId, roomId: input.roomId,
      }));
    }
    expect(checked).toHaveLength(AGENT_INVOCATION_ORIGINS.length);
  });

  test("access lookup failure fails closed without misreporting a missing capability", async () => {
    const deps = { ...capabilityDeps(() => ["invoke_agents"]),
      isInvocationAccessAllowed: async () => { throw new Error("authority unavailable"); } };
    await Promise.resolve(expect(assertCanInvokeAgent({ humanUserId: "human", origin: "task_dispatch" }, deps)).rejects.toThrow("authority unavailable"));
  });
});
