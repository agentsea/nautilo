import type { SourceAlarmReview } from "../src/node/source-alarm-review";

/** Exact reviewed source calls from the current main platform provenance. */
export const REVIEWED_MAIN_2026_09_09_PLATFORM_SOURCE_ALARMS: readonly SourceAlarmReview[] = [
  {
    "locator": "apps/desktop/electron/auth/deep-link.ts#log_emitter:4756c3e14ab387e2:1",
    "owner": "apps/desktop",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.1",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "apps/desktop/electron/auth/deep-link.ts#log_emitter:bd77be9cc8f1779a:1",
    "owner": "apps/desktop",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.2",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "apps/desktop/electron/auth/token-store-electron.ts#log_emitter:0989754d41137a1e:1",
    "owner": "apps/desktop",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.3",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "apps/desktop/electron/fs-structural-ipc.ts#filesystem_write:b4d4777c37564569:1",
    "owner": "apps/desktop",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.4",
    "reason": "This exact call is a reviewed filesystem-write boundary. Its bytes and retention remain governed by the owning feature's coverage declaration; recording the call site does not classify arbitrary file content as safe metadata."
  },
  {
    "locator": "apps/desktop/electron/fs-structural-ipc.ts#filesystem_write:f0d15df548d63786:1",
    "owner": "apps/desktop",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.5",
    "reason": "This exact call is a reviewed filesystem-write boundary. Its bytes and retention remain governed by the owning feature's coverage declaration; recording the call site does not classify arbitrary file content as safe metadata."
  },
  {
    "locator": "apps/desktop/electron/fs-structural-ipc.ts#filesystem_write:4bc031be8d6ad2b1:2",
    "owner": "apps/desktop",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.6",
    "reason": "This exact call is a reviewed filesystem-write boundary. Its bytes and retention remain governed by the owning feature's coverage declaration; recording the call site does not classify arbitrary file content as safe metadata."
  },
  {
    "locator": "apps/desktop/electron/main.ts#network_processor:4cb9916574d10a14:1",
    "owner": "apps/desktop",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.7",
    "reason": "This exact call is a reviewed plaintext network processor boundary. Its request and response remain subject to the owning feature's DTO and coverage declarations; this review does not treat remote processing as encrypted storage."
  },
  {
    "locator": "apps/desktop/electron/main.ts#temporary_storage:713f3cc7f19f64fb:1",
    "owner": "apps/desktop",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.8",
    "reason": "This exact backup or export call is reviewed as a plaintext transfer boundary whose content and retention remain governed by the owning feature's coverage declaration."
  },
  {
    "locator": "apps/desktop/electron/main.ts#filesystem_write:47b270ae035bea05:1",
    "owner": "apps/desktop",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.9",
    "reason": "This exact call is a reviewed filesystem-write boundary. Its bytes and retention remain governed by the owning feature's coverage declaration; recording the call site does not classify arbitrary file content as safe metadata."
  },
  {
    "locator": "apps/desktop/electron/main.ts#temporary_storage:87cdd3fc3960cc39:1",
    "owner": "apps/desktop",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.10",
    "reason": "This exact backup or export call is reviewed as a plaintext transfer boundary whose content and retention remain governed by the owning feature's coverage declaration."
  },
  {
    "locator": "apps/desktop/electron/main.ts#temporary_storage:0a18a2e7a86494b1:1",
    "owner": "apps/desktop",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.11",
    "reason": "This exact backup or export call is reviewed as a plaintext transfer boundary whose content and retention remain governed by the owning feature's coverage declaration."
  },
  {
    "locator": "apps/desktop/electron/main.ts#filesystem_write:7804b7f2f08112df:1",
    "owner": "apps/desktop",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.12",
    "reason": "This exact call is a reviewed filesystem-write boundary. Its bytes and retention remain governed by the owning feature's coverage declaration; recording the call site does not classify arbitrary file content as safe metadata."
  },
  {
    "locator": "apps/desktop/electron/main.ts#network_processor:7494b0a4bd675ee0:1",
    "owner": "apps/desktop",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.13",
    "reason": "This exact call is a reviewed plaintext network processor boundary. Its request and response remain subject to the owning feature's DTO and coverage declarations; this review does not treat remote processing as encrypted storage."
  },
  {
    "locator": "apps/desktop/electron/main.ts#log_emitter:c88b9bfe0560c022:16",
    "owner": "apps/desktop",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.14",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "apps/desktop/electron/main.ts#log_emitter:c88b9bfe0560c022:17",
    "owner": "apps/desktop",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.15",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "apps/desktop/electron/main.ts#log_emitter:c88b9bfe0560c022:18",
    "owner": "apps/desktop",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.16",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "apps/desktop/electron/main.ts#log_emitter:c88b9bfe0560c022:19",
    "owner": "apps/desktop",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.17",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "apps/desktop/electron/sequence-export-host.ts#temporary_storage:65118a0f1dacad0d:1",
    "owner": "apps/desktop",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.18",
    "reason": "This exact backup or export call is reviewed as a plaintext transfer boundary whose content and retention remain governed by the owning feature's coverage declaration."
  },
  {
    "locator": "apps/desktop/electron/sequence-export-host.ts#filesystem_write:604740edc0f8d204:1",
    "owner": "apps/desktop",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.19",
    "reason": "This exact call is a reviewed filesystem-write boundary. Its bytes and retention remain governed by the owning feature's coverage declaration; recording the call site does not classify arbitrary file content as safe metadata."
  },
  {
    "locator": "apps/desktop/electron/sequence-export-host.ts#subprocess_processor:a536c8590ec41360:1",
    "owner": "apps/desktop",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.20",
    "reason": "This exact call is a reviewed plaintext subprocess boundary. Arguments, standard streams, and files remain governed by the owning feature's coverage declaration; this review makes no encrypted-processing claim."
  },
  {
    "locator": "apps/desktop/electron/sequence-export-host.ts#temporary_storage:6b537a259342c1ef:1",
    "owner": "apps/desktop",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.21",
    "reason": "This exact backup or export call is reviewed as a plaintext transfer boundary whose content and retention remain governed by the owning feature's coverage declaration."
  },
  {
    "locator": "apps/desktop/electron/sequence-renderer.ts#temporary_storage:03cc69f9bb80f027:1",
    "owner": "apps/desktop",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.22",
    "reason": "This exact backup or export call is reviewed as a plaintext transfer boundary whose content and retention remain governed by the owning feature's coverage declaration."
  },
  {
    "locator": "apps/desktop/electron/sequence-text-raster.ts#filesystem_write:44ad983e5f06b985:1",
    "owner": "apps/desktop",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.23",
    "reason": "This exact call is a reviewed filesystem-write boundary. Its bytes and retention remain governed by the owning feature's coverage declaration; recording the call site does not classify arbitrary file content as safe metadata."
  },
  {
    "locator": "apps/desktop/scripts/build-qualification-cua-driver.ts#subprocess_processor:9297ff68dfef7bd9:1",
    "owner": "apps/desktop",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.24",
    "reason": "This exact call is a reviewed plaintext subprocess boundary. Arguments, standard streams, and files remain governed by the owning feature's coverage declaration; this review makes no encrypted-processing claim."
  },
  {
    "locator": "apps/desktop/scripts/build-qualification-cua-driver.ts#temporary_storage:09e35acdea31c27a:1",
    "owner": "apps/desktop",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.25",
    "reason": "This exact backup or export call is reviewed as a plaintext transfer boundary whose content and retention remain governed by the owning feature's coverage declaration."
  },
  {
    "locator": "apps/desktop/scripts/build-qualification-cua-driver.ts#temporary_storage:defa21a6d82af84a:1",
    "owner": "apps/desktop",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.26",
    "reason": "This exact backup or export call is reviewed as a plaintext transfer boundary whose content and retention remain governed by the owning feature's coverage declaration."
  },
  {
    "locator": "apps/desktop/scripts/build-qualification-cua-driver.ts#filesystem_write:a0dc0be4d8f8e6ee:1",
    "owner": "apps/desktop",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.27",
    "reason": "This exact call is a reviewed filesystem-write boundary. Its bytes and retention remain governed by the owning feature's coverage declaration; recording the call site does not classify arbitrary file content as safe metadata."
  },
  {
    "locator": "apps/desktop/scripts/build-qualification-cua-driver.ts#filesystem_write:207c50774f53e604:1",
    "owner": "apps/desktop",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.28",
    "reason": "This exact call is a reviewed filesystem-write boundary. Its bytes and retention remain governed by the owning feature's coverage declaration; recording the call site does not classify arbitrary file content as safe metadata."
  },
  {
    "locator": "apps/desktop/scripts/build-qualification-cua-driver.ts#filesystem_write:6488a36f160fff01:1",
    "owner": "apps/desktop",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.29",
    "reason": "This exact call is a reviewed filesystem-write boundary. Its bytes and retention remain governed by the owning feature's coverage declaration; recording the call site does not classify arbitrary file content as safe metadata."
  },
  {
    "locator": "apps/desktop/scripts/build-qualification-cua-driver.ts#filesystem_write:207c50774f53e604:2",
    "owner": "apps/desktop",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.30",
    "reason": "This exact call is a reviewed filesystem-write boundary. Its bytes and retention remain governed by the owning feature's coverage declaration; recording the call site does not classify arbitrary file content as safe metadata."
  },
  {
    "locator": "apps/workbench/src/components/browser-column/apps-panel.tsx#filesystem_write:4cf5ee4921cf7987:1",
    "owner": "apps/workbench",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.31",
    "reason": "This exact call is a reviewed filesystem-write boundary. Its bytes and retention remain governed by the owning feature's coverage declaration; recording the call site does not classify arbitrary file content as safe metadata."
  },
  {
    "locator": "apps/workbench/src/lib/admission-fetch.ts#network_processor:03b2501c0c62a1a9:1",
    "owner": "apps/workbench",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.32",
    "reason": "This exact call is a reviewed plaintext network processor boundary. Its request and response remain subject to the owning feature's DTO and coverage declarations; this review does not treat remote processing as encrypted storage."
  },
  {
    "locator": "bin/nautilo-dev/scripts/qualify-sheets-browser.ts#temporary_storage:c168ab06fd2ced69:1",
    "owner": "bin/nautilo-dev",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.33",
    "reason": "This exact backup or export call is reviewed as a plaintext transfer boundary whose content and retention remain governed by the owning feature's coverage declaration."
  },
  {
    "locator": "bin/nautilo-dev/scripts/qualify-sheets-browser.ts#temporary_storage:d6da990cb51e8227:1",
    "owner": "bin/nautilo-dev",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.34",
    "reason": "This exact backup or export call is reviewed as a plaintext transfer boundary whose content and retention remain governed by the owning feature's coverage declaration."
  },
  {
    "locator": "bin/nautilo-dev/scripts/qualify-sheets-browser.ts#network_processor:5023a20296f359e1:1",
    "owner": "bin/nautilo-dev",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.35",
    "reason": "This exact call is a reviewed plaintext network processor boundary. Its request and response remain subject to the owning feature's DTO and coverage declarations; this review does not treat remote processing as encrypted storage."
  },
  {
    "locator": "bin/nautilo-dev/scripts/qualify-sheets-browser.ts#log_emitter:468c68ed4723a1f2:1",
    "owner": "bin/nautilo-dev",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.36",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "bin/nautilo-local/src/bootstrap-logto.ts#log_emitter:0ae25e725db4e950:1",
    "owner": "bin/nautilo-local",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.37",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "bin/nautilo-local/src/bootstrap-logto.ts#log_emitter:0ae25e725db4e950:2",
    "owner": "bin/nautilo-local",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.38",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "bin/nautilo-local/src/bootstrap-logto.ts#log_emitter:0ae25e725db4e950:3",
    "owner": "bin/nautilo-local",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.39",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "bin/nautilo-local/src/bootstrap-logto.ts#log_emitter:7ef703451e44cded:1",
    "owner": "bin/nautilo-local",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.40",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "bin/nautilo-local/src/bootstrap-logto.ts#log_emitter:7ef703451e44cded:2",
    "owner": "bin/nautilo-local",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.41",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "bin/nautilo-local/src/bootstrap-logto.ts#log_emitter:7ef703451e44cded:3",
    "owner": "bin/nautilo-local",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.42",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "bin/nautilo-local/src/bootstrap-logto.ts#log_emitter:7ef703451e44cded:4",
    "owner": "bin/nautilo-local",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.43",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "bin/nautilo-local/src/bootstrap-logto.ts#log_emitter:7ef703451e44cded:5",
    "owner": "bin/nautilo-local",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.44",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "bin/nautilo-local/src/bootstrap-logto.ts#log_emitter:7ef703451e44cded:6",
    "owner": "bin/nautilo-local",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.45",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "bin/nautilo-local/src/bootstrap-logto.ts#log_emitter:7ef703451e44cded:7",
    "owner": "bin/nautilo-local",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.46",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "bin/nautilo-local/src/bootstrap-logto.ts#log_emitter:7ef703451e44cded:8",
    "owner": "bin/nautilo-local",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.47",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "bin/nautilo-local/src/bootstrap-logto.ts#log_emitter:0ae25e725db4e950:4",
    "owner": "bin/nautilo-local",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.48",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "bin/nautilo-local/src/bootstrap-logto.ts#log_emitter:7ef703451e44cded:9",
    "owner": "bin/nautilo-local",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.49",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "bin/nautilo-local/src/bootstrap-logto.ts#log_emitter:7ef703451e44cded:10",
    "owner": "bin/nautilo-local",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.50",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "bin/nautilo-local/src/bootstrap-logto.ts#log_emitter:7ef703451e44cded:11",
    "owner": "bin/nautilo-local",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.51",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "bin/nautilo-local/src/bootstrap-logto.ts#log_emitter:7ef703451e44cded:12",
    "owner": "bin/nautilo-local",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.52",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "bin/nautilo-local/src/bootstrap-logto.ts#log_emitter:7ef703451e44cded:13",
    "owner": "bin/nautilo-local",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.53",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "bin/nautilo-local/src/bootstrap-logto.ts#log_emitter:7ef703451e44cded:14",
    "owner": "bin/nautilo-local",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.54",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "bin/nautilo-local/src/bootstrap-logto.ts#log_emitter:0ae25e725db4e950:5",
    "owner": "bin/nautilo-local",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.55",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "bin/nautilo-local/src/bootstrap-logto.ts#log_emitter:0ae25e725db4e950:6",
    "owner": "bin/nautilo-local",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.56",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "bin/nautilo-local/src/bootstrap-logto.ts#log_emitter:7ef703451e44cded:15",
    "owner": "bin/nautilo-local",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.57",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "bin/nautilo-local/src/bootstrap-logto.ts#log_emitter:7ef703451e44cded:16",
    "owner": "bin/nautilo-local",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.58",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "bin/nautilo-local/src/bootstrap-logto.ts#log_emitter:0ae25e725db4e950:7",
    "owner": "bin/nautilo-local",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.59",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "bin/nautilo-local/src/bootstrap-logto.ts#log_emitter:94eba768650da227:1",
    "owner": "bin/nautilo-local",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.60",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "bin/nautilo-local/src/bootstrap-logto.ts#log_emitter:7ef703451e44cded:17",
    "owner": "bin/nautilo-local",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.61",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "bin/nautilo-relay/src/index.ts#log_emitter:5400f5bb9a50f72b:1",
    "owner": "bin/nautilo-relay",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.62",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "bin/nautilo-relay/src/index.ts#log_emitter:7ef703451e44cded:1",
    "owner": "bin/nautilo-relay",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.63",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "bin/nautilo-relay/src/index.ts#log_emitter:7ef703451e44cded:2",
    "owner": "bin/nautilo-relay",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.64",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "bin/nautilo-relay/src/index.ts#log_emitter:7ef703451e44cded:3",
    "owner": "bin/nautilo-relay",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.65",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "bin/nautilo-relay/src/index.ts#log_emitter:7ef703451e44cded:4",
    "owner": "bin/nautilo-relay",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.66",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "bin/nautilo-relay/src/index.ts#log_emitter:7ef703451e44cded:5",
    "owner": "bin/nautilo-relay",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.67",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "bin/nautilo-relay/src/index.ts#log_emitter:7ef703451e44cded:6",
    "owner": "bin/nautilo-relay",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.68",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "bin/nautilo-relay/src/index.ts#log_emitter:7ef703451e44cded:7",
    "owner": "bin/nautilo-relay",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.69",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "bin/nautilo-relay/src/index.ts#log_emitter:7ef703451e44cded:8",
    "owner": "bin/nautilo-relay",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.70",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "bin/nautilo-relay/src/index.ts#log_emitter:7ef703451e44cded:9",
    "owner": "bin/nautilo-relay",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.71",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "bin/nautilo-relay/src/index.ts#log_emitter:7ef703451e44cded:10",
    "owner": "bin/nautilo-relay",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.72",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "bin/nautilo-server/src/index.ts#log_emitter:89b81c36ea23316a:1",
    "owner": "bin/nautilo-server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.73",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "bin/nautilo-server/src/index.ts#log_emitter:89b81c36ea23316a:2",
    "owner": "bin/nautilo-server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.74",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "bin/nautilo-server/src/index.ts#log_emitter:89b81c36ea23316a:3",
    "owner": "bin/nautilo-server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.75",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "bin/nautilo-server/src/index.ts#log_emitter:a1436e7c26c240df:1",
    "owner": "bin/nautilo-server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.76",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "bin/nautilo-server/src/index.ts#log_emitter:a1436e7c26c240df:2",
    "owner": "bin/nautilo-server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.77",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "bin/nautilo-server/src/index.ts#log_emitter:89b81c36ea23316a:4",
    "owner": "bin/nautilo-server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.78",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "bin/nautilo-server/src/index.ts#log_emitter:a1436e7c26c240df:3",
    "owner": "bin/nautilo-server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.79",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "bin/nautilo-server/src/index.ts#log_emitter:a1436e7c26c240df:4",
    "owner": "bin/nautilo-server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.80",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "bin/nautilo-server/src/index.ts#log_emitter:a1436e7c26c240df:5",
    "owner": "bin/nautilo-server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.81",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "bin/nautilo-server/src/index.ts#log_emitter:89b81c36ea23316a:5",
    "owner": "bin/nautilo-server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.82",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "bin/nautilo-server/src/index.ts#log_emitter:a1436e7c26c240df:6",
    "owner": "bin/nautilo-server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.83",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "bin/nautilo-server/src/index.ts#log_emitter:89b81c36ea23316a:6",
    "owner": "bin/nautilo-server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.84",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/chat/vision-fallback.ts#log_emitter:7ef703451e44cded:1",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.85",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/chat/vision-fallback.ts#log_emitter:7ef703451e44cded:2",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.86",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/chat/vision-fallback.ts#log_emitter:7ef703451e44cded:3",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.87",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/chat/vision-fallback.ts#log_emitter:7ef703451e44cded:4",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.88",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/chat/vision-fallback.ts#log_emitter:7ef703451e44cded:5",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.89",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/chat/vision-fallback.ts#log_emitter:7ef703451e44cded:6",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.90",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/config/venice-catalog-cache.ts#log_emitter:7ef703451e44cded:1",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.91",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/config/venice-catalog-cache.ts#log_emitter:7ef703451e44cded:2",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.92",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/config/venice-catalog-cache.ts#log_emitter:7ef703451e44cded:3",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.93",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/config/venice-catalog-cache.ts#log_emitter:7ef703451e44cded:4",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.94",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/config/venice-catalog-cache.ts#log_emitter:7ef703451e44cded:5",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.95",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/config/venice-catalog-cache.ts#log_emitter:7ef703451e44cded:6",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.96",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/graph/resume-approval-ask.ts#log_emitter:7ef703451e44cded:1",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.97",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/graph/resume-approval-ask.ts#log_emitter:7ef703451e44cded:2",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.98",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/graph/resume-approval.ts#log_emitter:7ef703451e44cded:1",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.99",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/graph/resume-approval.ts#log_emitter:7ef703451e44cded:2",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.100",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/graph/resume-approval.ts#log_emitter:7ef703451e44cded:3",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.101",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/graph/resume-host-choice.ts#log_emitter:7ef703451e44cded:1",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.102",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/graph/resume-host-choice.ts#log_emitter:7ef703451e44cded:2",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.103",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/graph/resume-human-reply.ts#log_emitter:7ef703451e44cded:1",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.104",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/graph/resume-human-reply.ts#log_emitter:7ef703451e44cded:2",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.105",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/graph/resume-human-reply.ts#log_emitter:7ef703451e44cded:3",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.106",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/graph/resume-identity.ts#log_emitter:7ef703451e44cded:1",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.107",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/graph/resume-identity.ts#log_emitter:7ef703451e44cded:2",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.108",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/graph/resume-identity.ts#log_emitter:7ef703451e44cded:3",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.109",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/nodes/agent.ts#log_emitter:7ef703451e44cded:1",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.110",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/nodes/agent.ts#log_emitter:7ef703451e44cded:2",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.111",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/nodes/agent.ts#log_emitter:7ef703451e44cded:3",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.112",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/nodes/agent.ts#log_emitter:7ef703451e44cded:4",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.113",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/nodes/post-model.ts#log_emitter:7ef703451e44cded:1",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.114",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/nodes/post-model.ts#log_emitter:0ae25e725db4e950:1",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.115",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/nodes/post-model.ts#log_emitter:0ae25e725db4e950:2",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.116",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/nodes/post-model.ts#log_emitter:0ae25e725db4e950:3",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.117",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/nodes/post-model.ts#log_emitter:0ae25e725db4e950:4",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.118",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/nodes/post-model.ts#log_emitter:7ef703451e44cded:2",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.119",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/nodes/post-model.ts#log_emitter:7ef703451e44cded:3",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.120",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/nodes/post-model.ts#log_emitter:7ef703451e44cded:4",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.121",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/nodes/post-model.ts#log_emitter:7ef703451e44cded:5",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.122",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/nodes/post-model.ts#log_emitter:7ef703451e44cded:6",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.123",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/nodes/post-model.ts#log_emitter:7ef703451e44cded:7",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.124",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/nodes/post-model.ts#log_emitter:7ef703451e44cded:8",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.125",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/nodes/post-model.ts#log_emitter:7ef703451e44cded:9",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.126",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/nodes/post-model.ts#log_emitter:7ef703451e44cded:10",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.127",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/nodes/post-model.ts#log_emitter:7ef703451e44cded:11",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.128",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/nodes/post-model.ts#log_emitter:0ae25e725db4e950:5",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.129",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/nodes/post-model.ts#log_emitter:7ef703451e44cded:12",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.130",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/nodes/post-model.ts#log_emitter:7ef703451e44cded:13",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.131",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/nodes/pre-model.ts#log_emitter:0ae25e725db4e950:1",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.132",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/nodes/pre-model.ts#log_emitter:7ef703451e44cded:1",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.133",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/nodes/pre-model.ts#log_emitter:7ef703451e44cded:2",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.134",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/nodes/pre-model.ts#log_emitter:0ae25e725db4e950:2",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.135",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/nodes/pre-model.ts#log_emitter:0ae25e725db4e950:3",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.136",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/nodes/pre-model.ts#log_emitter:7ef703451e44cded:3",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.137",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/nodes/pre-model.ts#log_emitter:0ae25e725db4e950:4",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.138",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/nodes/pre-model.ts#log_emitter:0ae25e725db4e950:5",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.139",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/nodes/pre-model.ts#log_emitter:7ef703451e44cded:4",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.140",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/nodes/pre-model.ts#log_emitter:7ef703451e44cded:5",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.141",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/nodes/pre-model.ts#log_emitter:7ef703451e44cded:6",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.142",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/nodes/pre-model.ts#log_emitter:7ef703451e44cded:7",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.143",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/nodes/pre-model.ts#log_emitter:7ef703451e44cded:8",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.144",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/nodes/tools.ts#log_emitter:a1436e7c26c240df:1",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.145",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/providers/factory.ts#network_processor:e829d74f519d9d59:1",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.146",
    "reason": "This exact call is a reviewed plaintext network processor boundary. Its request and response remain subject to the owning feature's DTO and coverage declarations; this review does not treat remote processing as encrypted storage."
  },
  {
    "locator": "packages/agent/src/relay/sandbox-profile-builder.ts#log_emitter:a1436e7c26c240df:1",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.147",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/soul/generate-soul-file.ts#log_emitter:a1436e7c26c240df:1",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.148",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/soul/generate-soul-file.ts#log_emitter:a1436e7c26c240df:2",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.149",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/soul/generate-soul-file.ts#log_emitter:a1436e7c26c240df:3",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.150",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/subagents/deep-research/agent/graph.ts#log_emitter:89b81c36ea23316a:1",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.151",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/subagents/deep-research/agent/graph.ts#log_emitter:89b81c36ea23316a:2",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.152",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/subagents/deep-research/researcher/graph.ts#log_emitter:4e85f52761523682:1",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.153",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/subagents/deep-research/supervisor/graph.ts#log_emitter:89b81c36ea23316a:1",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.154",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/subagents/deep-research/tools/index.ts#log_emitter:7ef703451e44cded:1",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.155",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/tools/file/commands/apply-core.ts#log_emitter:a1436e7c26c240df:1",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.156",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/tools/file/commands/apply-core.ts#log_emitter:a1436e7c26c240df:2",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.157",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/tools/file/commands/apply-core.ts#log_emitter:a1436e7c26c240df:3",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.158",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/tools/file/commands/apply-core.ts#log_emitter:a1436e7c26c240df:4",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.159",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/tools/file/user-patch.ts#log_emitter:89b81c36ea23316a:1",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.160",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/tools/file/user-patch.ts#log_emitter:a1436e7c26c240df:1",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.161",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/tools/file/user-save.ts#log_emitter:a1436e7c26c240df:1",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.162",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/tools/file/user-save.ts#log_emitter:a1436e7c26c240df:2",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.163",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/tools/invocation-service.ts#log_emitter:7ef703451e44cded:1",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.164",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/tools/invocation-service.ts#log_emitter:0ae25e725db4e950:1",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.165",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/tools/invocation-service.ts#log_emitter:7ef703451e44cded:2",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.166",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/tools/invocation-service.ts#log_emitter:7ef703451e44cded:3",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.167",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/tools/research/run-deep-research.ts#log_emitter:89b81c36ea23316a:1",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.168",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/tools/research/run-deep-research.ts#log_emitter:89b81c36ea23316a:2",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.169",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/tools/security/research-note-draft.ts#log_emitter:7ef703451e44cded:1",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.170",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/tools/security/research-note-draft.ts#log_emitter:7ef703451e44cded:2",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.171",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/tools/tasks/shortcuts/ask-peer.ts#log_emitter:7ef703451e44cded:1",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.172",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/tools/tasks/shortcuts/generate-repo-docs.ts#log_emitter:7ef703451e44cded:1",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.173",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/tools/tasks/shortcuts/in-background.ts#log_emitter:7ef703451e44cded:1",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.174",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/tools/tasks/shortcuts/in-private-namespace.ts#log_emitter:7ef703451e44cded:1",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.175",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/tools/tasks/shortcuts/in-scope.ts#log_emitter:7ef703451e44cded:1",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.176",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/tools/tasks/shortcuts/schedule.ts#log_emitter:7ef703451e44cded:1",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.177",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/tools/tasks/task-tool.ts#log_emitter:7ef703451e44cded:1",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.178",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/tools/utilities/read-webpage.ts#log_emitter:89b81c36ea23316a:1",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.179",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/tools/utilities/read-webpage.ts#log_emitter:89b81c36ea23316a:2",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.180",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/tools/utilities/web-search.ts#log_emitter:0ae25e725db4e950:1",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.181",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/tools/utilities/web-search.ts#log_emitter:0ae25e725db4e950:2",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.182",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/tools/utilities/web-search.ts#log_emitter:0ae25e725db4e950:3",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.183",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/tools/utilities/web-search.ts#log_emitter:0ae25e725db4e950:4",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.184",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/usage/provider-cost-recorder.ts#log_emitter:89b81c36ea23316a:1",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.185",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/usage/record-usage.ts#log_emitter:a1436e7c26c240df:1",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.186",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/utils/invoke.ts#log_emitter:89b81c36ea23316a:1",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.187",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/utils/model-health.ts#log_emitter:7ef703451e44cded:1",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.188",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/utils/model-health.ts#log_emitter:7ef703451e44cded:2",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.189",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/agent/src/utils/model-health.ts#log_emitter:7ef703451e44cded:3",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.190",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/config-guard/src/transaction.ts#log_emitter:b42bef868da1b34b:1",
    "owner": "packages/config-guard",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.191",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/config-guard/src/transaction.ts#log_emitter:b42bef868da1b34b:2",
    "owner": "packages/config-guard",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.192",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/config-guard/src/transaction.ts#log_emitter:57bff0db6fb2985e:1",
    "owner": "packages/config-guard",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.193",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/config-guard/src/transaction.ts#log_emitter:b42bef868da1b34b:3",
    "owner": "packages/config-guard",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.194",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/config-guard/src/transaction.ts#log_emitter:b42bef868da1b34b:4",
    "owner": "packages/config-guard",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.195",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/config/src/ensure-directory-tree.ts#log_emitter:a5aef895faeb7d41:1",
    "owner": "packages/config",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.196",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/config/src/migrate-storage-layout.ts#log_emitter:7ef703451e44cded:1",
    "owner": "packages/config",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.197",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/config/src/migrate-storage-layout.ts#log_emitter:7ef703451e44cded:2",
    "owner": "packages/config",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.198",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/config/src/sibling-instance-ports.ts#log_emitter:a1436e7c26c240df:1",
    "owner": "packages/config",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.199",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/config/src/sibling-instance-ports.ts#log_emitter:a1436e7c26c240df:2",
    "owner": "packages/config",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.200",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/db/scripts/finalize-m313-repair-source.ts#filesystem_write:df680bf60066c513:1",
    "owner": "packages/db",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.201",
    "reason": "This exact call is a reviewed filesystem-write boundary. Its bytes and retention remain governed by the owning feature's coverage declaration; recording the call site does not classify arbitrary file content as safe metadata."
  },
  {
    "locator": "packages/db/scripts/finalize-m313-tool-context.ts#filesystem_write:df680bf60066c513:1",
    "owner": "packages/db",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.202",
    "reason": "This exact call is a reviewed filesystem-write boundary. Its bytes and retention remain governed by the owning feature's coverage declaration; recording the call site does not classify arbitrary file content as safe metadata."
  },
  {
    "locator": "packages/first-party-apps/design/scripts/generate-bundled-fonts.ts#log_emitter:c467686340f4efc2:1",
    "owner": "packages/first-party-apps",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.203",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/first-party-apps/design/scripts/generate-bundled-fonts.ts#filesystem_write:de2abd3934745534:1",
    "owner": "packages/first-party-apps",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.204",
    "reason": "This exact call is a reviewed filesystem-write boundary. Its bytes and retention remain governed by the owning feature's coverage declaration; recording the call site does not classify arbitrary file content as safe metadata."
  },
  {
    "locator": "packages/first-party-apps/spreadsheet/scripts/capture-preview.ts#log_emitter:468c68ed4723a1f2:1",
    "owner": "packages/first-party-apps",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.205",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/hosting/src/server-release-publication.ts#filesystem_write:febb47bcf1c5069c:1",
    "owner": "packages/hosting",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.206",
    "reason": "This exact call is a reviewed filesystem-write boundary. Its bytes and retention remain governed by the owning feature's coverage declaration; recording the call site does not classify arbitrary file content as safe metadata."
  },
  {
    "locator": "packages/hosting/src/server-release-publication.ts#filesystem_write:ce0c2279fda4a6af:1",
    "owner": "packages/hosting",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.207",
    "reason": "This exact call is a reviewed filesystem-write boundary. Its bytes and retention remain governed by the owning feature's coverage declaration; recording the call site does not classify arbitrary file content as safe metadata."
  },
  {
    "locator": "packages/hosting/src/server-release-publication.ts#filesystem_write:b8bafc7e88becf13:1",
    "owner": "packages/hosting",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.208",
    "reason": "This exact call is a reviewed filesystem-write boundary. Its bytes and retention remain governed by the owning feature's coverage declaration; recording the call site does not classify arbitrary file content as safe metadata."
  },
  {
    "locator": "packages/hosting/src/server-release-publication.ts#filesystem_write:e46d41a03aed5f54:1",
    "owner": "packages/hosting",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.209",
    "reason": "This exact call is a reviewed filesystem-write boundary. Its bytes and retention remain governed by the owning feature's coverage declaration; recording the call site does not classify arbitrary file content as safe metadata."
  },
  {
    "locator": "packages/mcp-client/src/manager.ts#log_emitter:a5aef895faeb7d41:1",
    "owner": "packages/mcp-client",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.210",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/mcp-client/src/manager.ts#log_emitter:a5aef895faeb7d41:2",
    "owner": "packages/mcp-client",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.211",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/model-capabilities/src/cache.ts#log_emitter:7ef703451e44cded:1",
    "owner": "packages/model-capabilities",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.212",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/model-capabilities/src/cache.ts#log_emitter:7ef703451e44cded:2",
    "owner": "packages/model-capabilities",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.213",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/model-capabilities/src/cache.ts#log_emitter:7ef703451e44cded:3",
    "owner": "packages/model-capabilities",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.214",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/office-core/scripts/build-css.ts#filesystem_write:65760ea155dc556c:1",
    "owner": "packages/office-core",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.215",
    "reason": "This exact call is a reviewed filesystem-write boundary. Its bytes and retention remain governed by the owning feature's coverage declaration; recording the call site does not classify arbitrary file content as safe metadata."
  },
  {
    "locator": "packages/office-core/scripts/build-css.ts#log_emitter:468c68ed4723a1f2:1",
    "owner": "packages/office-core",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.216",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/office-sheets/src/view/spreadsheet.ts#log_emitter:610f2f24bde78727:1",
    "owner": "packages/office-sheets",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.217",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/office-sheets/src/view/spreadsheet.ts#log_emitter:610f2f24bde78727:2",
    "owner": "packages/office-sheets",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.218",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/office-sheets/src/view/spreadsheet.ts#log_emitter:610f2f24bde78727:3",
    "owner": "packages/office-sheets",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.219",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/office-sheets/src/view/worksheet.ts#log_emitter:610f2f24bde78727:1",
    "owner": "packages/office-sheets",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.220",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/runtime/src/conductor/floor-manager.ts#log_emitter:0ae25e725db4e950:1",
    "owner": "packages/runtime",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.221",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/runtime/src/conductor/floor-manager.ts#log_emitter:0ae25e725db4e950:2",
    "owner": "packages/runtime",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.222",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/runtime/src/context/build-transcript-context-deps.ts#log_emitter:7ef703451e44cded:1",
    "owner": "packages/runtime",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.223",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/runtime/src/conversation/live-shadow-turn-context.ts#log_emitter:0ae25e725db4e950:1",
    "owner": "packages/runtime",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.224",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/runtime/src/conversation/live-shadow-turn-context.ts#log_emitter:0ae25e725db4e950:2",
    "owner": "packages/runtime",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.225",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/runtime/src/executors/deep-research-executor.ts#log_emitter:7ef703451e44cded:1",
    "owner": "packages/runtime",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.226",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/runtime/src/executors/deep-research-executor.ts#log_emitter:7ef703451e44cded:2",
    "owner": "packages/runtime",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.227",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/runtime/src/executors/fork-langgraph-executor.ts#log_emitter:7ef703451e44cded:1",
    "owner": "packages/runtime",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.228",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/runtime/src/executors/fork-langgraph-executor.ts#log_emitter:7ef703451e44cded:2",
    "owner": "packages/runtime",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.229",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/runtime/src/executors/fork-langgraph-executor.ts#log_emitter:7ef703451e44cded:3",
    "owner": "packages/runtime",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.230",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/runtime/src/executors/fork-langgraph-executor.ts#log_emitter:0ae25e725db4e950:1",
    "owner": "packages/runtime",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.231",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/runtime/src/executors/fork-langgraph-executor.ts#log_emitter:0ae25e725db4e950:2",
    "owner": "packages/runtime",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.232",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/runtime/src/executors/fork-langgraph-executor.ts#log_emitter:0ae25e725db4e950:3",
    "owner": "packages/runtime",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.233",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/runtime/src/executors/langgraph-executor.ts#log_emitter:d0b07fbb64f17f8f:1",
    "owner": "packages/runtime",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.234",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/runtime/src/executors/multimodal-job-input.ts#log_emitter:89b81c36ea23316a:1",
    "owner": "packages/runtime",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.235",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/runtime/src/executors/multimodal-job-input.ts#log_emitter:89b81c36ea23316a:2",
    "owner": "packages/runtime",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.236",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/runtime/src/executors/multimodal-job-input.ts#log_emitter:89b81c36ea23316a:3",
    "owner": "packages/runtime",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.237",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/runtime/src/executors/multimodal-job-input.ts#log_emitter:89b81c36ea23316a:4",
    "owner": "packages/runtime",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.238",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/runtime/src/executors/multimodal-job-input.ts#log_emitter:89b81c36ea23316a:5",
    "owner": "packages/runtime",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.239",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/runtime/src/job-manager.ts#log_emitter:0ae25e725db4e950:1",
    "owner": "packages/runtime",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.240",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/runtime/src/job-manager.ts#log_emitter:0ae25e725db4e950:2",
    "owner": "packages/runtime",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.241",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/runtime/src/job-manager.ts#log_emitter:0ae25e725db4e950:3",
    "owner": "packages/runtime",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.242",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/runtime/src/job-manager.ts#log_emitter:0ae25e725db4e950:4",
    "owner": "packages/runtime",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.243",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/runtime/src/job-manager.ts#log_emitter:0ae25e725db4e950:5",
    "owner": "packages/runtime",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.244",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/runtime/src/job-manager.ts#log_emitter:0ae25e725db4e950:6",
    "owner": "packages/runtime",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.245",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/runtime/src/job-manager.ts#log_emitter:0ae25e725db4e950:7",
    "owner": "packages/runtime",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.246",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/runtime/src/job-manager.ts#log_emitter:0ae25e725db4e950:8",
    "owner": "packages/runtime",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.247",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/runtime/src/job-manager.ts#log_emitter:0ae25e725db4e950:9",
    "owner": "packages/runtime",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.248",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/runtime/src/job-manager.ts#log_emitter:0ae25e725db4e950:10",
    "owner": "packages/runtime",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.249",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/runtime/src/job-manager.ts#log_emitter:0ae25e725db4e950:11",
    "owner": "packages/runtime",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.250",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/runtime/src/job-manager.ts#log_emitter:7ef703451e44cded:1",
    "owner": "packages/runtime",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.251",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/runtime/src/job-manager.ts#log_emitter:0ae25e725db4e950:12",
    "owner": "packages/runtime",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.252",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/runtime/src/job-manager.ts#log_emitter:0ae25e725db4e950:13",
    "owner": "packages/runtime",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.253",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/runtime/src/job-manager.ts#log_emitter:0ae25e725db4e950:14",
    "owner": "packages/runtime",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.254",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/runtime/src/job-manager.ts#log_emitter:7ef703451e44cded:2",
    "owner": "packages/runtime",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.255",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/runtime/src/job-manager.ts#log_emitter:7ef703451e44cded:3",
    "owner": "packages/runtime",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.256",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/runtime/src/job-manager.ts#log_emitter:7ef703451e44cded:4",
    "owner": "packages/runtime",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.257",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/runtime/src/job-manager.ts#log_emitter:0ae25e725db4e950:15",
    "owner": "packages/runtime",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.258",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/runtime/src/job-manager.ts#log_emitter:0ae25e725db4e950:16",
    "owner": "packages/runtime",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.259",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/runtime/src/job-manager.ts#log_emitter:0ae25e725db4e950:17",
    "owner": "packages/runtime",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.260",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/runtime/src/job-manager.ts#log_emitter:0ae25e725db4e950:18",
    "owner": "packages/runtime",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.261",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/runtime/src/stenographer/worker.ts#log_emitter:808faa524bf2b947:1",
    "owner": "packages/runtime",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.262",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/runtime/src/tasks/dispatch-task-run.ts#log_emitter:7ef703451e44cded:1",
    "owner": "packages/runtime",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.263",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/runtime/src/tasks/dispatch-task-run.ts#log_emitter:0ae25e725db4e950:1",
    "owner": "packages/runtime",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.264",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/runtime/src/tasks/dispatch-task-run.ts#log_emitter:0ae25e725db4e950:2",
    "owner": "packages/runtime",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.265",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/runtime/src/tasks/dispatch-task-run.ts#log_emitter:0ae25e725db4e950:3",
    "owner": "packages/runtime",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.266",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/runtime/src/tasks/dispatch-task-run.ts#log_emitter:0ae25e725db4e950:4",
    "owner": "packages/runtime",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.267",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/runtime/src/tasks/lifecycle.ts#log_emitter:7ef703451e44cded:1",
    "owner": "packages/runtime",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.268",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/runtime/src/tasks/lifecycle.ts#log_emitter:0ae25e725db4e950:1",
    "owner": "packages/runtime",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.269",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/runtime/src/tasks/lifecycle.ts#log_emitter:7ef703451e44cded:2",
    "owner": "packages/runtime",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.270",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/runtime/src/tasks/repo-docs-task.ts#log_emitter:7ef703451e44cded:1",
    "owner": "packages/runtime",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.271",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/runtime/src/tasks/report-back.ts#log_emitter:0ae25e725db4e950:1",
    "owner": "packages/runtime",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.272",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/runtime/src/tasks/report-back.ts#log_emitter:0ae25e725db4e950:2",
    "owner": "packages/runtime",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.273",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/runtime/src/tasks/report-back.ts#log_emitter:7ef703451e44cded:1",
    "owner": "packages/runtime",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.274",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/runtime/src/tasks/report-back.ts#log_emitter:7ef703451e44cded:2",
    "owner": "packages/runtime",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.275",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/runtime/src/tasks/resume-task-approval.ts#log_emitter:7ef703451e44cded:1",
    "owner": "packages/runtime",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.276",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/runtime/src/tasks/resume-task-approval.ts#log_emitter:7ef703451e44cded:2",
    "owner": "packages/runtime",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.277",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/runtime/src/tasks/task-observer.ts#log_emitter:28f19505bd1449a2:1",
    "owner": "packages/runtime",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.278",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/runtime/src/tasks/task-observer.ts#log_emitter:7ef703451e44cded:1",
    "owner": "packages/runtime",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.279",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/runtime/src/tasks/task-observer.ts#log_emitter:0ae25e725db4e950:1",
    "owner": "packages/runtime",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.280",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/runtime/src/tasks/task-observer.ts#log_emitter:0ae25e725db4e950:2",
    "owner": "packages/runtime",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.281",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/runtime/src/tasks/task-observer.ts#log_emitter:0ae25e725db4e950:3",
    "owner": "packages/runtime",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.282",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/runtime/src/tasks/task-observer.ts#log_emitter:7ef703451e44cded:2",
    "owner": "packages/runtime",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.283",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/runtime/src/tasks/task-observer.ts#log_emitter:0ae25e725db4e950:4",
    "owner": "packages/runtime",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.284",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/runtime/src/tasks/task-observer.ts#log_emitter:7ef703451e44cded:3",
    "owner": "packages/runtime",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.285",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/runtime/src/tasks/task-observer.ts#log_emitter:7ef703451e44cded:4",
    "owner": "packages/runtime",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.286",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/runtime/src/tasks/task-observer.ts#log_emitter:0ae25e725db4e950:5",
    "owner": "packages/runtime",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.287",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/runtime/src/tasks/task-observer.ts#log_emitter:0ae25e725db4e950:6",
    "owner": "packages/runtime",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.288",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/runtime/src/tasks/task-observer.ts#log_emitter:7ef703451e44cded:5",
    "owner": "packages/runtime",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.289",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/runtime/src/tasks/task-observer.ts#log_emitter:0ae25e725db4e950:7",
    "owner": "packages/runtime",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.290",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/runtime/src/tasks/task-run-executor.ts#log_emitter:7ef703451e44cded:1",
    "owner": "packages/runtime",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.291",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/runtime/src/tasks/task-run-executor.ts#log_emitter:7ef703451e44cded:2",
    "owner": "packages/runtime",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.292",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/runtime/src/tasks/task-run-executor.ts#log_emitter:7ef703451e44cded:3",
    "owner": "packages/runtime",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.293",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/runtime/src/tasks/task-run-executor.ts#log_emitter:7ef703451e44cded:4",
    "owner": "packages/runtime",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.294",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/runtime/src/tasks/task-run-executor.ts#log_emitter:7ef703451e44cded:5",
    "owner": "packages/runtime",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.295",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/sandbox/src/bubblewrap.ts#log_emitter:a5aef895faeb7d41:1",
    "owner": "packages/sandbox",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.296",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/sandbox/src/bubblewrap.ts#log_emitter:a5aef895faeb7d41:2",
    "owner": "packages/sandbox",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.297",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/sandbox/src/passthrough.ts#log_emitter:89b81c36ea23316a:1",
    "owner": "packages/sandbox",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.298",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/sandbox/src/seatbelt.ts#log_emitter:a1436e7c26c240df:1",
    "owner": "packages/sandbox",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.299",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/sandbox/src/spawn.ts#log_emitter:a1436e7c26c240df:1",
    "owner": "packages/sandbox",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.300",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/security/src/command-scanner.ts#log_emitter:a5aef895faeb7d41:1",
    "owner": "packages/security",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.301",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/security/src/path-deny.ts#log_emitter:89b81c36ea23316a:1",
    "owner": "packages/security",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.302",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/security/src/path-deny.ts#log_emitter:89b81c36ea23316a:2",
    "owner": "packages/security",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.303",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/acp/opencode-task-execution-composition.ts#log_emitter:0bcb62519c163510:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.304",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/acp/task-execution-composition.ts#log_emitter:5ff8c26151fe50ca:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.305",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/app.ts#log_emitter:57bff0db6fb2985e:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.306",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/app.ts#log_emitter:89b81c36ea23316a:19",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.307",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/apps/app-routes.ts#log_emitter:a1436e7c26c240df:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.308",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/apps/app-routes.ts#log_emitter:a1436e7c26c240df:2",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.309",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/apps/app-routes.ts#log_emitter:a1436e7c26c240df:3",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.310",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/apps/app-tool-host.ts#log_emitter:89b81c36ea23316a:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.311",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/apps/app-tool-registration.ts#log_emitter:a1436e7c26c240df:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.312",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/apps/app-tool-registration.ts#log_emitter:89b81c36ea23316a:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.313",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/auth/resolve-bearer.ts#log_emitter:7ef703451e44cded:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.314",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/connected-apps/service.ts#log_emitter:3c34a236f8b0999d:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.315",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/connected-apps/service.ts#log_emitter:89b81c36ea23316a:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.316",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/connected-apps/service.ts#log_emitter:b4d80a858be836ca:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.317",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/connected-web-accounts/operation-production-runtime.ts#log_emitter:89b81c36ea23316a:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.318",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/connected-web-accounts/operation-production-runtime.ts#log_emitter:c880a2b622dffa5a:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.319",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/connected-web-accounts/operation-production-runtime.ts#log_emitter:89b81c36ea23316a:2",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.320",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/connected-web-accounts/operation-production-runtime.ts#log_emitter:89b81c36ea23316a:3",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.321",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/connected-web-accounts/operation-production-runtime.ts#log_emitter:89b81c36ea23316a:4",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.322",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/connected-web-accounts/operation-wake.ts#log_emitter:89b81c36ea23316a:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.323",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/connected-web-accounts/read-tool-runtime.ts#log_emitter:89b81c36ea23316a:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.324",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/costs/provider-cost-recorder.ts#log_emitter:89b81c36ea23316a:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.325",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/lib/agent-photo-library-production.ts#log_emitter:69f117518016213a:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.326",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/lib/agent-photo-library-service.ts#log_emitter:69f117518016213a:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.327",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/lib/agent-photo-library-service.ts#log_emitter:57bff0db6fb2985e:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.328",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/lib/agent-photo-library-service.ts#log_emitter:69f117518016213a:2",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.329",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/lib/agent-photo-library-service.ts#log_emitter:8d99c28f0d96a8e2:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.330",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/lib/posture-sidecar.ts#log_emitter:a1436e7c26c240df:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.331",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/lib/posture-sidecar.ts#log_emitter:a1436e7c26c240df:2",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.332",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/lib/security-audit-log.ts#log_emitter:89b81c36ea23316a:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.333",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/lib/security-audit-log.ts#log_emitter:89b81c36ea23316a:2",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.334",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/lib/security-audit-log.ts#log_emitter:a1436e7c26c240df:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.335",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/lib/security-audit-log.ts#log_emitter:89b81c36ea23316a:3",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.336",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/lib/strict-shadow-policy.ts#log_emitter:a1436e7c26c240df:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.337",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/lib/user-account-deletion.ts#log_emitter:89b81c36ea23316a:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.338",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/lib/user-account-deletion.ts#log_emitter:89b81c36ea23316a:2",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.339",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/lib/user-account-deletion.ts#log_emitter:89b81c36ea23316a:3",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.340",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/mcp/local-mcp-install-service.ts#log_emitter:89b81c36ea23316a:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.341",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/mcp/mcp-host.ts#log_emitter:0ae25e725db4e950:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.342",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/mcp/mcp-host.ts#log_emitter:0ae25e725db4e950:2",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.343",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/mcp/relay-mcp-bridge.ts#log_emitter:0ae25e725db4e950:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.344",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/messaging/agent-redirect-handler.ts#log_emitter:7ef703451e44cded:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.345",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/messaging/agent-redirect-handler.ts#log_emitter:7ef703451e44cded:2",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.346",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/messaging/attachments.ts#log_emitter:7ef703451e44cded:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.347",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/messaging/await-resume.ts#log_emitter:0ae25e725db4e950:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.348",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/messaging/await-resume.ts#log_emitter:0ae25e725db4e950:2",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.349",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/messaging/await-resume.ts#log_emitter:7ef703451e44cded:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.350",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/messaging/dispatch.ts#log_emitter:7ef703451e44cded:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.351",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/messaging/dispatch.ts#log_emitter:0ae25e725db4e950:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.352",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/messaging/dispatch.ts#log_emitter:0ae25e725db4e950:2",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.353",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/messaging/dispatch.ts#log_emitter:7ef703451e44cded:2",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.354",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/messaging/dispatch.ts#log_emitter:7ef703451e44cded:3",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.355",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/messaging/dispatch.ts#log_emitter:7ef703451e44cded:4",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.356",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/messaging/dispatch.ts#log_emitter:0ae25e725db4e950:3",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.357",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/messaging/dispatch.ts#log_emitter:7ef703451e44cded:5",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.358",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/messaging/dispatch.ts#log_emitter:0ae25e725db4e950:4",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.359",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/messaging/dispatch.ts#log_emitter:0ae25e725db4e950:5",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.360",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/messaging/dispatch.ts#log_emitter:0ae25e725db4e950:6",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.361",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/messaging/dispatch.ts#log_emitter:7ef703451e44cded:6",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.362",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/messaging/dispatch.ts#log_emitter:0ae25e725db4e950:7",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.363",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/messaging/dispatch.ts#log_emitter:7ef703451e44cded:7",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.364",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/messaging/dispatch.ts#log_emitter:0ae25e725db4e950:8",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.365",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/messaging/dispatch.ts#log_emitter:7ef703451e44cded:8",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.366",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/messaging/dispatch.ts#log_emitter:0ae25e725db4e950:9",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.367",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/messaging/dispatch.ts#log_emitter:0ae25e725db4e950:10",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.368",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/messaging/dispatch.ts#log_emitter:0ae25e725db4e950:11",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.369",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/messaging/dispatch.ts#log_emitter:0ae25e725db4e950:12",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.370",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/messaging/dispatch.ts#log_emitter:0ae25e725db4e950:13",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.371",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/messaging/dispatch.ts#log_emitter:0ae25e725db4e950:14",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.372",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/messaging/dispatch.ts#log_emitter:0ae25e725db4e950:15",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.373",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/messaging/dispatch.ts#log_emitter:0ae25e725db4e950:16",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.374",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/messaging/dispatch.ts#log_emitter:0ae25e725db4e950:17",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.375",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/push/push-delivery-runtime.ts#log_emitter:89b81c36ea23316a:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.376",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/push/push-delivery-worker.ts#log_emitter:89b81c36ea23316a:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.377",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/realtime/event-bridge.ts#log_emitter:a1436e7c26c240df:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.378",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/realtime/event-bridge.ts#log_emitter:a1436e7c26c240df:2",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.379",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/realtime/tts-service.ts#log_emitter:7ef703451e44cded:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.380",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/realtime/tts-service.ts#log_emitter:7ef703451e44cded:2",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.381",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/realtime/tts-service.ts#log_emitter:7ef703451e44cded:3",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.382",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/realtime/tts-service.ts#log_emitter:0ae25e725db4e950:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.383",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/realtime/tts-service.ts#log_emitter:7ef703451e44cded:4",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.384",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/realtime/tts-service.ts#log_emitter:7ef703451e44cded:5",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.385",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/realtime/ws-publisher.ts#log_emitter:0ae25e725db4e950:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.386",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/realtime/ws-publisher.ts#log_emitter:0ae25e725db4e950:2",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.387",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/realtime/ws-publisher.ts#log_emitter:0ae25e725db4e950:3",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.388",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/realtime/ws-publisher.ts#log_emitter:7ef703451e44cded:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.389",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/_helpers/avatar.ts#log_emitter:57bff0db6fb2985e:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.390",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/access-control-mutations.ts#log_emitter:89b81c36ea23316a:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.391",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/access-control-mutations.ts#log_emitter:89b81c36ea23316a:2",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.392",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/access-control-mutations.ts#log_emitter:89b81c36ea23316a:3",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.393",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/account.ts#log_emitter:57bff0db6fb2985e:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.394",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/account.ts#log_emitter:57bff0db6fb2985e:2",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.395",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/account.ts#log_emitter:57bff0db6fb2985e:3",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.396",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/account.ts#log_emitter:57bff0db6fb2985e:4",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.397",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/account.ts#log_emitter:57bff0db6fb2985e:5",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.398",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/account.ts#log_emitter:57bff0db6fb2985e:6",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.399",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/account.ts#log_emitter:57bff0db6fb2985e:7",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.400",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/account.ts#log_emitter:57bff0db6fb2985e:8",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.401",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/admin-users.ts#log_emitter:0ae25e725db4e950:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.402",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/agent-photo-library.ts#log_emitter:a90c23f4818770fe:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.403",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/auth.ts#log_emitter:7ef703451e44cded:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.404",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/auth.ts#log_emitter:0ae25e725db4e950:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.405",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/auth.ts#log_emitter:7ef703451e44cded:2",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.406",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/auth.ts#log_emitter:7ef703451e44cded:3",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.407",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/auth.ts#log_emitter:7ef703451e44cded:4",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.408",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/auth.ts#log_emitter:7ef703451e44cded:5",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.409",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/auth.ts#log_emitter:7ef703451e44cded:6",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.410",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/auth.ts#log_emitter:7ef703451e44cded:7",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.411",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/group-members.ts#log_emitter:89b81c36ea23316a:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.412",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/group-members.ts#log_emitter:89b81c36ea23316a:2",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.413",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/group-members.ts#log_emitter:89b81c36ea23316a:3",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.414",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/group-members.ts#log_emitter:89b81c36ea23316a:4",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.415",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/integrations-google.ts#log_emitter:89b81c36ea23316a:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.416",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/invites.ts#log_emitter:89b81c36ea23316a:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.417",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/invites.ts#log_emitter:89b81c36ea23316a:2",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.418",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/invites.ts#log_emitter:a1436e7c26c240df:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.419",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/invites.ts#log_emitter:a1436e7c26c240df:2",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.420",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/invites.ts#log_emitter:a1436e7c26c240df:3",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.421",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/invoke-direct.ts#log_emitter:0ae25e725db4e950:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.422",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/mcp-servers.ts#log_emitter:a1436e7c26c240df:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.423",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/mcp-servers.ts#log_emitter:a1436e7c26c240df:2",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.424",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/mcp-servers.ts#log_emitter:a1436e7c26c240df:3",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.425",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/office-proxy.ts#log_emitter:a1436e7c26c240df:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.426",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/office-proxy.ts#log_emitter:a1436e7c26c240df:2",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.427",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/office-proxy.ts#log_emitter:a1436e7c26c240df:3",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.428",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/profile-bundle.ts#log_emitter:35cfc6176f00d69e:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.429",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/profile-bundle.ts#log_emitter:57bff0db6fb2985e:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.430",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/profile-bundle.ts#log_emitter:57bff0db6fb2985e:2",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.431",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/profile-bundle.ts#log_emitter:57bff0db6fb2985e:3",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.432",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/profile-bundle.ts#log_emitter:57bff0db6fb2985e:4",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.433",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/profile-bundle.ts#log_emitter:57bff0db6fb2985e:5",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.434",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/profile-bundle.ts#log_emitter:57bff0db6fb2985e:6",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.435",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/profile-bundle.ts#log_emitter:57bff0db6fb2985e:7",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.436",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/profile-bundle.ts#log_emitter:57bff0db6fb2985e:8",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.437",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/profile-bundle.ts#log_emitter:57bff0db6fb2985e:9",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.438",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/profile-bundle.ts#log_emitter:57bff0db6fb2985e:10",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.439",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/profile-bundle.ts#log_emitter:57bff0db6fb2985e:11",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.440",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/profile-bundle.ts#log_emitter:57bff0db6fb2985e:12",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.441",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/profile-bundle.ts#log_emitter:57bff0db6fb2985e:13",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.442",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/profile-bundle.ts#log_emitter:57bff0db6fb2985e:14",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.443",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/profile-bundle.ts#log_emitter:57bff0db6fb2985e:15",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.444",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/profile-bundle.ts#log_emitter:57bff0db6fb2985e:16",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.445",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/profile-bundle.ts#log_emitter:57bff0db6fb2985e:17",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.446",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/profile-bundle.ts#log_emitter:57bff0db6fb2985e:18",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.447",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/profile-bundle.ts#log_emitter:57bff0db6fb2985e:19",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.448",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/reflection-status.ts#log_emitter:a90c23f4818770fe:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.449",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/reflection-status.ts#log_emitter:a90c23f4818770fe:2",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.450",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/relay.ts#log_emitter:a1436e7c26c240df:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.451",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/relay.ts#log_emitter:a1436e7c26c240df:2",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.452",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/relay.ts#log_emitter:a1436e7c26c240df:3",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.453",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/relay.ts#log_emitter:a1436e7c26c240df:4",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.454",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/security.ts#log_emitter:a1436e7c26c240df:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.455",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/server-context.ts#log_emitter:89b81c36ea23316a:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.456",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/server-context.ts#log_emitter:dd9ce09822966263:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.457",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/server-models.ts#log_emitter:89b81c36ea23316a:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.458",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/server-models.ts#log_emitter:dd9ce09822966263:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.459",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/server-profile.ts#log_emitter:89b81c36ea23316a:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.460",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/setup-status.ts#log_emitter:57bff0db6fb2985e:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.461",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/setup.ts#log_emitter:89b81c36ea23316a:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.462",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/stt.ts#log_emitter:7ef703451e44cded:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.463",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/stt.ts#log_emitter:7ef703451e44cded:2",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.464",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/webfinger.ts#log_emitter:7ef703451e44cded:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.465",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/wopi.ts#log_emitter:a1436e7c26c240df:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.466",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/wopi.ts#log_emitter:a1436e7c26c240df:2",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.467",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/wopi.ts#log_emitter:89b81c36ea23316a:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.468",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/wopi.ts#log_emitter:89b81c36ea23316a:2",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.469",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/wopi.ts#log_emitter:a1436e7c26c240df:3",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.470",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/wopi.ts#log_emitter:89b81c36ea23316a:3",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.471",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/workstation-access.ts#log_emitter:a1436e7c26c240df:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.472",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/ws.ts#log_emitter:a1436e7c26c240df:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.473",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/ws.ts#log_emitter:89b81c36ea23316a:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.474",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/ws.ts#log_emitter:89b81c36ea23316a:2",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.475",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/server/src/routes/ws.ts#log_emitter:89b81c36ea23316a:3",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.476",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/trust/src/canonical-transcript-mutations.ts#log_emitter:a1436e7c26c240df:1",
    "owner": "packages/trust",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.477",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/vault/src/master-persistence.ts#log_emitter:a1436e7c26c240df:1",
    "owner": "packages/vault",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.478",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/voice/src/adapters/elevenlabs.ts#log_emitter:89b81c36ea23316a:1",
    "owner": "packages/voice",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.479",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/voice/src/adapters/elevenlabs.ts#log_emitter:89b81c36ea23316a:2",
    "owner": "packages/voice",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.480",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/voice/src/adapters/elevenlabs.ts#log_emitter:89b81c36ea23316a:3",
    "owner": "packages/voice",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.481",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/voice/src/index.ts#log_emitter:89b81c36ea23316a:1",
    "owner": "packages/voice",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.482",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/voice/src/ptt/native-ptt.ts#log_emitter:89b81c36ea23316a:1",
    "owner": "packages/voice",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.483",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  },
  {
    "locator": "packages/voice/src/ptt/native-ptt.ts#log_emitter:89b81c36ea23316a:2",
    "owner": "packages/voice",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-09.platform.484",
    "reason": "This exact call remains on Nautilo's reviewed plaintext diagnostic boundary. The review does not claim that generic logged values are encrypted or content-free; it records the moved or added call site so further drift still fails closed."
  }
];

export const SUPERSEDED_MAIN_2026_09_09_PLATFORM_SOURCE_LOCATORS = new Set<string>([
  "apps/desktop/electron/fs-structural-ipc.ts#filesystem_write:70745a4547373545:1",
  "apps/workbench/src/components/avatar/authenticated-image.tsx#network_processor:1f6663783b014fd7:1",
  "apps/workbench/src/components/avatar/AvatarUploader.tsx#network_processor:ef993855494c1601:1",
  "apps/workbench/src/hooks/use-speech-recognition.ts#network_processor:0d2ab469d7540d61:1",
  "apps/workbench/src/lib/commands-api.ts#network_processor:0fe8627ecc022149:1",
  "apps/workbench/src/lib/commands-api.ts#network_processor:ef993855494c1601:1",
  "apps/workbench/src/lib/commands-api.ts#network_processor:ef993855494c1601:2",
  "apps/workbench/src/lib/commands-api.ts#network_processor:ef993855494c1601:3",
  "apps/workbench/src/lib/commands-api.ts#network_processor:ef993855494c1601:4",
  "apps/workbench/src/lib/commands-api.ts#network_processor:ef993855494c1601:5",
  "apps/workbench/src/lib/commands-api.ts#network_processor:ef993855494c1601:6",
  "apps/workbench/src/lib/costs-api.ts#network_processor:ef993855494c1601:1",
  "apps/workbench/src/lib/mcp-servers-api.ts#network_processor:0fe8627ecc022149:1",
  "apps/workbench/src/lib/mcp-servers-api.ts#network_processor:ef993855494c1601:1",
  "apps/workbench/src/lib/mcp-servers-api.ts#network_processor:ef993855494c1601:2",
  "apps/workbench/src/lib/mcp-servers-api.ts#network_processor:ef993855494c1601:3",
  "apps/workbench/src/lib/mcp-servers-api.ts#network_processor:ef993855494c1601:4",
  "apps/workbench/src/lib/skills-api.ts#network_processor:0fe8627ecc022149:1",
  "apps/workbench/src/lib/skills-api.ts#network_processor:ef993855494c1601:1",
  "apps/workbench/src/lib/skills-api.ts#network_processor:ef993855494c1601:2",
  "apps/workbench/src/lib/skills-api.ts#network_processor:ef993855494c1601:3",
  "apps/workbench/src/lib/skills-api.ts#network_processor:ef993855494c1601:4",
  "apps/workbench/src/lib/skills-api.ts#network_processor:ef993855494c1601:5",
  "apps/workbench/src/lib/skills-api.ts#network_processor:ef993855494c1601:6",
  "apps/workbench/src/pages/settings/sections/integrations-section.tsx#network_processor:ef993855494c1601:1",
  "apps/workbench/src/pages/settings/sections/profile-section.tsx#network_processor:ef993855494c1601:1",
  "packages/agent/src/providers/factory.ts#network_processor:541f3984bf38447f:2",
  "apps/desktop/electron/main.ts#log_emitter:63d2fefaeea77254:1",
  "apps/workbench/src/genie-customization/workbench-onboarding-api.ts#network_processor:0d2ab469d7540d61:1",
  "apps/workbench/src/genie-customization/workbench-onboarding-api.ts#network_processor:dd428cfed330de71:1",
  "apps/workbench/src/lib/mcp-servers-api.ts#network_processor:91224ca397fe11ad:1",
  "apps/workbench/src/lib/mcp-servers-api.ts#network_processor:91224ca397fe11ad:2",
  "apps/workbench/src/lib/skills-api.ts#network_processor:0fe8627ecc022149:2",
  "apps/workbench/src/pages/settings/sections/integrations-section.tsx#network_processor:0d2ab469d7540d61:1"
]);
