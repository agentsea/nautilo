import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as db from "@nautilo/db";
import type { NamespaceMemoryEnvelope } from "@nautilo/trust";
import * as trust from "@nautilo/trust";
import type { CapabilityFundingSession } from "../../src/runtime/capability-funding";
import * as trustAgentDb from "../../src/store/trust-agent-db";
import { surplusCredentialFingerprint } from "../../src/providers/surplus-reconciliation";
import { createGenerateImageTool } from "../../src/tools/media/generate-image";

const HUMAN_ID = "40000000-0000-4000-8000-000000000004";
const CREDENTIAL_ID = "50000000-0000-4000-8000-000000000005";
const DIRECT_CREDENTIAL_ID = "50000000-0000-4000-8000-000000000006";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function envelope(): NamespaceMemoryEnvelope {
  return {
    ownerId: HUMAN_ID,
    actorId: HUMAN_ID,
    agentId: "20000000-0000-4000-8000-000000000002",
    roomId: "room-1",
    readableNamespaces: ["ns-write"],
    mutableNamespaces: ["ns-write"],
    writableNamespaces: ["ns-write"],
    toolPolicy: {},
  };
}

let artifactsRoot: string;
let originalArtifactsRoot: string | undefined;
let originalFetch: typeof fetch;
const restores: Array<() => void> = [];

function stubArtifactPersistence(): void {
  const inserted = spyOn(db, "findArtifactByPathForNamespaces").mockResolvedValue(null);
  const created = spyOn(db, "insertArtifact").mockResolvedValue({ id: "artifact-row" } as never);
  const attached = spyOn(db, "attachArtifactToNamespace").mockResolvedValue(undefined as never);
  restores.push(() => inserted.mockRestore());
  restores.push(() => created.mockRestore());
  restores.push(() => attached.mockRestore());
}

function stubSurplusLedger(settlementFails = false): void {
  const begin = spyOn(db, "beginSurplusLlmAttempt").mockResolvedValue(undefined);
  const attach = spyOn(db, "attachSurplusRequestReceipt").mockResolvedValue(undefined);
  const settle = spyOn(db, "settleSurplusLlmAttempt").mockImplementation(async () => {
    if (settlementFails) throw new Error("ledger unavailable");
  });
  restores.push(() => begin.mockRestore());
  restores.push(() => attach.mockRestore());
  restores.push(() => settle.mockRestore());
}

beforeEach(() => {
  originalArtifactsRoot = process.env["NAUTILO_ARTIFACTS_ROOT"];
  originalFetch = globalThis.fetch;
  artifactsRoot = mkdtempSync(join(tmpdir(), "funded-image-"));
  process.env["NAUTILO_ARTIFACTS_ROOT"] = artifactsRoot;
  const trustDb = spyOn(trustAgentDb, "withAgentTrustContext")
    .mockImplementation(async (_context, run) => run({} as never));
  restores.push(() => trustDb.mockRestore());
  const write = spyOn(trust, "assertCanWriteArtifacts").mockResolvedValue();
  restores.push(() => write.mockRestore());
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  rmSync(artifactsRoot, { recursive: true, force: true });
  if (originalArtifactsRoot === undefined) delete process.env["NAUTILO_ARTIFACTS_ROOT"];
  else process.env["NAUTILO_ARTIFACTS_ROOT"] = originalArtifactsRoot;
  while (restores.length > 0) restores.pop()?.();
});

describe("generate_image request-local media funding", () => {
  test("injects the admitted personal Surplus key and settles actual cost once", async () => {
    delete process.env["VENICE_API_KEY"];
    delete process.env["SURPLUS_API_KEY"];
    const inserted = spyOn(db, "findArtifactByPathForNamespaces").mockResolvedValue(null);
    const created = spyOn(db, "insertArtifact").mockResolvedValue({ id: "artifact-row" } as never);
    const attached = spyOn(db, "attachArtifactToNamespace").mockResolvedValue(undefined as never);
    const attemptBegins: Array<Parameters<typeof db.beginSurplusLlmAttempt>[0]> = [];
    const receiptAttachments: Array<Parameters<typeof db.attachSurplusRequestReceipt>[0]> = [];
    const attemptSettlements: Array<Parameters<typeof db.settleSurplusLlmAttempt>[0]> = [];
    const beginAttempt = spyOn(db, "beginSurplusLlmAttempt").mockImplementation(async (input) => {
      attemptBegins.push(input);
    });
    const attachReceipt = spyOn(db, "attachSurplusRequestReceipt").mockImplementation(async (input) => {
      receiptAttachments.push(input);
    });
    const settleAttempt = spyOn(db, "settleSurplusLlmAttempt").mockImplementation(async (input) => {
      attemptSettlements.push(input);
    });
    restores.push(() => inserted.mockRestore());
    restores.push(() => created.mockRestore());
    restores.push(() => attached.mockRestore());
    restores.push(() => beginAttempt.mockRestore());
    restores.push(() => attachReceipt.mockRestore());
    restores.push(() => settleAttempt.mockRestore());

    let fetchCalls = 0;
    globalThis.fetch = ((_input: string | URL, init?: RequestInit) => {
      fetchCalls += 1;
      expect(new Headers(init?.headers).get("authorization"))
        .toBe("Bearer request-local-surplus-key");
      const requestId = new Headers(init?.headers).get("x-request-id");
      expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
      return Promise.resolve(new Response(JSON.stringify({
        data: [{ b64_json: PNG.toString("base64") }],
      }), {
        status: 200,
        headers: {
          "x-request-id": requestId!,
          "x-si-buyer-cost-micro": "8800",
          "x-si-marketplace-attempts": "1",
        },
      }));
    }) as unknown as typeof fetch;

    const funding: CapabilityFundingSession = {
      humanUserId: HUMAN_ID,
      resolveModel: () => Promise.resolve({
        modelId: "venice:gpt-image-2",
        preferenceRevision: 3,
      }),
      openModel: () => Promise.reject(new Error("unexpected model funding")),
      openService: () => Promise.reject(new Error("unexpected service funding")),
      openMedia: async (modelId, family, options) => {
        expect({ modelId, family, options }).toEqual({
          modelId: "venice:gpt-image-2",
          family: "image",
          options: { operation: "generate", directOnly: false },
        });
        return {
          modelId,
          family,
          funding: {
            humanUserId: HUMAN_ID,
            provider: "surplus",
            binding: {
              kind: "personal",
              providerRoute: "surplus",
              credentialId: CREDENTIAL_ID,
              credentialRevision: 7,
            },
            credentialFingerprint: "a".repeat(64),
          },
          runAttempt: (run) => run({
            apiKey: "request-local-surplus-key",
            usageFunding: {
              kind: "personal",
              humanUserId: HUMAN_ID,
              payerHumanId: HUMAN_ID,
              providerRoute: "surplus",
              credentialId: CREDENTIAL_ID,
              credentialRevision: 7,
            },
          }),
        };
      },
    };
    const tool = createGenerateImageTool({
      memoryAccessEnvelope: envelope(),
      causalHumanUserId: HUMAN_ID,
    }, {
      getCapabilityFundingSession: () => funding,
      beginProviderCostAttempt: () => Promise.reject(
        new Error("generic provider-cost ledger must not record Surplus image attempts"),
      ),
      assertCanUseServerProviderCredentials: () => Promise.reject(
        new Error("server credential admission must not run"),
      ),
    });

    const raw = await tool.invoke({ prompt: "a small lighthouse" });
    const result = JSON.parse(raw) as {
      provider: string;
      canonicalProvider: string;
      images: Array<{ artifactId: string }>;
    };

    expect(fetchCalls).toBe(1);
    expect(result.provider).toBe("surplus");
    expect(result.canonicalProvider).toBe("venice");
    expect(statSync(join(artifactsRoot, result.images[0]!.artifactId)).size)
      .toBe(PNG.byteLength);
    expect(attemptBegins).toHaveLength(1);
    const attemptId = attemptBegins[0]!.id;
    expect(attemptBegins[0]).toMatchObject({
      id: attemptId,
      callType: "image_gen",
      model: "venice:gpt-image-2",
      provider: "venice",
      endpoint: "/v1/images/generations",
      fundingKind: "personal",
      payerHumanId: HUMAN_ID,
      credentialId: CREDENTIAL_ID,
      credentialRevision: 7,
      metadata: {
        surplusUnpinnedMedia: true,
        surplusModelId: "venice-gpt-image-2",
        catalogModelId: "venice:gpt-image-2",
        surplusCredentialFingerprint: surplusCredentialFingerprint("request-local-surplus-key"),
      },
    });
    expect(receiptAttachments.map((receipt) => receipt.providerRequestId))
      .toEqual([attemptId]);
    expect(attemptSettlements).toEqual([{
      attemptId,
      providerRequestId: attemptId,
      metadata: {
        surplusMarketplaceAttempts: 1,
        surplusTruncated: false,
      },
      outcome: "succeeded",
      costState: "actual",
      actualCostUsd: 0.0088,
    }]);
  });

  test.each(["personal", "server"] as const)("%s Surplus falls back once to the same model through admitted personal direct funding after a no-seller refusal", async (primaryKind) => {
    stubArtifactPersistence();
    stubSurplusLedger();
    const directAdmissions: unknown[] = [];
    const directSettlements: unknown[] = [];
    let fetchCalls = 0;
    globalThis.fetch = ((_input: string | URL, init?: RequestInit) => {
      fetchCalls += 1;
      const authorization = new Headers(init?.headers).get("authorization");
      if (fetchCalls === 1) {
        expect(authorization).toBe("Bearer request-local-surplus-key");
        return Promise.resolve(new Response(JSON.stringify({
          error: { code: "no_sellers_for_model" },
        }), {
          status: 404,
          headers: { "x-si-marketplace-attempts": "0" },
        }));
      }
      expect(authorization).toBe("Bearer request-local-venice-key");
      return Promise.resolve(new Response(JSON.stringify({
        images: [PNG.toString("base64")],
      }), { status: 200 }));
    }) as unknown as typeof fetch;

    const surplusFunding = {
      humanUserId: HUMAN_ID,
      provider: "surplus" as const,
      binding: primaryKind === "server"
        ? { kind: "server" as const, providerRoute: "surplus" }
        : { kind: "personal" as const, providerRoute: "surplus", credentialId: CREDENTIAL_ID, credentialRevision: 7 },
      credentialFingerprint: "a".repeat(64),
    };
    let openMediaCalls = 0;
    const funding: CapabilityFundingSession = {
      humanUserId: HUMAN_ID,
      resolveModel: () => Promise.resolve({
        modelId: "venice:gpt-image-2",
        preferenceRevision: 3,
      }),
      openModel: () => Promise.reject(new Error("unexpected model funding")),
      openService: () => Promise.reject(new Error("unexpected service funding")),
      openMedia: async (modelId, family, options) => {
        openMediaCalls += 1;
        expect(modelId).toBe("venice:gpt-image-2");
        expect(family).toBe("image");
        if (openMediaCalls === 1) {
          expect(options).toEqual({ operation: "generate", directOnly: false });
          return {
            modelId,
            family,
            funding: surplusFunding,
            runAttempt: (run) => run({
              apiKey: "request-local-surplus-key",
              usageFunding: primaryKind === "server"
                ? { kind: "server", humanUserId: HUMAN_ID, providerRoute: "surplus" }
                : { kind: "personal", humanUserId: HUMAN_ID, payerHumanId: HUMAN_ID, providerRoute: "surplus", credentialId: CREDENTIAL_ID, credentialRevision: 7 },
            }),
          };
        }
        expect(options).toEqual({
          operation: "generate",
          directOnly: true,
          transport: "direct",
          prior: surplusFunding,
        });
        return {
          modelId,
          family,
          funding: {
            humanUserId: HUMAN_ID,
            provider: "venice",
            binding: {
              kind: "personal",
              providerRoute: "venice",
              credentialId: DIRECT_CREDENTIAL_ID,
              credentialRevision: 2,
            },
            credentialFingerprint: "b".repeat(64),
          },
          runAttempt: (run) => run({
            apiKey: "request-local-venice-key",
            usageFunding: {
              kind: "personal",
              humanUserId: HUMAN_ID,
              payerHumanId: HUMAN_ID,
              providerRoute: "venice",
              credentialId: DIRECT_CREDENTIAL_ID,
              credentialRevision: 2,
            },
          }),
        };
      },
    };
    const tool = createGenerateImageTool({
      memoryAccessEnvelope: envelope(),
      causalHumanUserId: HUMAN_ID,
    }, {
      getCapabilityFundingSession: () => funding,
      beginProviderCostAttempt: async (_context, admission) => {
        directAdmissions.push(admission);
        return async (receipt) => { directSettlements.push(receipt); };
      },
      assertCanUseServerProviderCredentials: () => Promise.reject(
        new Error("server credential admission must not run"),
      ),
    });

    const raw = await tool.invoke({ prompt: "a small lighthouse" });
    const result = JSON.parse(raw) as {
      model: string;
      provider: string;
      canonicalProvider: string;
      images: Array<{ artifactId: string }>;
    };

    expect(fetchCalls).toBe(2);
    expect(openMediaCalls).toBe(2);
    expect(result).toMatchObject({
      model: "venice:gpt-image-2",
      provider: "venice",
      canonicalProvider: "venice",
    });
    expect(statSync(join(artifactsRoot, result.images[0]!.artifactId)).size)
      .toBe(PNG.byteLength);
    expect(directAdmissions).toHaveLength(1);
    const directAdmission = directAdmissions[0] as {
      provider: string;
      operation: string;
      usageFunding: { kind: string; payerHumanId: string; providerRoute: string };
    };
    expect(directAdmission.provider).toBe("venice");
    expect(directAdmission.operation).toBe("image_generation");
    expect(directAdmission.usageFunding.kind).toBe("personal");
    expect(directAdmission.usageFunding.payerHumanId).toBe(HUMAN_ID);
    expect(directAdmission.usageFunding.providerRoute).toBe("venice");
    expect(directSettlements).toEqual([expect.objectContaining({
      provider: "venice",
      operation: "image_generation",
      attemptOutcome: "succeeded",
      evidenceState: "estimated",
    })]);
  });

  test.each([
    ["missing direct key", "A personal provider credential is missing."],
    ["policy rejection", "Personal provider credentials are not permitted."],
    ["key rotation", "The admitted personal provider credential changed."],
  ])("terminates when fallback re-admission fails for %s", async (_name, message) => {
    stubArtifactPersistence();
    stubSurplusLedger();
    let fetchCalls = 0;
    globalThis.fetch = (() => {
      fetchCalls += 1;
      return Promise.resolve(new Response(JSON.stringify({
        error: { code: "no_sellers_for_model" },
      }), {
        status: 404,
        headers: { "x-si-marketplace-attempts": "0" },
      }));
    }) as unknown as typeof fetch;
    const surplusFunding = {
      humanUserId: HUMAN_ID,
      provider: "surplus" as const,
      binding: {
        kind: "personal" as const,
        providerRoute: "surplus",
        credentialId: CREDENTIAL_ID,
        credentialRevision: 7,
      },
      credentialFingerprint: "a".repeat(64),
    };
    let openMediaCalls = 0;
    const funding: CapabilityFundingSession = {
      humanUserId: HUMAN_ID,
      resolveModel: () => Promise.resolve({
        modelId: "venice:gpt-image-2",
        preferenceRevision: 3,
      }),
      openModel: () => Promise.reject(new Error("unexpected model funding")),
      openService: () => Promise.reject(new Error("unexpected service funding")),
      openMedia: async (modelId, family) => {
        openMediaCalls += 1;
        if (openMediaCalls > 1) throw new Error(message);
        return {
          modelId,
          family,
          funding: surplusFunding,
          runAttempt: (run) => run({
            apiKey: "request-local-surplus-key",
            usageFunding: {
              kind: "personal",
              humanUserId: HUMAN_ID,
              payerHumanId: HUMAN_ID,
              providerRoute: "surplus",
              credentialId: CREDENTIAL_ID,
              credentialRevision: 7,
            },
          }),
        };
      },
    };
    const tool = createGenerateImageTool({
      memoryAccessEnvelope: envelope(),
      causalHumanUserId: HUMAN_ID,
    }, {
      getCapabilityFundingSession: () => funding,
      beginProviderCostAttempt: () => Promise.reject(
        new Error("direct cost attempt must not begin"),
      ),
      assertCanUseServerProviderCredentials: () => Promise.reject(
        new Error("server credential admission must not run"),
      ),
    });

    const raw = await tool.invoke({ prompt: "a small lighthouse" });

    expect(raw).toBe(`Error: ${message}`);
    expect(openMediaCalls).toBe(2);
    expect(fetchCalls).toBe(1);
  });

  test.each([
    {
      name: "network-uncertain request",
      settlementFails: false,
      response: () => Promise.reject(new TypeError("connection reset")),
    },
    {
      name: "charged refusal",
      settlementFails: false,
      response: () => Promise.resolve(new Response(JSON.stringify({
        error: { code: "no_sellers_for_model" },
      }), {
        status: 404,
        headers: {
          "x-si-marketplace-attempts": "0",
          "x-si-buyer-cost-micro": "1",
        },
      })),
    },
    {
      name: "safe refusal whose ledger settlement fails",
      settlementFails: true,
      response: () => Promise.resolve(new Response(JSON.stringify({
        error: { code: "no_sellers_for_model" },
      }), {
        status: 404,
        headers: { "x-si-marketplace-attempts": "0" },
      })),
    },
  ])("does not replay a $name", async ({ response, settlementFails }) => {
    stubArtifactPersistence();
    stubSurplusLedger(settlementFails);
    let fetchCalls = 0;
    globalThis.fetch = (() => {
      fetchCalls += 1;
      return response();
    }) as unknown as typeof fetch;
    let openMediaCalls = 0;
    const funding: CapabilityFundingSession = {
      humanUserId: HUMAN_ID,
      resolveModel: () => Promise.resolve({
        modelId: "venice:gpt-image-2",
        preferenceRevision: 3,
      }),
      openModel: () => Promise.reject(new Error("unexpected model funding")),
      openService: () => Promise.reject(new Error("unexpected service funding")),
      openMedia: async (modelId, family) => {
        openMediaCalls += 1;
        return {
          modelId,
          family,
          funding: {
            humanUserId: HUMAN_ID,
            provider: "surplus",
            binding: {
              kind: "personal",
              providerRoute: "surplus",
              credentialId: CREDENTIAL_ID,
              credentialRevision: 7,
            },
            credentialFingerprint: "a".repeat(64),
          },
          runAttempt: (run) => run({
            apiKey: "request-local-surplus-key",
            usageFunding: {
              kind: "personal",
              humanUserId: HUMAN_ID,
              payerHumanId: HUMAN_ID,
              providerRoute: "surplus",
              credentialId: CREDENTIAL_ID,
              credentialRevision: 7,
            },
          }),
        };
      },
    };
    const tool = createGenerateImageTool({
      memoryAccessEnvelope: envelope(),
      causalHumanUserId: HUMAN_ID,
    }, {
      getCapabilityFundingSession: () => funding,
      beginProviderCostAttempt: () => Promise.reject(
        new Error("direct cost attempt must not begin"),
      ),
    });

    const raw = await tool.invoke({ prompt: "a small lighthouse" });

    expect(raw).toStartWith("Error:");
    expect(openMediaCalls).toBe(1);
    expect(fetchCalls).toBe(1);
  });
});
