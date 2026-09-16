import { describe, expect, test } from "bun:test";
import {
  APP_OPERATION_ID_PREFIX,
  createAppOperationId,
  ensureAppOperationContext,
  isAppOperationId,
} from "../../src/apps/app-operation-id";
import type { AppToolRunnerContext } from "../../src/apps/app-tool-types";

function baseContext(overrides?: Partial<AppToolRunnerContext>): AppToolRunnerContext {
  return {
    ownerId: "owner-1",
    userId: "user-1",
    agentId: "agent-1",
    memoryAccessEnvelope: {} as never,
    ...overrides,
  };
}

describe("app-operation-id (M206)", () => {
  test("createAppOperationId uses app:<appId>:<uuid> shape", () => {
    const id = createAppOperationId("writer");
    expect(id.startsWith(`${APP_OPERATION_ID_PREFIX}writer:`)).toBe(true);
    expect(isAppOperationId(id)).toBe(true);
  });

  test("ensureAppOperationContext allocates once for UI invokes without turnId", () => {
    const first = ensureAppOperationContext(baseContext({ turnId: null }), "writer");
    const second = ensureAppOperationContext(first, "writer");
    expect(first.appOperationId).toBeDefined();
    expect(second.appOperationId).toBe(first.appOperationId);
  });

  test("ensureAppOperationContext preserves agent turnId and skips app-operation id", () => {
    const ctx = ensureAppOperationContext(baseContext({ turnId: "turn-graph-9" }), "writer");
    expect(ctx.turnId).toBe("turn-graph-9");
    expect(ctx.appOperationId).toBeUndefined();
  });
});
