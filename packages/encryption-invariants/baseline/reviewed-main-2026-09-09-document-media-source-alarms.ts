import type { SourceAlarmReview } from "../src/node/source-alarm-review";

/** Exact reviewed source calls from the current main documentMedia provenance. */
export const REVIEWED_MAIN_2026_09_09_DOCUMENTMEDIA_SOURCE_ALARMS: readonly SourceAlarmReview[] = [
  {
    "locator": "apps/desktop/electron/media-process.ts#temporary_storage:245eb5ac1c6564b5:1",
    "owner": "apps/desktop",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.documentMedia.1",
    "reason": "This exact backup or export call is reviewed as a plaintext transfer boundary whose content and retention remain governed by the owning feature's coverage declaration."
  },
  {
    "locator": "apps/desktop/electron/media-waveform.ts#subprocess_processor:65a9cc052783ec8f:1",
    "owner": "apps/desktop",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.documentMedia.2",
    "reason": "This exact call is a reviewed plaintext subprocess boundary. Arguments, standard streams, and files remain governed by the owning feature's coverage declaration; this review makes no encrypted-processing claim."
  },
  {
    "locator": "apps/desktop/electron/video-project-promotion.ts#temporary_storage:b442a55169f24b15:1",
    "owner": "apps/desktop",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.documentMedia.3",
    "reason": "This exact backup or export call is reviewed as a plaintext transfer boundary whose content and retention remain governed by the owning feature's coverage declaration."
  },
  {
    "locator": "apps/desktop/electron/video-project-promotion.ts#filesystem_write:d0c4e119dbe93373:1",
    "owner": "apps/desktop",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.documentMedia.4",
    "reason": "This exact call is a reviewed filesystem-write boundary. Its bytes and retention remain governed by the owning feature's coverage declaration; recording the call site does not classify arbitrary file content as safe metadata."
  },
  {
    "locator": "apps/desktop/electron/workspace-media-streaming.ts#temporary_storage:51346b506958b8c7:1",
    "owner": "apps/desktop",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.documentMedia.5",
    "reason": "This exact backup or export call is reviewed as a plaintext transfer boundary whose content and retention remain governed by the owning feature's coverage declaration."
  },
  {
    "locator": "apps/desktop/electron/workspace-media-streaming.ts#temporary_storage:ff8765c8f7e677b1:1",
    "owner": "apps/desktop",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.documentMedia.6",
    "reason": "This exact backup or export call is reviewed as a plaintext transfer boundary whose content and retention remain governed by the owning feature's coverage declaration."
  },
  {
    "locator": "apps/desktop/electron/workspace-sequence-export.ts#temporary_storage:3292f1646f9e0c06:1",
    "owner": "apps/desktop",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.documentMedia.7",
    "reason": "This exact backup or export call is reviewed as a plaintext transfer boundary whose content and retention remain governed by the owning feature's coverage declaration."
  },
  {
    "locator": "packages/agent/src/tools/execute-artifact/execute-artifact.ts#log_emitter:89b81c36ea23316a:1",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.documentMedia.8",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/tools/file/workspace-commands.ts#log_emitter:7ef703451e44cded:1",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.documentMedia.9",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/tools/media/generate-image.ts#log_emitter:7ef703451e44cded:1",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.documentMedia.10",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/document-mutations/workspace-document-mutation-runtime.ts#log_emitter:89b81c36ea23316a:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.documentMedia.11",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/document-mutations/workspace-document-mutation-runtime.ts#log_emitter:89b81c36ea23316a:2",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.documentMedia.12",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/media-generation/production-runtime.ts#log_emitter:c4aa9c1f322aaa45:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.documentMedia.13",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/media-generation/production-worker.ts#log_emitter:89b81c36ea23316a:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.documentMedia.14",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/media-generation/production-worker.ts#log_emitter:0b61bd7468613846:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.documentMedia.15",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/messaging/agent-mediated.ts#log_emitter:7ef703451e44cded:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.documentMedia.16",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/messaging/agent-mediated.ts#log_emitter:0ae25e725db4e950:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.documentMedia.17",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/messaging/agent-mediated.ts#log_emitter:0ae25e725db4e950:2",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.documentMedia.18",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/workspace-artifacts.ts#log_emitter:89b81c36ea23316a:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.documentMedia.19",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/workspace-artifacts.ts#log_emitter:a1436e7c26c240df:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.documentMedia.20",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/workspace-artifacts.ts#log_emitter:a1436e7c26c240df:2",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.documentMedia.21",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/workspace-artifacts.ts#log_emitter:a1436e7c26c240df:3",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.documentMedia.22",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/workspace-artifacts.ts#log_emitter:89b81c36ea23316a:2",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.documentMedia.23",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/workspace-artifacts.ts#log_emitter:a1436e7c26c240df:4",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.documentMedia.24",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/workspace-artifacts.ts#log_emitter:89b81c36ea23316a:3",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.documentMedia.25",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/workspace-artifacts.ts#log_emitter:89b81c36ea23316a:4",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.documentMedia.26",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/workspace-artifacts.ts#log_emitter:89b81c36ea23316a:5",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.documentMedia.27",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/workspace-artifacts.ts#log_emitter:a1436e7c26c240df:5",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.documentMedia.28",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  }
];

export const SUPERSEDED_MAIN_2026_09_09_DOCUMENTMEDIA_SOURCE_LOCATORS = new Set<string>([]);
