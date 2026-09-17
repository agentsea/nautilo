/**
 * M125 Phase 1.1 — `verify_identity` reads the PIN subject from the
 * runtime envelope on every invocation. Pre-M125 the factory captured
 * `getBootstrapOwnerId()` (the first claimer's `users.id`) so every
 * non-operator user's prove_it landed on the operator's PIN. The
 * factory is now context-free; the subject comes from
 * `envelope.ownerId` (same field `manage_memory` uses to attribute
 * writes).
 *
 * QA scenario #5 in ISSUE-M125: non-operator `prove_it` → PIN dialog
 * prompts for their own PIN, not the operator's.
 */
import { describe, test, expect } from "bun:test";
import type { MemoryAccessEnvelope } from "@nautilo/trust";
import { z } from "zod";
import {
  createVerifyIdentityTool,
  IDENTITY_VERIFIED_MESSAGE,
  identityVerificationResult,
} from "../../src/tools/trust/verify-identity";

function envelope(ownerId: string): MemoryAccessEnvelope {
  // The tool only reads `ownerId`; the rest is a structural stub.
  const stub = {
    ownerId,
    actorId: "actor-anything",
    agentId: "agent-anything",
    roomId: "",
    readableNamespaces: [],
    mutableNamespaces: [],
    writableNamespaces: [],
    toolPolicy: {},
  };
  return stub as unknown as MemoryAccessEnvelope;
}

describe("verify_identity tool — M125 Phase 1.1 (envelope-derived PIN subject)", () => {
  test("rejects when no context is provided (anonymous turn)", async () => {
    const tool = createVerifyIdentityTool();
    const result = await tool.invoke({});
    expect(result).toContain("verify_identity unavailable");
  });

  test("rejects when envelope has empty ownerId (anonymous / stranger)", async () => {
    const tool = createVerifyIdentityTool({
      memoryAccessEnvelope: envelope(""),
    });
    const result = await tool.invoke({});
    expect(result).toContain("verify_identity unavailable");
  });

  test("tool contract never asks the model to assign an identity role", () => {
    const tool = createVerifyIdentityTool();
    expect(tool.name).toBe("verify_identity");
    expect(tool.description).toContain("current user's identity");
    const shape = (tool.schema as z.ZodObject<Record<string, z.ZodTypeAny>>).shape;
    expect(Object.keys(shape)).toEqual([]);
  });

  test("successful verification is role-neutral", () => {
    expect(identityVerificationResult({ verified: true })).toBe(
      IDENTITY_VERIFIED_MESSAGE,
    );
    expect(IDENTITY_VERIFIED_MESSAGE).toContain("does not change or prove");
    expect(IDENTITY_VERIFIED_MESSAGE).not.toContain("authenticated as the owner");
    expect(identityVerificationResult({ verified: false })).toContain("failed");
  });
});
