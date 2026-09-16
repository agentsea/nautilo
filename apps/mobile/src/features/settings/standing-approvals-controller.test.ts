/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";

import type { SettingsDataScope } from "@/features/settings/settings-data-state";

import {
  createStandingApprovalsController,
  standingApprovalPresentation,
  standingApprovalsFailure,
  type StandingApproval,
  type StandingApprovalsApi,
} from "./standing-approvals-state";

const scopeA: SettingsDataScope = { serverId: "server-a", userId: "user-a", actorId: "actor-a" };
const scopeB: SettingsDataScope = { serverId: "server-b", userId: "user-b", actorId: "actor-b" };

function approval(overrides: Partial<StandingApproval> = {}): StandingApproval {
  return {
    id: "approval-1",
    scope: "room",
    roomId: "room-1",
    roomLabel: "Incident room",
    toolPattern: "filesystem.write",
    label: "Write files",
    approvalKind: "tool",
    capabilitySlug: null,
    active: true,
    createdAt: "2026-07-31T12:00:00.000Z",
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("standing approval presentation", () => {
  test("keeps scope, tool/capability, and room detail focused", () => {
    expect(standingApprovalPresentation(approval())).toEqual({
      title: "Write files",
      scope: "This room",
      tool: "Tool: filesystem.write",
      room: "Incident room",
    });
    expect(standingApprovalPresentation(approval({
      scope: "server",
      roomId: null,
      roomLabel: null,
      approvalKind: "capability",
      capabilitySlug: "control_desktop",
    }))).toEqual({
      title: "Write files",
      scope: "This server",
      tool: "Capability: control_desktop",
      room: null,
    });
  });

  test("classifies auth failures without treating a denial as success", () => {
    expect(standingApprovalsFailure(Object.assign(new Error("Authentication required"), { status: 401 })))
      .toEqual({ kind: "signed-out" });
    expect(standingApprovalsFailure(Object.assign(new Error("Forbidden"), { status: 403 })))
      .toEqual({ kind: "forbidden" });
  });
});

describe("standing approvals controller", () => {
  test("re-fetches the canonical list only after one confirmed active row revokes", async () => {
    const controller = createStandingApprovalsController();
    const calls: string[] = [];
    let listCount = 0;
    const api: StandingApprovalsApi = {
      async list(scope) {
        calls.push(`list:${scope.serverId}`);
        listCount += 1;
        return listCount === 1 ? [approval()] : [];
      },
      async revoke(scope, id) {
        calls.push(`revoke:${scope.serverId}:${id}`);
      },
    };
    controller.setScope(scopeA);

    expect(await controller.load(api)).toEqual({ status: "applied", data: [approval()] });
    expect(await controller.revoke("approval-1", api)).toEqual({ status: "applied", data: [] });
    expect(calls).toEqual(["list:server-a", "revoke:server-a:approval-1", "list:server-a"]);
    expect(controller.getState().data).toEqual([]);
  });

  test("makes foreign and already-revoked ids inert without a DELETE", async () => {
    const controller = createStandingApprovalsController();
    let revokes = 0;
    const api: StandingApprovalsApi = {
      async list() {
        return [approval({ id: "active" }), approval({ id: "revoked", active: false })];
      },
      async revoke() {
        revokes += 1;
      },
    };
    controller.setScope(scopeA);
    await controller.load(api);

    expect(await controller.revoke("foreign", api)).toEqual({ status: "ignored" });
    expect(await controller.revoke("revoked", api)).toEqual({ status: "ignored" });
    expect(revokes).toBe(0);
  });

  test("preserves the canonical row and supports recovery when revocation fails", async () => {
    const controller = createStandingApprovalsController();
    let fail = true;
    const api: StandingApprovalsApi = {
      async list() {
        return [approval()];
      },
      async revoke() {
        if (fail) throw new Error("Network unavailable");
      },
    };
    controller.setScope(scopeA);
    await controller.load(api);

    const first = await controller.revoke("approval-1", api);
    expect(first.status).toBe("failed");
    expect(controller.getState()).toMatchObject({ data: [approval()], mutating: false });
    expect(controller.getState().mutationError?.message).toBe("Network unavailable");

    fail = false;
    expect((await controller.revoke("approval-1", api)).status).toBe("applied");
  });

  test("refreshes without a second DELETE when revoke succeeded but canonical reload failed", async () => {
    const controller = createStandingApprovalsController();
    const calls: string[] = [];
    let listCount = 0;
    const api: StandingApprovalsApi = {
      async list() {
        listCount += 1;
        calls.push("list");
        if (listCount === 1) return [approval()];
        if (listCount === 2) throw new Error("Refresh unavailable");
        return [];
      },
      async revoke(_scope, id) {
        calls.push(`revoke:${id}`);
      },
    };
    controller.setScope(scopeA);
    await controller.load(api);

    expect((await controller.revoke("approval-1", api)).status).toBe("failed");
    expect(controller.hasPendingCanonicalRefresh()).toBe(true);
    expect((await controller.revoke("approval-1", api)).status).toBe("applied");
    expect(controller.getState().data).toEqual([]);
    expect(calls).toEqual(["list", "revoke:approval-1", "list", "list"]);
    expect(controller.hasPendingCanonicalRefresh()).toBe(false);
  });

  test("drops slow list and revocation completions after the server or viewer scope changes", async () => {
    const controller = createStandingApprovalsController();
    const oldList = deferred<StandingApproval[]>();
    const oldRevoke = deferred<void>();
    let reloads = 0;
    const api: StandingApprovalsApi = {
      list(scope) {
        if (scope.serverId === scopeA.serverId && reloads === 0) return oldList.promise;
        reloads += 1;
        return Promise.resolve([approval({ id: `canonical-${scope.userId}` })]);
      },
      revoke() {
        return oldRevoke.promise;
      },
    };
    controller.setScope(scopeA);
    const slowList = controller.load(api);

    controller.setScope(scopeB);
    const currentList = controller.load(api);
    oldList.resolve([approval({ id: "stale-server-a" })]);
    expect(await slowList).toEqual({ status: "ignored" });
    expect(await currentList).toEqual({ status: "applied", data: [approval({ id: "canonical-user-b" })] });

    const slowRevoke = controller.revoke("canonical-user-b", api);
    expect(await controller.revoke("canonical-user-b", api)).toEqual({ status: "ignored" });
    controller.setScope({ ...scopeB, userId: "user-c", actorId: "actor-c" });
    oldRevoke.resolve();
    expect(await slowRevoke).toEqual({ status: "ignored" });
    expect(controller.getState().data).toBeNull();
  });
});
