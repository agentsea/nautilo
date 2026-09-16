import { describe, test, expect } from "bun:test";
import { buildAnonymousContext } from "../../src/app";

describe("buildAnonymousContext (M125 Phase 1.4)", () => {
  test("ownerId is empty (no operator impersonation)", () => {
    const ctx = buildAnonymousContext();
    expect(ctx.memoryAccess.ownerId).toBe("");
    expect(ctx.actorId).toBe("");
    expect(ctx.agentId).toBe("");
  });

  test("actorRole is 'anonymous' (grep-able)", () => {
    const ctx = buildAnonymousContext();
    expect(ctx.actorRole).toBe("anonymous");
  });

  test("memoryAccess envelope is fully scrubbed", () => {
    const ctx = buildAnonymousContext();
    const env = ctx.memoryAccess;
    expect(env.readableNamespaces).toEqual([]);
    expect(env.mutableNamespaces).toEqual([]);
    expect(env.writableNamespaces).toEqual([]);
    expect(env.roomId).toBe("");
  });

  test("toolPolicy is the guest tool policy (read-only-ish)", () => {
    const ctx = buildAnonymousContext();
    // Smoke check that something was provided; the precise shape is
    // owned by @nautilo/trust's buildGuestToolPolicy.
    expect(ctx.memoryAccess.toolPolicy).toBeDefined();
  });
});
