import { describe, expect, test } from "bun:test";

import {
  BACKGROUND_ENCRYPTION_SURFACES,
  CONVERSATION_ENCRYPTION_SURFACES,
  MEMORY_ENCRYPTION_SURFACES,
  STRICT_SHADOW_BOUNDARY_REGISTRY,
  strictShadowCoveragePreview,
  strictShadowRuntimeHealthProjection,
} from "../../src/node/index.ts";

describe("M302 Strict Shadow boundary registry", () => {
  test("registers every reviewed Conversation, background, and Memory surface", () => {
    const reviewedIds = [
      ...CONVERSATION_ENCRYPTION_SURFACES.map((entry) =>
        `conversation.${entry.id}`
      ),
      ...BACKGROUND_ENCRYPTION_SURFACES.map((entry) =>
        `background.${entry.id}`
      ),
      ...MEMORY_ENCRYPTION_SURFACES.map((entry) => entry.id),
    ];
    const registeredIds = new Set(
      STRICT_SHADOW_BOUNDARY_REGISTRY.map((entry) => entry.id),
    );
    for (const id of reviewedIds) expect(registeredIds.has(id)).toBeTrue();
    expect(registeredIds.has("artifact.api.workspace")).toBeTrue();
    expect(registeredIds.has("record.foreground.recall")).toBeTrue();
    expect(registeredIds.has("system.unknown_boundary")).toBeTrue();
    expect(new Set(STRICT_SHADOW_BOUNDARY_REGISTRY.map((entry) => entry.id)).size)
      .toBe(STRICT_SHADOW_BOUNDARY_REGISTRY.length);
  });

  test("preserves actual Memory implementation state", () => {
    for (const memory of MEMORY_ENCRYPTION_SURFACES) {
      const registered = STRICT_SHADOW_BOUNDARY_REGISTRY.find((entry) =>
        entry.id === memory.id
      );
      expect(registered?.readiness).toBe(
        memory.implementationState === "protected"
          ? "protected"
          : "unsupported",
      );
    }
  });

  test("registers all invocation-protected foreground context reads", () => {
    for (const id of [
      "conversation.read.foreground_history",
      "conversation.read.foreground_journal",
      "conversation.read.foreground_records",
      "conversation.read.foreground_memory",
    ]) {
      expect(STRICT_SHADOW_BOUNDARY_REGISTRY.find((entry) => entry.id === id))
        .toMatchObject({
          readiness: "protected",
          actorClass: "agent",
          operation: "read",
        });
    }
  });

  test("registers the invocation-protected foreground checkpoint store", () => {
    expect(STRICT_SHADOW_BOUNDARY_REGISTRY.find((entry) =>
      entry.id === "conversation.write.foreground_checkpoint"
    )).toMatchObject({
      family: "checkpoint",
      operation: "write",
      actorClass: "agent",
      readiness: "protected",
    });
  });

  test("produces one complete deterministic activation preview", () => {
    const preview = strictShadowCoveragePreview();
    expect(preview.protected + preview.unsupported + preview.unexercised)
      .toBe(STRICT_SHADOW_BOUNDARY_REGISTRY.length);
    expect(preview.protected).toBeGreaterThan(0);
    expect(preview.unsupported).toBeGreaterThan(0);
    // PR1 completes the static review. Runtime evidence remains separately
    // unexercised until each boundary is actually touched.
    expect(preview.unexercised).toBe(0);
  });

  test("projects only exact current-revision observations onto the fixed registry", () => {
    const boundary = STRICT_SHADOW_BOUNDARY_REGISTRY.find((entry) =>
      entry.id === "artifact.api.workspace"
    )!;
    const observedAt = new Date("2026-09-01T10:00:00.000Z");
    const projection = strictShadowRuntimeHealthProjection(7, [{
      policyRevision: 7,
      boundaryId: boundary.id,
      family: boundary.family,
      operation: boundary.operation,
      actorClass: boundary.actorClass,
      state: "unsupported",
      reason: "unsupported_operation",
      occurrenceCount: 3n,
      lastObservedAt: observedAt,
    }, {
      policyRevision: 6,
      boundaryId: boundary.id,
      family: boundary.family,
      operation: boundary.operation,
      actorClass: boundary.actorClass,
      state: "verified",
      reason: "none",
      occurrenceCount: 99n,
      lastObservedAt: new Date("2026-09-01T11:00:00.000Z"),
    }]);
    expect(projection.unsupported).toBe(1);
    expect(projection.verified).toBe(0);
    expect(projection.unexercised).toBe(
      STRICT_SHADOW_BOUNDARY_REGISTRY.length - 1,
    );
    expect(projection.lastObservedAt).toEqual(observedAt);
    expect(projection.summaries.find((summary) =>
      summary.boundaryId === boundary.id
    )).toMatchObject({
      boundaryId: boundary.id,
      state: "unsupported",
      reason: "unsupported_operation",
      occurrenceCount: 3n,
    });
  });
});
