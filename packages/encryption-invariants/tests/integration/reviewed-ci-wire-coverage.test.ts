import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { DTO_BASELINE_DECLARATIONS } from "../../baseline/dto-declarations";
import {
  REVIEWED_CI_DTO_REPLACEMENTS,
  REVIEWED_CI_NEW_DTO_DECLARATIONS,
  reviewedCiDtoReplacements,
} from "../../baseline/reviewed-ci-dto";
import {
  REVIEWED_CI_WIRE_COVERAGE_ENTRIES,
  REVIEWED_CI_WIRE_DEBT_LINKS,
} from "../../baseline/reviewed-ci-wire-coverage";
import {
  BASELINE_REGISTRY,
  CURRENT_FROZEN_BASELINE_DEBT,
  WAVE_0_FROZEN_BASELINE_DEBT,
} from "../../baseline/existing-debt";
import { validateCoverageEntry } from "../../src/model";
import { reviewedDebtLinkErrors } from "../../src/registry";
import {
  auditDtoDeclarations,
  discoverDtoInventory,
} from "../../src/node/dto-inventory";

const repositoryRoot = resolve(import.meta.dir, "../../../..");

describe("current CI wire reconciliation", () => {
  test("replaces exact predecessors and adds only new declarations", async () => {
    expect(REVIEWED_CI_DTO_REPLACEMENTS).toHaveLength(38);
    expect(REVIEWED_CI_NEW_DTO_DECLARATIONS).toHaveLength(12);
    expect(() => reviewedCiDtoReplacements(DTO_BASELINE_DECLARATIONS))
      .toThrow("CI DTO predecessor changed");

    const locators = new Set<string>([
      ...REVIEWED_CI_DTO_REPLACEMENTS.map((entry) => entry.locator),
      ...REVIEWED_CI_NEW_DTO_DECLARATIONS.map((entry) => entry.locator),
    ]);
    expect(locators.size).toBe(50);
    const declarations = DTO_BASELINE_DECLARATIONS.filter((entry) =>
      locators.has(entry.locator));
    const observations = (await discoverDtoInventory(repositoryRoot)).filter(
      (entry) => locators.has(entry.locator),
    );
    expect(declarations).toHaveLength(50);
    expect(observations).toHaveLength(50);
    expect(auditDtoDeclarations({ observations, declarations })).toEqual({
      ok: true,
      counts: {
        observations: 50,
        declarations: 50,
        arbitraryPayloads: 21,
      },
    });
  }, 60_000);

  test("classifies exact private plaintext carriers and content-free metadata", async () => {
    expect(REVIEWED_CI_WIRE_COVERAGE_ENTRIES).toHaveLength(14);
    expect(REVIEWED_CI_WIRE_DEBT_LINKS).toHaveLength(3);
    expect(WAVE_0_FROZEN_BASELINE_DEBT).toHaveLength(1590);
    for (const entry of REVIEWED_CI_WIRE_COVERAGE_ENTRIES) {
      expect(validateCoverageEntry(entry)).toEqual({ ok: true });
      expect(BASELINE_REGISTRY.entries).toContainEqual(entry);
    }
    for (const link of REVIEWED_CI_WIRE_DEBT_LINKS) {
      expect(BASELINE_REGISTRY.reviewedDebtLinks).toContainEqual(link);
    }

    const authorized = REVIEWED_CI_WIRE_COVERAGE_ENTRIES.filter((entry) =>
      entry.classification === "authorized_plaintext");
    expect(authorized.map((entry) => entry.locator)).toEqual([
      "http:request_response:GET /v1/avatar",
      "http:request_response:POST /v1/publications/:id/claim",
      "http:request_response:POST /v1/turns",
    ]);
    expect(authorized.every((entry) =>
      entry.classification === "authorized_plaintext"
      && entry.mode === "plaintext_only"
      && entry.releaseImpact === "blocks_whole_product_claim"
    )).toBe(true);

    const operatorSecrets = REVIEWED_CI_WIRE_COVERAGE_ENTRIES.filter((entry) =>
      entry.classification === "operator_secret");
    expect(operatorSecrets.map((entry) => entry.locator)).toEqual([
      "http:request_response:POST /v1/publications/:id/authorize",
      "http:request_response:POST /v1/publications/:id/settle",
    ]);
    expect(operatorSecrets.every((entry) =>
      entry.classification === "operator_secret"
      && entry.excludedFromAgentGrants
    )).toBe(true);

    const metadataByLocator = new Map(REVIEWED_CI_WIRE_COVERAGE_ENTRIES
      .filter((entry) => entry.classification === "bounded_metadata")
      .map((entry) => [entry.locator, entry.metadataAllowlist] as const));
    expect(metadataByLocator.get("http:request_response:GET /v1/status")).toEqual([
      "status", "operatorBindingId", "providerAgentId", "chatId", "senderId", "error",
    ]);
    for (const method of ["GET", "DELETE"]) {
      expect(metadataByLocator.get(`http:request_response:${method} /v1/turns/:id`)).toEqual([
        "id", "receiptId", "state", "outboxId", "publicationState", "error",
      ]);
    }
    for (const action of ["pause", "revoke"]) {
      expect(metadataByLocator.get(`http:request_response:POST /v1/binding/${action}`)).toEqual([
        "state", "error",
      ]);
    }

    const routeSource = await Bun.file(resolve(
      repositoryRoot,
      "packages/server/src/messaging/magent-unix.ts",
    )).text();
    expect(routeSource).toContain("Fastify({ logger: false");
    expect(routeSource).toContain("app.addHook(\"onRequest\"");
    expect(routeSource).toContain("timingSafeEqual(expected, actual)");
    expect(routeSource).toContain("app.setErrorHandler((_error, _request, reply)");
    expect(routeSource).toContain('{ error: "unauthorized" }');
    expect(routeSource).toContain('{ error: "request_unavailable" }');
    expect(routeSource).toContain('{ error: "authority_or_state_unavailable" }');
    expect(routeSource).toContain("return reply.type(avatar.contentType).send(Buffer.from(avatar.bytes));");
    expect(routeSource).not.toMatch(/\b(?:console|logger)\s*[.(]/u);

    const serviceSource = await Bun.file(resolve(
      repositoryRoot,
      "packages/server/src/messaging/magent-operator.ts",
    )).text();
    const normalizedServiceSource = serviceSource.replace(/\s+/gu, " ");
    expect(normalizedServiceSource).toContain('return { status: await available() ? "ready" : "withdrawn", operatorBindingId: config.operatorBindingId, providerAgentId: config.providerAgentId, chatId: config.chatId, senderId: config.senderId };');
    expect(normalizedServiceSource).toContain("return { receiptId: result.acceptance.receipt.id, state: result.acceptance.receipt.state, dispatch: result.dispatch };");
    expect(normalizedServiceSource).toContain("return content ? { outboxId, claimToken, content: content.content } : null;");
    expect(normalizedServiceSource).toContain("? { authorized: true } : null;");
    expect(normalizedServiceSource).toContain("return settled ? { outboxId, state: settled.state, providerMessageId: settled.providerMessageId } : null;");
    expect(normalizedServiceSource).toContain("return { state: changed.binding.state };");

    const transportSource = await Bun.file(resolve(
      repositoryRoot,
      "packages/types/src/magent-transport.ts",
    )).text();
    expect(transportSource).toContain("content: z.string().refine(value => value.trim().length > 0)");
    expect(transportSource).toContain("export const magentPublicationClaimSchema = z.object({ claimToken: z.uuid() }).strict();");
    expect(transportSource).toContain('z.object({ claimToken: z.uuid(), state: z.literal("published"), providerMessageId: opaqueId }).strict()');

    const receiptSource = await Bun.file(resolve(
      repositoryRoot,
      "packages/db/src/queries/bolter-bridge.ts",
    )).text();
    expect(receiptSource.replace(/\s+/gu, " ")).toContain(
      'return { receiptId, state: row.receipt.state === "cancelled" || row.receipt.state === "quarantined" ? "cancelled" : row.job?.status === "completed" ? "completed" : ["failed", "timed_out"].includes(row.job?.status ?? "") ? "failed" : row.job?.status === "cancelled" ? "cancelled" : "pending", ...(row.publication ? { outboxId: row.publication.id, publicationState: row.publication.state } : {}) };',
    );
  });

  test("links attachment and whole-message DTO roots only to existing frozen debt", () => {
    const byLocator = new Map(REVIEWED_CI_WIRE_DEBT_LINKS.map((entry) =>
      [entry.locator, entry] as const));
    expect(byLocator.get(
      "http:request_response:POST /api/message-attachments#request.query.purpose",
    )?.targetDebtIds).toEqual([
      "debt.wire.http.request.response.post.api.message.attachments.1gvp9l8",
    ]);
    for (const locator of [
      "http:accepted_arbitrary:packages/types/src/api.ts#RoomMessageDto",
      "http:accepted_arbitrary:packages/types/src/api.ts#RoomMessagesAroundPage",
    ]) expect(byLocator.get(locator)?.targetDebtIds).toEqual([
      "debt.wire.http.request.response.get.api.rooms.id.messages.1f82u0n",
    ]);
    expect(reviewedDebtLinkErrors({
      ...BASELINE_REGISTRY,
      reviewedDebtLinks: REVIEWED_CI_WIRE_DEBT_LINKS,
    }, CURRENT_FROZEN_BASELINE_DEBT)).toEqual([]);
  });

  test("keeps model lineage and refetch hints content-free", async () => {
    const byLocator = new Map(REVIEWED_CI_WIRE_COVERAGE_ENTRIES.map((entry) =>
      [entry.locator, entry] as const));
    for (const locator of [
      "http:accepted_arbitrary:packages/types/src/api.ts#RoomMessageDto#modelInputExposure",
      "http:accepted_arbitrary:packages/types/src/api.ts#RoomMessagesAroundPage#messages[].modelInputExposure",
      "http:request_response:GET /api/memory/processor-recipient/v2",
      "ws:server_to_client:bolter.state.changed",
    ]) expect(byLocator.get(locator)?.classification).toBe("bounded_metadata");

    const memoryRecipient = DTO_BASELINE_DECLARATIONS.find((entry) =>
      entry.locator === "http:request_response:GET /api/memory/processor-recipient/v2"
    );
    expect(memoryRecipient?.structuralSignatures).toEqual([
      'response.body:{embedding?:{canonicalSpace:{dimensions:1536;model:string;provider:"openai"|"openrouter"|"venice"};contractVersion:2;processingRoute:{dataRecipientClasses:["surplus","marketplace_seller","seller_upstream_processor"];marketplacePolicyVersion:"surplus-embedding-marketplace-v1";transport:"surplus_marketplace"}|{transport:"direct"}}|{dimensions:1536;model:string;provider:"openai"|"openrouter"|"venice"};formatVersion:number;publicKeyBase64url:string;purpose:"memory.foreground_embedding";recipientId:string}',
      "response.body:{error:string}",
    ]);
    const memoryCoverage = byLocator.get(
      "http:request_response:GET /api/memory/processor-recipient/v2",
    );
    expect(memoryCoverage?.classification).toBe("bounded_metadata");
    if (memoryCoverage?.classification !== "bounded_metadata") {
      throw new Error("Memory recipient v2 must remain bounded metadata");
    }
    expect(memoryCoverage.metadataAllowlist).toEqual([
      "formatVersion", "recipientId", "publicKeyBase64url", "purpose", "error",
      "embedding.dimensions", "embedding.model", "embedding.provider",
      "embedding.contractVersion", "embedding.canonicalSpace.dimensions",
      "embedding.canonicalSpace.model", "embedding.canonicalSpace.provider",
      "embedding.processingRoute.transport",
      "embedding.processingRoute.dataRecipientClasses[]",
      "embedding.processingRoute.marketplacePolicyVersion",
    ]);

    const realtime = await Bun.file(resolve(
      repositoryRoot,
      "packages/types/src/realtime.ts",
    )).text();
    expect(realtime).toContain("export interface BolterStateChangedEvent {\n  type: \"bolter.state.changed\";\n}");

    const codec = await Bun.file(resolve(
      repositoryRoot,
      "packages/reflection/src/model-input-exposure-metadata-v1.ts",
    )).text();
    expect(codec).toContain("exactKeys(candidate, [\"version\", \"status\", \"dependencies\"])");
    expect(codec).toContain("normalizeRecordModelExposureDependenciesV1");
    expect(codec).toContain("RECORD_PAYLOAD_V1_LIMITS.payloadBytes");
  });
});
