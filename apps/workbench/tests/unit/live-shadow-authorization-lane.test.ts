import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const runtimeSource = readFileSync(
  resolve(import.meta.dir, "../../src/adapters/nautilo-runtime.tsx"),
  "utf8",
);

test("foreground crypto authorization is not queued behind receive work", () => {
  const authorizationStart = runtimeSource.indexOf(
    'event.type === "message.shared_agent_authorization_required"',
  );
  const authorizationEnd = runtimeSource.indexOf(
    'event.type === "crypto.domain_key_catch_up_requested"',
    authorizationStart,
  );
  expect(authorizationStart).toBeGreaterThan(-1);
  expect(authorizationEnd).toBeGreaterThan(authorizationStart);

  const authorizationBranch = runtimeSource.slice(
    authorizationStart,
    authorizationEnd,
  );
  expect(authorizationBranch).toContain(
    "liveShadowAuthorizationQueueRef.current",
  );
  expect(authorizationBranch).not.toContain("liveShadowReceiveQueueRef.current");
});

test("Domain catch-up services only the server-requested key class", () => {
  const catchUpStart = runtimeSource.indexOf(
    'event.type === "crypto.domain_key_catch_up_requested"',
  );
  const deliveryStart = runtimeSource.indexOf(
    'event.type === "crypto.domain_key_catch_up_delivered"',
    catchUpStart,
  );
  expect(catchUpStart).toBeGreaterThan(-1);
  expect(deliveryStart).toBeGreaterThan(catchUpStart);

  const catchUpBranch = runtimeSource.slice(catchUpStart, deliveryStart);
  expect(catchUpBranch).toContain("event.roomId");
  expect(catchUpBranch).toContain("event.namespaceId");
  expect(catchUpBranch).toContain("event.keyClass");
});

test("accepted Domain delivery wakes waiting history only after local receipt", () => {
  const deliveryStart = runtimeSource.indexOf(
    'event.type === "crypto.domain_key_catch_up_delivered"',
  );
  const deliveryEnd = runtimeSource.indexOf(
    'event.type === "message.shadow_stream_start"',
    deliveryStart,
  );
  const deliveryBranch = runtimeSource.slice(deliveryStart, deliveryEnd);
  const receive = deliveryBranch.indexOf("receiveDomainKeyDelivery(");
  const refresh = deliveryBranch.indexOf("refreshMountedKeyWaitingHistoryRef.current");

  expect(receive).toBeGreaterThan(-1);
  expect(refresh).toBeGreaterThan(receive);
  expect(deliveryBranch.slice(receive, refresh)).toContain("sameReceivingViewer()");
  expect(deliveryBranch).toContain("refreshMountedKeyWaitingHistoryRef.current");
});

test("cold Room authority demand uses member detail and the recipient-sync scheduler", () => {
  expect(runtimeSource).toContain("onAuthorityWaiting: (roomId)");
  expect(runtimeSource).toContain("authorityWaitingRoomRef.current = roomId");
  expect(runtimeSource).toContain("apiClient.getRoom(displayRoomId)");
  expect(runtimeSource).toContain("protectedHistoryRecipientSyncCoordinate(");
  expect(runtimeSource).toContain("recipientSyncSchedulerRef.current?.enqueue(");
  expect(runtimeSource).toContain("onReady: (displayRoomId)");
  expect(runtimeSource).toContain("refreshMountedKeyWaitingHistoryRef.current(displayRoomId)");
  expect(runtimeSource).toContain("replayableProtectedHistoryAuthorityDemand({");
  expect(runtimeSource).toContain("recipientSyncReady: liveShadowMessageClient !== undefined");
});

test("waiting history re-demands authority after the active stream reaches terminal state", () => {
  const demandEffectStart = runtimeSource.indexOf(
    "if (!shouldDemandProtectedHistoryAuthority({",
  );
  const demandEffectEnd = runtimeSource.indexOf(
    "// Durable Domain delivery is server-backed queue work.",
    demandEffectStart,
  );
  expect(demandEffectStart).toBeGreaterThan(-1);
  expect(demandEffectEnd).toBeGreaterThan(demandEffectStart);

  const demandEffect = runtimeSource.slice(demandEffectStart, demandEffectEnd);
  expect(demandEffect).toContain("isRunning,");
  expect(demandEffect).toContain("activeStreamCount: streamsRef.current.size");
  expect(demandEffect).toContain("requestProtectedRoomAuthorityRef.current(activeRoomId)");
});
