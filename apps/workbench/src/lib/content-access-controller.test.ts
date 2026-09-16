import { describe, expect, mock, test } from "bun:test";
import {
  ContentAccessController,
  ContentAccessScopeChangedError,
  type ContentAccessControllerPort,
} from "./content-access-controller";
import type { ContentAccessPendingOperationsPort } from "./content-access-pending-operations";

const roomId = "11111111-1111-4111-8111-111111111111";
const object = { kind: "artifact" as const, id: "22222222-2222-4222-8222-222222222222" };
const subject = { object, label: "plan.md" };
const prepared = (operationId = "33333333-3333-4333-8333-333333333333") => ({
  outcome: "prepared" as const,
  command: { operationId, object, change: { kind: "make_private" as const } },
  previewToken: "token",
  expiresAt: 2_000,
  preview: { humanActorIds: [], publicRoom: false, skippedAttachmentCount: 0 },
});

function port(overrides: Partial<ContentAccessControllerPort> = {}): ContentAccessControllerPort {
  return {
    getContentAccess: mock(async () => ({ object, people: [], rooms: [], otherAccessCount: 0 })),
    prepareContentAccess: mock(async () => prepared()),
    commitContentAccess: mock(async (command) => ({ operationId: command.operationId,
      outcome: "applied" as const, stateChanged: true, originalStateChanged: true,
      replayed: false, attachedCount: 0, detachedCount: 1, skippedCount: 0 })),
    ...overrides,
  };
}

const pendingOperations: ContentAccessPendingOperationsPort = {
  restore: () => [],
  execute: async (_operation, dispatch) => dispatch(),
};

describe("ContentAccessController", () => {
  test("fences a pending request when its Room/session scope is disposed", async () => {
    let resolve!: (value: ReturnType<typeof prepared>) => void;
    const api = port({ prepareContentAccess: () => new Promise((done) => { resolve = done; }) });
    const controller = new ContentAccessController(api, roomId, () => 1_000,
      () => prepared().command.operationId, pendingOperations);
    const pending = controller.prepare([subject], { kind: "make_private" });
    controller.dispose();
    resolve(prepared());
    await expect(pending).rejects.toBeInstanceOf(ContentAccessScopeChangedError);
  });

  test("does not silently reprepare an expired preview", async () => {
    const api = port();
    const controller = new ContentAccessController(api, roomId, () => 2_000, undefined, pendingOperations);
    const entries = await controller.prepare([subject], { kind: "make_private" });
    const result = await controller.commit(entries);
    expect(result[0]?.phase).toBe("expired");
    expect(api.commitContentAccess).not.toHaveBeenCalled();
    expect(api.prepareContentAccess).toHaveBeenCalledTimes(1);
  });

  test("retains the exact command and token for an unknown retry", async () => {
    const failure = Object.assign(new Error("Result unknown"), { recovery: "retry_receipt" });
    const commit = mock().mockRejectedValueOnce(failure).mockResolvedValueOnce({
      operationId: prepared().command.operationId, outcome: "already_applied", stateChanged: false,
      originalStateChanged: true, replayed: true, attachedCount: 1, detachedCount: 0, skippedCount: 0,
    });
    const api = port({ commitContentAccess: commit });
    const controller = new ContentAccessController(api, roomId, () => 1_000, undefined, pendingOperations);
    const entries = await controller.prepare([subject], { kind: "make_private" });
    const uncertain = await controller.commit(entries);
    expect(uncertain[0]?.phase).toBe("retryable");
    const recovered = await controller.commit(uncertain);
    expect(recovered[0]?.phase).toBe("complete");
    expect(commit.mock.calls[1]?.[0]).toEqual(commit.mock.calls[0]?.[0]);
    expect(commit.mock.calls[1]?.[1]).toBe(commit.mock.calls[0]?.[1]);
    expect(api.prepareContentAccess).toHaveBeenCalledTimes(1);
  });

  test("retries an indeterminate exact operation after the preview deadline", async () => {
    let now = 1_000;
    const commit = mock()
      .mockRejectedValueOnce(Object.assign(new Error("Result unknown"), { recovery: "retry_receipt" }))
      .mockResolvedValueOnce({ operationId: prepared().command.operationId, outcome: "already_applied",
        stateChanged: false, originalStateChanged: true, replayed: true,
        attachedCount: 1, detachedCount: 0, skippedCount: 0 });
    const api = port({ commitContentAccess: commit });
    const controller = new ContentAccessController(api, roomId, () => now, undefined, pendingOperations);
    const uncertain = await controller.commit(await controller.prepare([subject], { kind: "make_private" }));
    now = 5_000;
    const recovered = await controller.commit(uncertain);
    expect(recovered[0]?.phase).toBe("complete");
    expect(commit).toHaveBeenCalledTimes(2);
    expect(api.prepareContentAccess).toHaveBeenCalledTimes(1);
  });

  test("keeps partial and failed batch objects unresolved while skipping completed objects", async () => {
    const second = { object: { kind: "artifact" as const, id: "44444444-4444-4444-8444-444444444444" }, label: "notes.md" };
    const third = { object: { kind: "artifact" as const, id: "55555555-5555-4555-8555-555555555555" }, label: "draft.md" };
    const commit = mock(async (command: ReturnType<typeof prepared>["command"]) => {
      if (command.object.id === object.id) return { operationId: command.operationId, outcome: "applied" as const,
        stateChanged: true, originalStateChanged: true, replayed: false, attachedCount: 1, detachedCount: 0, skippedCount: 0 };
      if (command.object.id === second.object.id) return { operationId: command.operationId, outcome: "partial" as const,
        stateChanged: true, originalStateChanged: true, replayed: false, attachedCount: 1, detachedCount: 0, skippedCount: 1 };
      throw Object.assign(new Error("Try exact operation"), { recovery: "retry_operation" });
    });
    const api = port({
      prepareContentAccess: mock(async (input) => ({ ...prepared(input.operationId), command: input })),
      commitContentAccess: commit,
    });
    let sequence = 0;
    const retained = new Map<string, unknown>();
    const durable: ContentAccessPendingOperationsPort = {
      restore: () => [],
      execute: async (operation, dispatch) => {
        retained.set(operation.command.object.id, operation);
        try {
          const result = await dispatch();
          retained.delete(operation.command.object.id);
          return result;
        } catch (error) {
          throw error;
        }
      },
    };
    const controller = new ContentAccessController(api, roomId, () => 1_000,
      () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
      durable);
    const entries = await controller.prepare([subject, second, third], { kind: "grant_room", targetRoomId: roomId });
    const first = await controller.commit(entries);
    expect(first.map((entry) => entry.phase)).toEqual(["complete", "partial", "retryable"]);
    expect([...retained.keys()]).toEqual([third.object.id]);
    const retried = await controller.commit(first);
    expect(retried[0]?.phase).toBe("complete");
    expect(retried[1]?.phase).toBe("partial");
    expect(commit).toHaveBeenCalledTimes(4);
  });

  test("restores exact pending operations with current labels and no preview or reprepare", () => {
    const exact = { command: prepared().command, previewToken: "persisted-token" };
    const durable: ContentAccessPendingOperationsPort = {
      restore: () => [exact],
      execute: async (_operation, dispatch) => dispatch(),
    };
    const api = port();
    const controller = new ContentAccessController(api, roomId, () => 9_000, undefined, durable);
    const restored = controller.restore([{ ...subject, label: "Current label.md" }]);
    expect(restored).toEqual([{
      subject: { ...subject, label: "Current label.md" },
      phase: "retryable",
      pendingOperation: exact,
      error: expect.stringContaining("already submitted"),
    }]);
    expect(restored[0]?.preparation).toBeUndefined();
    expect(api.prepareContentAccess).not.toHaveBeenCalled();
  });
});
