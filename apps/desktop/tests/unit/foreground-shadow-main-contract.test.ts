import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const main = readFileSync(join(import.meta.dir, "../../electron/main.ts"), "utf8");

function handler(channel: string, nextChannel: string): string {
  const start = main.indexOf(`"${channel}"`);
  const end = main.indexOf(`"${nextChannel}"`, start + 1);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return main.slice(start, end);
}

describe("foreground Shadow main-process contract", () => {
  test("validates every renderer payload before resolving or touching custody", () => {
    const send = handler("foregroundShadow:send", "foregroundShadow:recoverPending");
    expect(send.indexOf("boundedForegroundShadowValue(")).toBeLessThan(
      send.indexOf("foregroundShadowControllerForSender(e)"),
    );
    expect(send.indexOf("normalizeRemoteOrdinaryRequestBody(value.body)")).toBeLessThan(
      send.indexOf("foregroundShadowControllerForSender(e)"),
    );
    const authorize = handler("foregroundShadow:authorize", "foregroundShadow:receive");
    const edit = handler("foregroundShadow:edit", "foregroundShadow:authorize");
    expect(edit.indexOf("parseForegroundShadowEdit(raw)")).toBeGreaterThan(-1);
    expect(edit.indexOf("parseForegroundShadowEdit(raw)")).toBeLessThan(
      edit.indexOf("foregroundShadowControllerForSender(e)"),
    );
    expect(authorize.indexOf("parseLiveShadowMessageRealtimeEventV1(")).toBeLessThan(
      authorize.indexOf("foregroundShadowControllerForSender(e)"),
    );
    const pendingAttention = handler(
      "foregroundShadow:recoverRoomPendingAttention",
      "foregroundShadow:edit",
    );
    expect(pendingAttention.indexOf("parseForegroundShadowPendingAttention(raw)"))
      .toBeLessThan(pendingAttention.indexOf("foregroundShadowControllerForSender(e)"));
    const taskPendingAttention = handler(
      "foregroundShadow:recoverTaskPendingAttention",
      "foregroundShadow:recoverProtectedTaskExternalRequests",
    );
    expect(taskPendingAttention.indexOf("parseForegroundShadowTaskPendingAttention(raw)"))
      .toBeLessThan(taskPendingAttention.indexOf("foregroundShadowControllerForSender(e)"));
    const externalRecovery = handler(
      "foregroundShadow:recoverProtectedTaskExternalRequests",
      "foregroundShadow:respondProtectedTaskExternalRequest",
    );
    expect(externalRecovery.indexOf("boundedForegroundShadowValue("))
      .toBeLessThan(externalRecovery.indexOf("foregroundShadowControllerForSender(e)"));
    expect(externalRecovery).toContain('foregroundShadowString(value.requestId, "Request id", 512)');
    const externalResponse = handler(
      "foregroundShadow:respondProtectedTaskExternalRequest",
      "foregroundShadow:edit",
    );
    expect(externalResponse.indexOf("codexRequestResponseSchema.safeParse("))
      .toBeLessThan(externalResponse.indexOf("foregroundShadowControllerForSender(e)"));
    expect(externalResponse.indexOf("codexPermissionSelectionResponseSchema.safeParse("))
      .toBeLessThan(externalResponse.indexOf("foregroundShadowControllerForSender(e)"));
    const receive = handler("foregroundShadow:receive", "foregroundShadow:synchronizeRecipients");
    expect(receive.indexOf("parseLiveShadowMessageRealtimeEventV1(")).toBeLessThan(
      receive.indexOf("foregroundShadowControllerForSender(e)"),
    );
    expect(main).toContain(
      'ipcMain.handle("foregroundShadow:serviceDomainKeyBacklog"',
    );
    const background = handler(
      "foregroundShadow:backgroundAuthorization:service",
      "foregroundShadow:messageBackfill:service",
    );
    expect(background).toContain("foregroundShadowControllerForSender(e)");
    expect(background).toContain("controller.serviceBackgroundAuthorization()");
    const historyStart = main.indexOf('ipcMain.handle("foregroundShadow:history:reconcile"');
    const historyEnd = main.indexOf("async function remoteControlClientForSender", historyStart);
    expect(historyStart).toBeGreaterThan(-1);
    expect(historyEnd).toBeGreaterThan(historyStart);
    const history = main.slice(historyStart, historyEnd);
    expect(history.indexOf("assertForegroundShadowHistoryShape(value)")).toBeLessThan(
      history.indexOf("foregroundShadowControllerForSender(e)"),
    );
    for (const [channel, next] of [
      ["foregroundShadow:memory:deleteAuthorizedView", "foregroundShadow:memory:grantUser"],
      ["foregroundShadow:memory:grantUser", "foregroundShadow:memory:revokeUser"],
      ["foregroundShadow:memory:revokeUser", "foregroundShadow:memory:makePrivate"],
      ["foregroundShadow:memory:makePrivate", "foregroundShadow:send"],
    ] as const) {
      const access = handler(channel, next);
      expect(access.indexOf("boundedForegroundShadowValue(")).toBeLessThan(
        access.indexOf("foregroundShadowControllerForSender(e)"),
      );
    }
  });

  test("strictly decodes the renderer-approved Memory disclosure before custody", () => {
    const search = handler("foregroundShadow:memory:search", "foregroundShadow:memory:detail");
    const update = handler("foregroundShadow:memory:update", "foregroundShadow:memory:retryPending");
    for (const operation of [search, update]) {
      expect(operation).toContain("assertMemoryEmbeddingDisclosureV2(");
      expect(operation).toContain("decodeMemoryEmbeddingDisclosureV2(");
      expect(operation).toContain("encodeMemoryEmbeddingDisclosureV2(");
      expect(operation.indexOf("assertMemoryEmbeddingDisclosureV2(")).toBeLessThan(
        operation.indexOf("foregroundShadowControllerForSender(e)"),
      );
    }
    expect(search).toContain("embeddingDisclosure");
    expect(update).toContain("requestedEmbedding");
  });

  test("binds one controller to the active sender/session and disposes on lifecycle exits", () => {
    const factory = main.slice(
      main.indexOf("async function foregroundShadowControllerForSender("),
      main.indexOf('ipcMain.handle("foregroundShadow:inspect"'),
    );
    expect(factory).toContain("resolveSessionFromSender(e)");
    expect(factory).toContain("serverSessions.getBySender(senderId)");
    expect(factory).toContain("active.view?.webContents.id === senderId");
    expect(factory).toContain('e.sender.once("destroyed"');
    expect(factory).toContain("api.setDeviceAdmissionRequiredHandler(");
    expect(factory).toContain(
      'e.sender.send("foregroundShadow:protectedRoomAccess", state)',
    );
    const dispose = main.slice(
      main.indexOf("async function disposeForegroundShadowController("),
      main.indexOf("async function disposeAllForegroundShadowControllers("),
    );
    expect(dispose).toContain(
      'bound.sender.removeListener("destroyed", bound.onSenderDestroyed)',
    );
    expect(main).toContain("await disposeAllForegroundShadowControllers();");
    expect(main).toContain("void disposeForegroundShadowController(senderId);");
    expect(main).toContain("currentSession?.signedIn !== true");
  });

  test("keeps protected sends on the one main-owned origin sender", () => {
    const factory = main.slice(
      main.indexOf("async function foregroundShadowControllerForSender("),
      main.indexOf('ipcMain.handle("foregroundShadow:inspect"'),
    );
    expect(factory).toContain("createDesktopForegroundShadowOriginSender({");
    expect(factory).toContain("getPersistedDesktopRelayId()");
    expect(factory).toContain("getDesktopSessionId()");
    expect(factory).toContain("loadRelayToken(session.serverUrl)");
    expect(factory).not.toContain("console.");
  });

  test("validates, sender-binds, coalesces, and cancels Message backfill in main custody", () => {
    const service = handler(
      "foregroundShadow:messageBackfill:service",
      "foregroundShadow:messageBackfill:cancel",
    );
    expect(service.indexOf("messageBackfillNextRequestSchema.parse(raw ?? {})"))
      .toBeLessThan(service.indexOf("foregroundShadowControllerForSender(e)"));
    expect(service).toContain("controller.serviceMessageBackfill(request.urgent)");
    const cancel = handler(
      "foregroundShadow:messageBackfill:cancel",
      "foregroundShadow:history:reconcile",
    );
    expect(cancel).toContain("resolveSessionFromSender(e)");
    expect(cancel).toContain("foregroundShadowControllers.get(e.sender.id)");
    expect(cancel).toContain("bound.sender !== e.sender");
    expect(cancel).toContain("bound.serverScope !== session.scope");
    expect(cancel).toContain("bound.controller.cancelMessageBackfill()");
  });
});


test("Task repair IPC is sender-bound and cancellation never creates profile custody", () => {
  const service = handler("foregroundShadow:taskContentBackfill:service", "foregroundShadow:taskContentBackfill:cancel");
  expect(service).toContain("foregroundShadowControllerForSender(e)");
  expect(service).toContain("controller.serviceTaskContentBackfill()");
  const cancel = handler("foregroundShadow:taskContentBackfill:cancel", "foregroundShadow:history:reconcile");
  expect(cancel).toContain("resolveSessionFromSender(e)");
  expect(cancel).toContain("bound.sender !== e.sender");
  expect(cancel).toContain("bound.serverScope !== session.scope");
  expect(cancel).toContain("bound.controller.cancelTaskContentBackfill()");
  expect(cancel).not.toContain("foregroundShadowControllerForSender");
});
