/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import type {
  MobilePushInstallationStatus,
  NotificationLevel,
  NotificationPreferencesDto,
} from "@nautilo/types";

import {
  createNotificationSettingsController,
  type NotificationSettingsApi,
} from "./notification-settings-controller";

const scope = { serverId: "server-a", userId: "user-a", actorId: "actor-a" };
const otherScope = { serverId: "server-b", userId: "user-b", actorId: "actor-b" };

function preferences(defaultLevel: NotificationLevel = "direct"): NotificationPreferencesDto {
  return { defaultLevel, roomOverrides: [] };
}

function binding(overrides: Partial<MobilePushInstallationStatus> = {}): MobilePushInstallationStatus {
  return {
    version: 1,
    installationId: "11111111-1111-4111-8111-111111111111",
    bindingId: "22222222-2222-4222-8222-222222222222",
    platform: "ios",
    enabled: true,
    tokenGeneration: 1,
    permission: "granted",
    state: "active",
    updatedAt: "2026-08-05T12:00:00.000Z",
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function fakeApi() {
  let current = preferences();
  const calls: string[] = [];
  const api: NotificationSettingsApi = {
    getNotificationPreferences: async () => { calls.push("preferences:get"); return current; },
    getPushInstallationStatus: async (bindingId) => { calls.push(`binding:get:${bindingId}`); return binding(); },
    setDefaultNotificationLevel: async (level) => {
      calls.push(`preferences:put:${level}`);
      current = preferences(level);
      return current;
    },
    sendPushInstallationTest: async (bindingId) => {
      calls.push(`test:${bindingId}`);
      return { accepted: true, notificationId: "33333333-3333-4333-8333-333333333333" };
    },
  };
  return { api, calls };
}

describe("D468 notification settings controller", () => {
  test("loads M233 default policy and only the current device's bound server status", async () => {
    const source = fakeApi();
    const controller = createNotificationSettingsController(
      () => source.api,
      async () => binding().bindingId,
    );
    controller.setScope(scope);

    expect(await controller.load()).toMatchObject({ status: "applied" });
    expect(controller.data.getState().data).toMatchObject({
      preferences: { defaultLevel: "direct" },
      binding: { kind: "registered", status: { state: "active" } },
    });
    expect(source.calls).toEqual([
      "preferences:get",
      `binding:get:${binding().bindingId}`,
    ]);
  });

  test("does not invent a server binding or permit a test when this phone is not registered", async () => {
    const source = fakeApi();
    const controller = createNotificationSettingsController(() => source.api, async () => null);
    controller.setScope(scope);
    await controller.load();

    expect(controller.data.getState().data?.binding).toEqual({ kind: "not_registered" });
    expect(await controller.sendTest()).toEqual({
      status: "failed",
      message: "This phone is not registered for notifications on this server yet.",
    });
    expect(source.calls).toEqual(["preferences:get"]);
  });

  test("makes one optimistic default-level selection, then restores canonical server state", async () => {
    const source = fakeApi();
    const controller = createNotificationSettingsController(() => source.api, async () => binding().bindingId);
    controller.setScope(scope);
    await controller.load();

    const update = controller.setDefaultLevel("all");
    expect(controller.data.getState().draft).toEqual({ defaultLevel: "all" });
    expect(await update).toMatchObject({ status: "applied" });
    expect(controller.data.getState().data?.preferences.defaultLevel).toBe("all");
    expect(controller.data.getState().draft).toBeNull();
    expect(source.calls).toEqual([
      "preferences:get", `binding:get:${binding().bindingId}`,
      "preferences:put:all",
      "preferences:get", `binding:get:${binding().bindingId}`,
    ]);
  });

  test("bounds the generic test action to an active binding and turns a rate limit into useful recovery copy", async () => {
    const source = fakeApi();
    source.api.sendPushInstallationTest = async () => {
      throw Object.assign(new Error("too many tests"), { status: 429, code: "push_test_rate_limited" });
    };
    const controller = createNotificationSettingsController(() => source.api, async () => binding().bindingId);
    controller.setScope(scope);
    await controller.load();

    expect(await controller.sendTest()).toEqual({
      status: "failed",
      message: "A test was sent recently. Wait a moment before trying again.",
    });
  });

  test("late server-A reads cannot populate server-B settings after a switch", async () => {
    const slow = deferred<NotificationPreferencesDto>();
    const source = fakeApi();
    source.api.getNotificationPreferences = async () => slow.promise;
    const controller = createNotificationSettingsController(() => source.api, async () => null);
    controller.setScope(scope);
    const first = controller.load();

    controller.setScope(otherScope);
    slow.resolve(preferences("all"));

    expect(await first).toEqual({ status: "ignored" });
    expect(controller.data.getState()).toMatchObject({ scope: otherScope, data: null });
  });
});
