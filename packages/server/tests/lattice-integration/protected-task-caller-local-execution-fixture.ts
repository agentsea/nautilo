import { randomUUID } from "node:crypto";

import { AIMessage } from "@langchain/core/messages";
import {
  createPostModelNode,
  createToolsNode,
  getRelayRegistry,
  registerAllTools,
  runWithCapabilityFundingSession,
  setRelayRegistry,
  type DelegatedLocalExecutionPort,
  type ForegroundChatFundingSession,
  type NautiloState,
} from "@nautilo/agent";
import { Command, MemorySaver, entrypoint } from "@langchain/langgraph";
import {
  ToolCatalog,
  clearToolCatalog,
  getToolCatalog,
  initToolCatalog,
} from "@nautilo/catalog";
import {
  createPersonalProviderCredentialIdentity,
  eq,
  getServerProviderPolicy,
  insertPersonalProviderCredential,
  llmUsageEvents,
  personalProviderCredentials,
  upsertServerProviderPolicy,
  type DirectDatabase,
} from "@nautilo/db";
import {
  encryptPersonalProviderCredential,
} from "@nautilo/operator-secrets";
import type { RelayServerMessage } from "@nautilo/relay";
import {
  InMemoryRelayRegistry,
  installTaskFundingPort,
  uninstallTaskFundingPort,
} from "@nautilo/runtime";
import type { LocalExecutionDelegation } from "@nautilo/types";
import type { PolicyResolver } from "@nautilo/trust";
import { resolveInstance } from "@nautilo/config";

import { readPersonalProviderCustody } from
  "../../src/lib/personal-provider-custody";
import { nativeTaskFundingPort } from "../../src/lib/native-task-funding";

const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";

const delegatedExecutionPolicyResolver: PolicyResolver = {
  resolveContext: () => Promise.resolve({
    laneKey: "",
    actorId: "",
    agentId: "",
    roomId: "",
    roomType: "private",
    graphThreadId: "",
    actorLabel: "",
    actorFederatedId: "",
    agentFederatedId: "",
    speakerTrust: "verified" as const,
    laneScope: "private" as const,
    actorRole: "owner",
    memoryAccess: {
      ownerId: "",
      actorId: "",
      agentId: "",
      roomId: "",
      readableNamespaces: [],
      mutableNamespaces: [],
      writableNamespaces: [],
      toolPolicy: {},
    },
  }),
  buildEnvelope: () => Promise.resolve({
    ownerId: "",
    actorId: "",
    agentId: "",
    roomId: "",
    readableNamespaces: [],
    mutableNamespaces: [],
    writableNamespaces: [],
    toolPolicy: {},
  }),
  checkToolAccess: () => Promise.resolve({
    type: "require_approval" as const,
    route: { type: "prove_it" as const, approvers: [] },
  }),
  routeApproval: () => Promise.resolve({
    type: "prove_it" as const,
    approvers: [],
  }),
};

export type SyntheticPersonalProviderRequest = Readonly<{
  authorization: string | null;
  body: string;
  url: string;
}>;

function hasSingleGraphInterrupt(value: unknown): boolean {
  if (typeof value !== "object" || value === null || !("__interrupt__" in value)) {
    return false;
  }
  return Array.isArray(value.__interrupt__) && value.__interrupt__.length === 1;
}

/**
 * Installs one real encrypted payer credential and intercepts only the selected
 * direct-provider endpoint. The production funding/session/model stack remains
 * responsible for reading custody, admitting the exact revision and lending
 * the plaintext key to the request callback.
 */
export async function installSyntheticPersonalOpenRouter(input: Readonly<{
  database: DirectDatabase;
  userId: string;
  responseText: string;
}>): Promise<Readonly<{
  apiKey: string;
  credentialId: string;
  credentialRevision: number;
  requests: readonly SyntheticPersonalProviderRequest[];
  restore(): Promise<void>;
}>> {
  const priorFetch = globalThis.fetch;
  const priorPolicy = await getServerProviderPolicy(input.database);
  const custody = await readPersonalProviderCustody();
  const identity = createPersonalProviderCredentialIdentity();
  const apiKey = `synthetic-protected-task-${randomUUID()}`;
  const inserted = await insertPersonalProviderCredential(input.database, {
    identity,
    userId: input.userId,
    provider: "openrouter",
    envelope: encryptPersonalProviderCredential(custody, apiKey, {
      ...identity,
      userId: input.userId,
      provider: "openrouter",
      destination: null,
    }),
    destination: null,
    validationStatus: "accepted",
    validatedAt: new Date(),
  });
  if (inserted.status !== "created") {
    throw new Error("Synthetic protected Task credential already exists");
  }
  await upsertServerProviderPolicy(input.database, {
    allowPersonalProviderKeys: true,
    fundingPreference: "personal_first",
  });
  const requests: SyntheticPersonalProviderRequest[] = [];
  globalThis.fetch = (async (
    requestInput: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = typeof requestInput === "string"
      ? requestInput
      : requestInput instanceof URL
        ? requestInput.href
        : requestInput.url;
    if (url !== OPENROUTER_CHAT_URL) {
      throw new Error(`Unexpected outbound request in protected Task fixture: ${url}`);
    }
    const request = requestInput instanceof Request ? requestInput : undefined;
    const headers = new Headers(init?.headers ?? request?.headers);
    const body = typeof init?.body === "string"
      ? init.body
      : request
        ? await request.clone().text()
        : "{}";
    requests.push(Object.freeze({
      authorization: headers.get("authorization"),
      body,
      url,
    }));
    const parsed = JSON.parse(body) as { stream?: unknown };
    const id = `chatcmpl-protected-task-${requests.length}`;
    if (parsed.stream === true) {
      const chunks = [
        {
          id,
          object: "chat.completion.chunk",
          created: 1,
          model: "moonshotai/kimi-k3",
          choices: [{
            index: 0,
            delta: { role: "assistant", content: input.responseText },
            finish_reason: null,
          }],
        },
        {
          id,
          object: "chat.completion.chunk",
          created: 1,
          model: "moonshotai/kimi-k3",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
        },
      ];
      return new Response(
        `${chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    }
    return Response.json({
      id,
      object: "chat.completion",
      created: 1,
      model: "moonshotai/kimi-k3",
      choices: [{
        index: 0,
        message: { role: "assistant", content: input.responseText },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
    });
  }) as typeof fetch;
  // The production app installs this process-local port during startup. This
  // integration fixture builds the native composition directly, so install
  // the same real port for the lifetime of the exact synthetic credential.
  installTaskFundingPort(nativeTaskFundingPort);

  let restored = false;
  return Object.freeze({
    apiKey,
    credentialId: identity.id,
    credentialRevision: identity.revision,
    requests,
    async restore() {
      if (restored) return;
      restored = true;
      globalThis.fetch = priorFetch;
      uninstallTaskFundingPort();
      try {
        await input.database.delete(llmUsageEvents).where(eq(
          llmUsageEvents.userId,
          input.userId,
        ));
        await input.database.delete(personalProviderCredentials).where(eq(
          personalProviderCredentials.id,
          identity.id,
        ));
      } finally {
        await upsertServerProviderPolicy(input.database, priorPolicy);
      }
    },
  });
}

export type ConnectedDelegatedLocalExecutionFixture = Readonly<{
  delegation: LocalExecutionDelegation;
  messages: readonly RelayServerMessage[];
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  invoke(
    port: DelegatedLocalExecutionPort,
    funding: ForegroundChatFundingSession,
  ): Promise<Partial<NautiloState>>;
  restore(): Promise<void>;
}>;

/** Real registry + Agent invocation wiring for one exact delegated Task. */
export async function installConnectedDelegatedLocalExecution(input: Readonly<{
  humanUserId: string;
  agentId: string;
  taskId: string;
  taskRunId: string;
  roomId: string;
  roomGraphThreadId: string;
}>): Promise<ConnectedDelegatedLocalExecutionFixture> {
  const priorRegistry = getRelayRegistry();
  const priorCatalog = getToolCatalog();
  const registry = new InMemoryRelayRegistry();
  const relayId = `protected-task-relay-${randomUUID()}`;
  const desktopSessionId = `protected-task-desktop-${randomUUID()}`;
  const rawPairingGeneration = `protected-task-pairing-${randomUUID()}`;
  const localGeneration = `protected-task-local-${randomUUID()}`;
  const messages: RelayServerMessage[] = [];
  const capabilities = Object.freeze({
    profile: "desktop-agent" as const,
    canExecuteLocal: true,
    canDelegateLocalExecution: true,
    localExecution: Object.freeze({
      version: 1 as const,
      generation: localGeneration,
      pipe: true as const,
      pty: true as const,
      localNetworkPolicy: true,
      capacity: 1,
    }),
  });
  const send = (message: RelayServerMessage): void => {
    messages.push(structuredClone(message));
    if (message.type === "relay:dispatch") {
      registry.resolveDispatch(message.correlationId, {
        status: "ok",
        result: {
          session_id: message.localExecutionBinding?.executionId,
          state: "running",
          output: "synthetic local execution accepted",
        },
      });
    }
  };
  const connect = () => registry.register(
    relayId,
    input.humanUserId,
    capabilities,
    send,
    29,
    desktopSessionId,
    1,
    rawPairingGeneration,
  );
  await connect();
  setRelayRegistry(registry);
  const catalog = new ToolCatalog();
  registerAllTools(catalog);
  initToolCatalog(catalog);
  const delegation: LocalExecutionDelegation = Object.freeze({
    version: 1,
    humanUserId: input.humanUserId,
    agentId: input.agentId,
    sourceRoomId: input.roomId,
    sourceConversationId: input.roomGraphThreadId,
    rootTaskId: input.taskId,
    projectGrantId: `protected-task-project-${input.taskId}`,
    ceiling: "basic",
    profile: null,
    target: Object.freeze({
      instanceId: resolveInstance().instanceId,
      relayId,
      pairingGeneration: rawPairingGeneration,
      serverOrigin: "https://server.invalid",
      serverFingerprint: "protected-task-fixture",
    }),
  });
  const localPairingGeneration = registry.getLocalExecutionPairingGeneration(
    relayId,
  );
  if (!localPairingGeneration) {
    throw new Error("Protected Task local pairing generation is unavailable");
  }
  let restored = false;
  return Object.freeze({
    delegation,
    messages,
    connect,
    disconnect: () => registry.unregister(relayId),
    async invoke(port, funding) {
      if (funding.capabilityFunding === undefined) {
        throw new Error("Protected Task capability funding is unavailable");
      }
      const call = Object.freeze({
        id: `protected-task-local-call-${input.taskRunId}`,
        name: "exec_command",
        args: Object.freeze({ cmd: "printf protected-task-local" }),
        type: "tool_call" as const,
      });
      const state = {
        currentFolder: "",
        messages: [new AIMessage({ content: "", tool_calls: [call] })],
        approvedToolCalls: [call],
        actorRole: "owner",
        userId: input.agentId,
        causalHumanUserId: input.humanUserId,
        personaId: input.agentId,
        turnId: `protected-task-turn-${input.taskRunId}`,
        agentId: input.agentId,
        roomId: input.roomId,
        currentThreadId: input.roomGraphThreadId,
        langgraphThreadId: input.roomGraphThreadId,
        currentTaskId: input.taskId,
        currentTaskRunId: input.taskRunId,
        activatedToolNames: ["exec_command", "write_stdin"],
        activatedToolLeases: [],
        engagedSkillNames: [],
        memoryAccessEnvelope: null,
        relayCapabilities: {
          canExecuteLocal: true,
          canDelegateLocalExecution: true,
        },
        trustedExecutionEntrypoint: "background.task",
        delegatedLocalExecutionBindings: {},
        requiredHostRelays: {},
      } as unknown as NautiloState;
      const postModel = createPostModelNode(delegatedExecutionPolicyResolver, {
        delegatedLocalExecutionPortForState: () => port,
        foregroundChatFundingSession: funding,
        matchCommandApproval: () => Promise.resolve(null),
        createCommandApproval: () => Promise.resolve({
          id: `protected-task-local-approval-${input.taskRunId}`,
          created: true,
        }),
      });
      const tools = createToolsNode({
        personalFunding: true,
        personalTaskControls: true,
        delegatedLocalExecutionPortForState: () => port,
      });
      return runWithCapabilityFundingSession(
        funding.capabilityFunding,
        async () => {
          const workflow = entrypoint({
            name: `protected-task-local-approval-${input.taskRunId}`,
            checkpointer: new MemorySaver(),
          }, async () => postModel(state));
          const config = {
            configurable: {
              thread_id: `protected-task-local-approval-${input.taskRunId}`,
            },
          };
          const pending = await workflow.invoke({}, config);
          if (!hasSingleGraphInterrupt(pending)) {
            throw new Error(
              "Protected Task local approval checkpoint was unavailable",
            );
          }
          const approved = await workflow.invoke(new Command({
            resume: { approved: true, verb: "once" },
          }), config);
          const pin = approved.delegatedLocalExecutionBindings?.[call.id];
          if (pin?.version !== 4
            || pin.authority.taskId !== input.taskId
            || pin.authority.taskRunId !== input.taskRunId) {
            throw new Error(
              "Protected Task delegated local binding was unavailable",
            );
          }
          const result = await tools({ ...state, ...approved });
          const delivered = result.messages?.some(message =>
            message.getType() === "tool"
            && "tool_call_id" in message
            && message.tool_call_id === call.id,
          ) === true;
          if (!delivered) {
            throw new Error("Protected Task local result was unavailable");
          }
          return result;
        },
      );
    },
    async restore() {
      if (restored) return;
      restored = true;
      await registry.unregister(relayId);
      setRelayRegistry(priorRegistry);
      clearToolCatalog();
      if (priorCatalog !== null && priorCatalog !== undefined) {
        initToolCatalog(priorCatalog);
      }
    },
  });
}
