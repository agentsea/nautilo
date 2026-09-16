import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AuthorizedHumanMemoryClient } from
  "@nautilo/lattice-bridge/client/browser";

import { createWorkbenchProtectedHumanMemoryController } from
  "../../src/lib/protected-human-memory-controller";
import {
  requestCryptoAdmissionRefresh,
  resetCryptoAdmissionAccess,
  setCryptoAdmissionAccessState,
} from "../../src/lib/crypto-admission-access";

const openedProjection = {
  memoryId: "11111111-1111-4111-8111-111111111111",
  contentRevision: 2,
  cryptoAccessRevision: 0,
  importance: 0.8,
  tier: 1 as const,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-02T00:00:00.000Z",
  namespaceIds: ["22222222-2222-4222-8222-222222222222"],
  requiredNamespaceIds: ["22222222-2222-4222-8222-222222222222"],
  readAuthorities: [],
};
const pendingProjection = {
  ...openedProjection,
  memoryId: "33333333-3333-4333-8333-333333333333",
};

beforeEach(() => {
  resetCryptoAdmissionAccess();
  setCryptoAdmissionAccessState({
    status: "open",
    identity: "account:device:a",
    policy: { mode: "shadow_encryption", shadowBehavior: "fallback" },
  });
});

afterEach(() => resetCryptoAdmissionAccess());

describe("Workbench protected Human Memory controller", () => {
  test("rejects a Memory page result that spans an admission pause", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const client = {
      async withList(_options: unknown, use: (value: unknown) => void) {
        await pending;
        use({ representation: "protected", projection: openedProjection, payload: {
          formatVersion: 1, type: "preference", content: "late private value",
        } });
        return { nextCursor: null, memoryMode: "namespace" as const };
      },
    } as Pick<AuthorizedHumanMemoryClient, "withList">;
    const controller = createWorkbenchProtectedHumanMemoryController(
      client as Parameters<typeof createWorkbenchProtectedHumanMemoryController>[0],
    );
    const read = controller.list({});
    await Promise.resolve();
    requestCryptoAdmissionRefresh("device_admission_expired");
    release();
    const failure = await read.catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "crypto_admission_paused" });
  });

  test("returns a page before observations settle and drains them on disposal", async () => {
    let release!: () => void;
    const delivery = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const client = {
      async withList() {
        calls += 1;
        const page = { nextCursor: null, memoryMode: "namespace" as const };
        Object.defineProperty(page, "observationDelivery", { value: delivery });
        return page;
      },
    } as Pick<AuthorizedHumanMemoryClient, "withList">;
    const controller = createWorkbenchProtectedHumanMemoryController(
      client as Parameters<typeof createWorkbenchProtectedHumanMemoryController>[0],
    );
    const page = await controller.list({});
    expect(page).toMatchObject({ items: [] });
    expect(page).not.toHaveProperty("observationDelivery");
    const disposal = controller.dispose();
    let disposed = false;
    void disposal.then(() => { disposed = true; });
    await Promise.resolve();
    expect(disposed).toBe(false);
    release();
    await disposal;
    expect(calls).toBe(1);
    expect(controller.list({})).rejects.toThrow("disposed");
  });

  test("returns opened and truthful unavailable rows without exposing wire DTOs", async () => {
    const client: Pick<AuthorizedHumanMemoryClient,
      "withList" | "withSearch" | "withDetail" | "update" | "archive" |
      "restore" | "transitionTier" | "deleteAuthorizedView" | "grantUser" |
      "revokeUser" | "makePrivate" |
      "retryPendingMutations"> = {
      async withList(_options, use, unavailable) {
        await use({ representation: "ordinary_fallback", policyRevision: 9,
          projection: openedProjection, payload: {
          formatVersion: 1, type: "preference", content: "Private value",
        } });
        await unavailable?.({
          projection: pendingProjection,
          reason: "shadow_pending",
        });
        return { nextCursor: null, memoryMode: "namespace", total: 2 };
      },
      async withSearch(_options, _use, unavailable) {
        await unavailable?.({
          projection: pendingProjection,
          reason: "lost_key_material",
          score: 0.4,
        });
        return { memoryMode: "namespace", queryDisclosure: "embedding_provider" };
      },
      async withDetail(_memoryId, use) {
        await use({ representation: "ordinary_fallback", policyRevision: 9,
          projection: openedProjection, payload: {
          formatVersion: 1, type: "preference", content: "Private value",
        } });
        return {
          memoryMode: "namespace",
          actionAuthority: {
            canEdit: true, canArchive: true, canManageAccess: false,
          },
        };
      },
      async update(memoryId, intent, use) {
        expect(memoryId).toBe(openedProjection.memoryId);
        expect(intent).toEqual({
          payload: {
            formatVersion: 1,
            type: "preference",
            content: "Changed privately",
          },
          importance: 0.9,
          requestedProvider: "openrouter",
          requestedModel: "text-embedding-3-small",
        });
        await use({ projection: { ...openedProjection, contentRevision: 3 },
          payload: intent.payload });
        return { status: "published", memoryId, followUpPending: true } as never;
      },
      archive: async (memoryId) => ({
        status: "archived", memoryId, tier: 3,
      }),
      restore: async (memoryId) => ({
        status: "restored", memoryId, previousTier: 3, nextTier: 2,
      }),
      transitionTier: async (memoryId, action) => ({
        status: action === "promote" ? "promoted" : "demoted",
        memoryId,
        previousTier: action === "promote" ? 2 : 1,
        nextTier: action === "promote" ? 1 : 2,
      }),
      deleteAuthorizedView: async (memoryId) => ({ status: "updated", memoryId }),
      grantUser: async (memoryId, userHandle) => {
        expect(userHandle).toBe("alice");
        return { status: "updated", memoryId };
      },
      revokeUser: async (memoryId, userHandle) => {
        expect(userHandle).toBe("alice");
        return { status: "updated", memoryId };
      },
      makePrivate: async (memoryId) => ({ status: "updated", memoryId }),
      retryPendingMutations: async () => 1,
    };
    const controller = createWorkbenchProtectedHumanMemoryController(client);

    expect(await controller.list({})).toMatchObject({
      total: 2,
      items: [
        { id: openedProjection.memoryId, content: {
          status: "opened", representation: "ordinary_fallback",
          type: "preference", content: "Private value",
        } },
        { id: pendingProjection.memoryId, content: {
          status: "unavailable", reason: "shadow_pending",
        } },
      ],
    });
    expect(await controller.search({ q: "value", mode: "semantic" }))
      .toMatchObject({ items: [{ score: 0.4, content: {
        status: "unavailable", reason: "lost_key_material",
      } }] });
    expect(await controller.detail(openedProjection.memoryId)).toMatchObject({
      memory: { content: { representation: "ordinary_fallback",
        type: "preference", content: "Private value" } },
      actionAuthority: { canEdit: true },
    });
    expect(await controller.update({
      memoryId: openedProjection.memoryId,
      type: "preference",
      content: "Changed privately",
      importance: 0.9,
      requestedProvider: "openrouter",
      requestedModel: "text-embedding-3-small",
    })).toMatchObject({
      status: "published",
      followUpPending: true,
      memory: { contentRevision: 3, content: {
        status: "opened", representation: "protected",
        type: "preference", content: "Changed privately",
      } },
    });
    expect(await controller.retryPendingMutations()).toBe(1);
    expect(await controller.archive(openedProjection.memoryId)).toMatchObject({
      status: "archived", tier: 3,
    });
    expect(await controller.restore(openedProjection.memoryId)).toMatchObject({
      status: "restored", nextTier: 2,
    });
    expect(await controller.transitionTier(openedProjection.memoryId, "promote"))
      .toMatchObject({ status: "promoted", previousTier: 2, nextTier: 1 });
    expect(await controller.grantUser(openedProjection.memoryId, "alice"))
      .toEqual({ status: "updated", memoryId: openedProjection.memoryId });
    expect(await controller.revokeUser(openedProjection.memoryId, "alice"))
      .toEqual({ status: "updated", memoryId: openedProjection.memoryId });
    expect(await controller.makePrivate(openedProjection.memoryId))
      .toEqual({ status: "updated", memoryId: openedProjection.memoryId });
    expect(await controller.deleteAuthorizedView(openedProjection.memoryId))
      .toEqual({ status: "updated", memoryId: openedProjection.memoryId });
    client.update = async (memoryId) => ({ status: "ordinary_fallback", memoryId,
      reason: "encryption_pending", followUpPending: true });
    const fallback = await controller.update({ memoryId: openedProjection.memoryId,
      type: "preference", content: "Saved without crypto", importance: 0.9,
      requestedProvider: "openrouter", requestedModel: "text-embedding-3-small" });
    expect(fallback).toEqual({ status: "ordinary_fallback", memoryId: openedProjection.memoryId,
      reason: "encryption_pending", followUpPending: true });
    expect(fallback).not.toHaveProperty("memory");
  });
});
