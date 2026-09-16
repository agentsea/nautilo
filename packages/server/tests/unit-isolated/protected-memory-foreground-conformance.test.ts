import { afterEach, describe, expect, mock, test } from "bun:test";
import { AIMessage } from "@langchain/core/messages";
import { DynamicStructuredTool } from "@langchain/core/tools";
import {
  ToolCatalog,
  clearToolCatalog,
  initToolCatalog,
  type ToolContext,
} from "@nautilo/catalog";
import {
  encodeMemoryPayloadV1,
  type AuthorizedHumanMemoryPreparedMutationJournal,
  type ProtectedAgentMemoryRepository,
} from "@nautilo/lattice-bridge";
import type { MemoryAccessEnvelope } from "@nautilo/trust";
import * as actualTrust from "@nautilo/trust";
import * as actualDb from "@nautilo/db";
import { z } from "zod";

import type { NautiloState } from "../../../agent/src/agent/state";
import type { ProtectedMemoryRoutePorts } from "../../src/routes/protected-memory-composition";
import { createDormantForegroundMemoryConformanceAssembly } from "../helpers/protected-memory-foreground-conformance";

mock.module("@nautilo/trust", () => ({
  ...actualTrust,
  findRoomsByNamespaceIds: async () => new Map(),
  resolveActorsDisplayMap: async () => new Map(),
}));
mock.module("@nautilo/db", () => ({
  ...actualDb,
  getSharedDirectDb: () => {
    throw new Error("Memory conformance uses injected ports, never a live database");
  },
}));

const MEMORY_ID = "10000000-0000-4000-8000-000000000001";
const NAMESPACE_ID = "20000000-0000-4000-8000-000000000001";
const namespaceAuthority = { sourceRoomId: "30000000-0000-4000-8000-000000000001",
  namespaceId: NAMESPACE_ID, currentGeneration: 0,
  retainedGenerations: [{ generation: 0, accessRevision: 0,
    headDigestBase64url: "AA", publicationDigestBase64url: "AA",
    publicationSetDigestBase64url: "AA", audienceFingerprintBase64url: "AA" }] };

afterEach(() => clearToolCatalog());

function dto() {
  return {
    dtoVersion: 1 as const,
    projection: {
      memoryId: MEMORY_ID,
      contentRevision: 1,
      cryptoAccessRevision: 0,
      importance: 0.5,
      tier: 1,
      createdAt: "2026-08-14T00:00:00.000Z",
      updatedAt: "2026-08-14T00:00:00.000Z",
      namespaceIds: [NAMESPACE_ID],
      requiredNamespaceIds: [NAMESPACE_ID],
      readAuthorities: [namespaceAuthority],
    },
    protectedPayload: {
      status: "encrypted" as const,
      cryptoObjectId: "memory:v1:fixture",
      payloadVersion: 1 as const,
      encryptedPayloadBytesBase64url: "AQ",
      accessManifestBytesBase64url: "Ag",
      accessSignerEvidence: [],
      namespaceEnvelopes: [{
        namespaceId: NAMESPACE_ID,
        envelopeBytesBase64url: "Aw",
      }],
    },
  };
}

function routePorts(): ProtectedMemoryRoutePorts {
  const unavailable = async () => ({
    dtoVersion: 1 as const,
    status: "unavailable" as const,
    reason: "encryption_pending" as const,
  });
  return {
    planCreate: unavailable,
    createPrepared: unavailable,
    updatePrepared: unavailable,
    list: mock(async () => ({
      dtoVersion: 1 as const,
      items: [dto()],
      nextCursor: null,
      memoryMode: "namespace" as const,
      total: 1,
    })),
    detail: unavailable,
    search: unavailable,
    brief: mock(async () => ({
      dtoVersion: 1 as const,
      items: [dto()],
      memoryMode: "namespace" as const,
    })),
    archive: unavailable,
    transitionTier: unavailable,
    restore: unavailable,
    planAccess: unavailable,
    commitAccess: unavailable,
  };
}

function journal(): AuthorizedHumanMemoryPreparedMutationJournal {
  return {
    capacity: async () => ({ full: false }),
    putBeforeSend: async () => {
      throw new Error("read-only conformance must not journal");
    },
    listDue: async () => [],
    withPrepared: async () => {
      throw new Error("read-only conformance must not open journal bytes");
    },
    recordOutcome: async () => {
      throw new Error("read-only conformance must not record a mutation");
    },
  };
}

function repository(): ProtectedAgentMemoryRepository {
  return Object.freeze({
    search: async () => ({ status: "success" as const, value: [] }),
    save: async () => ({ status: "success" as const, value: {
      id: MEMORY_ID, action: "created" as const,
    } }),
    replace: async () => ({ status: "success" as const, value: undefined }),
    setTier: async () => ({ status: "success" as const, value: undefined }),
  });
}

function agentState(): NautiloState {
  const call = {
    id: "call-conformance",
    name: "protected_memory_conformance",
    args: {},
    type: "tool_call" as const,
  };
  return {
    messages: [new AIMessage({ content: "", tool_calls: [call] })],
    approvedToolCalls: [call],
    actorRole: "owner",
    userId: "11111111-1111-4111-8111-111111111111",
    personaId: "11111111-1111-4111-8111-111111111111",
    turnId: "turn-conformance",
    agentId: "22222222-2222-4222-8222-222222222222",
    roomId: "room-conformance",
    activatedToolNames: [],
    activatedToolLeases: [],
    activationLeasesInitialized: false,
    engagedSkillNames: [],
    memoryAccessEnvelope: null,
    relayCapabilities: {},
  } as unknown as NautiloState;
}

describe("dormant foreground Memory conformance assembly", () => {
  test("wires one Human HTTP/client path and the real Agent tool path", async () => {
    const ports = routePorts();
    const agentRepository = repository();
    const envelope: MemoryAccessEnvelope = {
      memoryMode: "namespace",
      ownerId: "user-1",
      actorId: "actor-1",
      agentId: "agent-1",
      roomId: "30000000-0000-4000-8000-000000000001",
      toolPolicy: {},
      readableNamespaces: [NAMESPACE_ID],
      mutableNamespaces: [NAMESPACE_ID],
      writableNamespaces: [NAMESPACE_ID],
    };
    let toolContext: ToolContext | undefined;
    const catalog = new ToolCatalog();
    catalog.register({
      name: "protected_memory_conformance",
      exposure: "core",
      category: "development",
      trustTier: "guest",
      impact: "read-only",
      factory: (context) => {
        toolContext = context;
        return new DynamicStructuredTool({
          name: "protected_memory_conformance",
          description: "Observe the dormant protected Memory assembly",
          schema: z.object({}),
          func: async () => "ok",
        });
      },
    });
    initToolCatalog(catalog);

    const assembly = await createDormantForegroundMemoryConformanceAssembly({
      routeAuthority: {
        userId: "user-1",
        actorId: "actor-1",
        agentId: null,
        memoryMode: "namespace",
        readableNamespaceIds: [NAMESPACE_ID],
        mutableNamespaceIds: [NAMESPACE_ID],
        sourceRoomId: "30000000-0000-4000-8000-000000000001",
        writableNamespaceIds: [NAMESPACE_ID],
        scopeId: null,
        originWritableNamespaceId: null,
      },
      memoryEnvelope: envelope,
      routePorts: ports,
      humanContent: {
        prepareAccessReadiness: async () => {
          throw new Error("read-only conformance must not prepare access readiness");
        },
        openExact: async () => encodeMemoryPayloadV1({
          formatVersion: 1,
          content: "shared protected bytes",
          type: "general",
        }),
        prepareCreate: async () => {
          throw new Error("read-only conformance must not prepare create");
        },
        prepareUpdate: async () => {
          throw new Error("read-only conformance must not prepare update");
        },
        prepareAccess: async () => {
          throw new Error("read-only conformance must not prepare access");
        },
      },
      humanJournal: journal(),
      agentRepository,
    });
    try {
      const opened: string[] = [];
      await assembly.human.withBrief({}, ({ payload }) => {
        opened.push(payload.content);
      });
      await assembly.agentToolsNode(agentState());

      expect(opened).toEqual(["shared protected bytes"]);
      expect(ports.brief).toHaveBeenCalledTimes(1);
      expect(toolContext?.["protectedMemoryRepository"])
        .toBe(agentRepository);
    } finally {
      await assembly.close();
    }
  });
});
