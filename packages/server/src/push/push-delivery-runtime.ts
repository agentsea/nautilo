/** Process lifecycle for D468's durable push delivery worker. */
import { randomUUID } from "node:crypto";

import { warn } from "@nautilo/logger";

import {
  createPushDeliveryWorker,
  type PushDeliveryWorker,
} from "./push-delivery-worker";

const PUSH_DELIVERY_TICK_MS = 5_000;
const PUSH_DELIVERY_MAX_TURNS_PER_PUMP = 32;

type PushDeliveryPump = Pick<PushDeliveryWorker, "runOnce">;

let worker: PushDeliveryPump | undefined;
let tickTimer: ReturnType<typeof setInterval> | undefined;
let pumpQueued = false;
let activeAbort: AbortController | undefined;
let running = false;

function getWorker(): PushDeliveryPump {
  worker ??= createPushDeliveryWorker({
    workerId: `push-delivery:${randomUUID()}`,
  });
  return worker;
}

async function pump(): Promise<void> {
  const controller = new AbortController();
  activeAbort = controller;
  try {
    // Both each turn and each provider call are bounded. If work remains the
    // timer queues the next turn; no startup request can monopolize server IO.
    for (let turn = 0; turn < PUSH_DELIVERY_MAX_TURNS_PER_PUMP; turn += 1) {
      if (!running || controller.signal.aborted) return;
      const result = await getWorker().runOnce({ signal: controller.signal });
      if (!result.didWork) return;
    }
  } finally {
    if (activeAbort === controller) activeAbort = undefined;
  }
}

/** Queue an eventual bounded pump after a durable notification change. */
export function requestPushDeliveryPump(): void {
  if (!running || pumpQueued) return;
  pumpQueued = true;
  queueMicrotask(() => {
    void pump()
      .catch((error: unknown) => {
        // Keep failure reporting operational and content-free. Claims expire
        // durably, so the next tick/restart can reclaim interrupted work.
        warn(`[push-delivery] pump deferred: ${error instanceof Error ? error.name : "unknown"}`);
      })
      .finally(() => {
        pumpQueued = false;
      });
  });
}

/** Server-start lifecycle. Missing setup must not prevent the API from booting. */
export function startPushDeliveryRuntime(): void {
  if (tickTimer !== undefined) return;
  running = true;
  tickTimer = setInterval(requestPushDeliveryPump, PUSH_DELIVERY_TICK_MS);
  tickTimer.unref?.();
  requestPushDeliveryPump();
}

/** Server shutdown/test seam. Claimed rows are intentionally left to expire. */
export function stopPushDeliveryRuntime(): void {
  running = false;
  if (tickTimer !== undefined) clearInterval(tickTimer);
  tickTimer = undefined;
  activeAbort?.abort();
  activeAbort = undefined;
  pumpQueued = false;
}

/** Narrow injection seam for deterministic runtime tests. */
export function __setPushDeliveryWorkerForTests(value: PushDeliveryPump | undefined): void {
  stopPushDeliveryRuntime();
  worker = value;
}
