import type { SourceAlarmReview } from "../src/node/source-alarm-review";

/** Exact reviewed source calls from the current main messageBackfill provenance. */
export const REVIEWED_MAIN_2026_09_09_MESSAGEBACKFILL_SOURCE_ALARMS: readonly SourceAlarmReview[] = [
  {
    "locator": "packages/agent/src/store/memory-store.ts#log_emitter:0ae25e725db4e950:1",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.messageBackfill.1",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/store/memory-store.ts#log_emitter:7ef703451e44cded:1",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.messageBackfill.2",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/store/memory-store.ts#log_emitter:0ae25e725db4e950:2",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.messageBackfill.3",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/store/memory-store.ts#log_emitter:7ef703451e44cded:2",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.messageBackfill.4",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/store/memory-store.ts#log_emitter:0ae25e725db4e950:3",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.messageBackfill.5",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/store/memory-store.ts#log_emitter:7ef703451e44cded:3",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.messageBackfill.6",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/store/memory-store.ts#log_emitter:7ef703451e44cded:4",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.messageBackfill.7",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/store/scope-memory-store.ts#log_emitter:7ef703451e44cded:1",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.messageBackfill.8",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/store/scope-memory-store.ts#log_emitter:7ef703451e44cded:2",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.messageBackfill.9",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/db/scripts/finalize-m313-message-backfill.ts#filesystem_write:df680bf60066c513:1",
    "owner": "packages/db",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.messageBackfill.10",
    "reason": "This exact call is a reviewed filesystem-write boundary. Its bytes and retention remain governed by the owning feature's coverage declaration; recording the call site does not classify arbitrary file content as safe metadata."
  },
  {
    "locator": "packages/db/scripts/finalize-m313-message-reservation.ts#filesystem_write:df680bf60066c513:1",
    "owner": "packages/db",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.messageBackfill.11",
    "reason": "This exact call is a reviewed filesystem-write boundary. Its bytes and retention remain governed by the owning feature's coverage declaration; recording the call site does not classify arbitrary file content as safe metadata."
  },
  {
    "locator": "packages/lattice-bridge/src/server/message/postgres-live-shadow-turn-plan.ts#log_emitter:0ae25e725db4e950:1",
    "owner": "packages/lattice-bridge",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.messageBackfill.12",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/message-invariants/src/assert.ts#log_emitter:3ae319e668f852b3:1",
    "owner": "packages/message-invariants",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.messageBackfill.13",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/runtime/src/executors/persist-messages.ts#log_emitter:0ae25e725db4e950:1",
    "owner": "packages/runtime",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.messageBackfill.14",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/runtime/src/memory-review/admission.ts#log_emitter:89b81c36ea23316a:1",
    "owner": "packages/runtime",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.messageBackfill.15",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/lib/memory-review-runtime.ts#log_emitter:dbf9206821d43594:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.messageBackfill.16",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/admin-rooms.ts#log_emitter:89b81c36ea23316a:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.messageBackfill.17",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/encryption-transition.ts#log_emitter:a1436e7c26c240df:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.messageBackfill.18",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/encryption-transition.ts#log_emitter:89b81c36ea23316a:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.messageBackfill.19",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/human-memory-read-observations.ts#log_emitter:89b81c36ea23316a:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.messageBackfill.20",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/live-shadow-message-composition.ts#log_emitter:7ef703451e44cded:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.messageBackfill.21",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/live-shadow-message-composition.ts#log_emitter:0ae25e725db4e950:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.messageBackfill.22",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/live-shadow-message-composition.ts#log_emitter:b2c06e79d72efcb6:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.messageBackfill.23",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/live-shadow-message-composition.ts#log_emitter:0ae25e725db4e950:2",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.messageBackfill.24",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/live-shadow-message-composition.ts#log_emitter:0ae25e725db4e950:3",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.messageBackfill.25",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/live-shadow-message-composition.ts#log_emitter:0ae25e725db4e950:4",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.messageBackfill.26",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/live-shadow-message-composition.ts#log_emitter:3110ddd230b78606:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.messageBackfill.27",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/live-shadow-message-composition.ts#log_emitter:0ae25e725db4e950:5",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.messageBackfill.28",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/live-shadow-message-composition.ts#log_emitter:0ae25e725db4e950:6",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.messageBackfill.29",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/live-shadow-message-composition.ts#log_emitter:0ae25e725db4e950:7",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.messageBackfill.30",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/live-shadow-message-composition.ts#log_emitter:0ae25e725db4e950:8",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.messageBackfill.31",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/memory.ts#log_emitter:a1436e7c26c240df:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.messageBackfill.32",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/memory.ts#log_emitter:a1436e7c26c240df:2",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.messageBackfill.33",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/message-attachments.ts#log_emitter:89b81c36ea23316a:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.messageBackfill.34",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/message-attachments.ts#log_emitter:89b81c36ea23316a:2",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.messageBackfill.35",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/message-attachments.ts#log_emitter:89b81c36ea23316a:3",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.messageBackfill.36",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/message-attachments.ts#log_emitter:89b81c36ea23316a:4",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.messageBackfill.37",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/room-history-shadow-read-composition.ts#log_emitter:a1436e7c26c240df:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.messageBackfill.38",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/rooms.ts#log_emitter:a1436e7c26c240df:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.messageBackfill.39",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/rooms.ts#log_emitter:89b81c36ea23316a:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.messageBackfill.40",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/rooms.ts#log_emitter:a1436e7c26c240df:2",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.messageBackfill.41",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/rooms.ts#log_emitter:a1436e7c26c240df:3",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.messageBackfill.42",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/rooms.ts#log_emitter:a1436e7c26c240df:4",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.messageBackfill.43",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/rooms.ts#log_emitter:a1436e7c26c240df:5",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.messageBackfill.44",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/rooms.ts#log_emitter:a1436e7c26c240df:6",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.messageBackfill.45",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/rooms.ts#log_emitter:a1436e7c26c240df:7",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.messageBackfill.46",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/rooms.ts#log_emitter:a1436e7c26c240df:8",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.messageBackfill.47",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/rooms.ts#log_emitter:a1436e7c26c240df:9",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.messageBackfill.48",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/sessions.ts#log_emitter:a1436e7c26c240df:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.messageBackfill.49",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  }
];

export const SUPERSEDED_MAIN_2026_09_09_MESSAGEBACKFILL_SOURCE_LOCATORS = new Set<string>([
  "apps/workbench/src/lib/memory-api.ts#network_processor:c33fe4206518f5d8:1",
  "apps/workbench/src/lib/memory-api.ts#network_processor:0fe8627ecc022149:1",
  "apps/workbench/src/lib/memory-api.ts#network_processor:0fe8627ecc022149:2",
  "apps/workbench/src/lib/memory-api.ts#network_processor:ef993855494c1601:1",
  "apps/workbench/src/lib/memory-api.ts#network_processor:ef993855494c1601:2",
  "apps/workbench/src/lib/memory-api.ts#network_processor:ef993855494c1601:3",
  "apps/workbench/src/lib/memory-api.ts#network_processor:0fe8627ecc022149:3",
  "apps/workbench/src/lib/memory-api.ts#network_processor:ef993855494c1601:4",
  "apps/workbench/src/lib/memory-api.ts#network_processor:ef993855494c1601:5",
  "apps/workbench/src/lib/memory-api.ts#network_processor:ef993855494c1601:6",
  "apps/workbench/src/modes/rooms/thread-drawer/api.ts#network_processor:08b7bd530e4769d5:1"
]);
