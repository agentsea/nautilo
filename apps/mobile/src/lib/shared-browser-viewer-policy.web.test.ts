import { describe, expect, test } from "bun:test";

import {
  SHARED_BROWSER_VIEWER_RECEIPT_SCHEMA_VERSION,
  sharedBrowserViewerAvailability,
  sharedBrowserViewerQualificationEligibility,
  validateSharedBrowserViewerQualificationReceipt,
} from "./shared-browser-viewer-policy.web";
import { evaluateQualificationProbeInput } from "../../scripts/shared-browser-viewer-qualification-probe";

function physicalPdfReceipt() {
  return {
    schemaVersion: SHARED_BROWSER_VIEWER_RECEIPT_SCHEMA_VERSION,
    format: "pdf" as const,
    runtime: { name: "Mobile Safari", device: "iPhone 15", os: "iOS 18", browser: "Safari 18", browserFamily: "safari" as const },
    physical: true,
    build: { sourceRevision: "b".repeat(40), mobileExportSha256: "c".repeat(64), serverImageDigest: `sha256:${"d".repeat(64)}` },
    fixture: { id: "pdf-boundary-v1", class: "boundary" as const, sha256: "a".repeat(64), declaredSourceBytes: 1_024, observedSourceBytes: 1_024, metadataBytes: 128 },
    host: { metadataCapBytes: 256, sourceCapBytes: 2_048, maxActiveAcquisitions: 1, ooxmlEntryCap: 10, ooxmlInflatedBytesCap: 4_096 },
    acquisition: { declaredBytes: 1_024, observedBytes: 1_024, redirectMode: "error" as const, attempts: 1, maxActiveAcquisitions: 1, outcome: "completed" as const },
    parser: { cloneCount: 1, cloneBytes: 1_024, masterDetachedAfterHandoff: true, parserDetached: true },
    rendered: {
      kind: "pages" as const,
      count: 1,
      interaction: { rotation: "observed" as const, zoom: "observed" as const, layout: "observed" as const },
      canvas: { status: "observed" as const, pixelWidth: 320, pixelHeight: 480, devicePixelRatio: 2 },
    },
    deadlines: {
      acquisition: { configuredMs: 20, elapsedMs: 10, outcome: "met" as const },
      parse: { configuredMs: 40, elapsedMs: 20, outcome: "met" as const },
      render: { configuredMs: 60, elapsedMs: 30, outcome: "met" as const },
      cleanup: { configuredMs: 20, elapsedMs: 5, outcome: "met" as const },
      worker: { configuredMs: 60, elapsedMs: 30, outcome: "met" as const },
      total: { configuredMs: 120, elapsedMs: 65, outcome: "met" as const },
    },
    lifecycle: { replacementCleanupObserved: true, failureCleanupObserved: true, closeObserved: true, destroyCalls: 1, postCloseWaitMs: 5, postCloseReclaimed: true },
    assets: [{ status: "loaded" as const, kind: "pdf-worker" as const, url: "/mobile/assets/pdf-worker.mjs", mimeType: "text/javascript", sha256: "e".repeat(64) }],
    memory: { status: "observed" as const, methodology: "browser-instrumentation" as const, beforeBytes: 1, peakBytes: 2, afterBytes: 1 },
  };
}

describe("shared browser viewer qualification policy", () => {
  test("keeps an automated runtime unqualified and every format unavailable", () => {
    const receipt = physicalPdfReceipt();
    receipt.physical = false;
    expect(validateSharedBrowserViewerQualificationReceipt(receipt).valid).toBe(true);
    expect(sharedBrowserViewerQualificationEligibility(receipt)).toMatchObject({ eligible: false, reason: "non-physical-runtime" });
    expect(sharedBrowserViewerAvailability("pdf")).toEqual({ available: false, reason: "no-approved-qualification-policy" });
  });

  test("rejects unknown, remote, and weak-identity receipt data", () => {
    const unknown = { ...physicalPdfReceipt(), leaked: "token" };
    expect(validateSharedBrowserViewerQualificationReceipt(unknown).valid).toBe(false);
    const remoteAsset = physicalPdfReceipt();
    remoteAsset.assets[0].url = "https://assets.nautilo.dev/pdf-worker.mjs";
    expect(validateSharedBrowserViewerQualificationReceipt(remoteAsset).valid).toBe(false);
    const weakBuild = physicalPdfReceipt();
    weakBuild.build.sourceRevision = "d515-rc1";
    expect(validateSharedBrowserViewerQualificationReceipt(weakBuild).valid).toBe(false);
  });

  test("requires byte agreement, one acquisition, deadlines, lifecycle, and observed memory", () => {
    const receipt = physicalPdfReceipt();
    receipt.acquisition.observedBytes = 1_025;
    expect(sharedBrowserViewerQualificationEligibility(receipt)).toMatchObject({ eligible: false, reason: "incomplete-boundary-evidence" });
    receipt.acquisition.observedBytes = 1_024;
    receipt.host.maxActiveAcquisitions = 2;
    expect(sharedBrowserViewerQualificationEligibility(receipt)).toMatchObject({ eligible: false, reason: "incomplete-boundary-evidence" });
    receipt.host.maxActiveAcquisitions = 1;
    receipt.acquisition.maxActiveAcquisitions = 2;
    expect(sharedBrowserViewerQualificationEligibility(receipt)).toMatchObject({ eligible: false, reason: "incomplete-boundary-evidence" });
    receipt.acquisition.maxActiveAcquisitions = 1;
    const missedDeadline = { ...receipt, deadlines: { ...receipt.deadlines, render: { ...receipt.deadlines.render, outcome: "missed" as const } } };
    expect(sharedBrowserViewerQualificationEligibility(missedDeadline)).toMatchObject({ eligible: false, reason: "incomplete-boundary-evidence" });
    const unknownMemory = { ...receipt, memory: { status: "unknown" as const, reason: "api-unavailable" as const } };
    expect(sharedBrowserViewerQualificationEligibility(unknownMemory)).toMatchObject({ eligible: false, reason: "incomplete-boundary-evidence" });
    const unreclaimedMemory = { ...receipt, memory: { ...receipt.memory, afterBytes: 2 } };
    expect(sharedBrowserViewerQualificationEligibility(unreclaimedMemory)).toMatchObject({ eligible: false, reason: "invalid-receipt" });
    const missingDeadline = { ...receipt, deadlines: { ...receipt.deadlines, total: { ...receipt.deadlines.total, configuredMs: 0 } } };
    expect(sharedBrowserViewerQualificationEligibility(missingDeadline)).toMatchObject({ eligible: false, reason: "invalid-receipt" });
  });

  test("requires actual OOXML inflation rather than accepting a declared value", () => {
    const receipt = { ...physicalPdfReceipt(), format: "docx" as const, archive: { entries: 1, declaredInflatedBytes: 1_024, actualInflatedBytes: "unknown" as const }, assets: [{ status: "loaded" as const, kind: "renderer-wasm" as const, url: "/mobile/assets/silurus.wasm", mimeType: "application/wasm", sha256: "e".repeat(64) }] };
    expect(validateSharedBrowserViewerQualificationReceipt(receipt).valid).toBe(true);
    expect(sharedBrowserViewerQualificationEligibility(receipt)).toMatchObject({ eligible: false, reason: "incomplete-boundary-evidence" });
    const observedInflation = { ...receipt, archive: { ...receipt.archive, actualInflatedBytes: 1_024 } };
    expect(sharedBrowserViewerQualificationEligibility(observedInflation)).toMatchObject({ eligible: true, reason: "eligible-for-separate-approval" });
    const declaredOverCap = { ...observedInflation, archive: { ...observedInflation.archive, declaredInflatedBytes: 4_097 } };
    expect(sharedBrowserViewerQualificationEligibility(declaredOverCap)).toMatchObject({ eligible: false, reason: "incomplete-boundary-evidence" });
  });

  test("accepts only complete physical evidence as a separate approval candidate", () => {
    const receipt = physicalPdfReceipt();
    expect(sharedBrowserViewerQualificationEligibility(receipt)).toMatchObject({ eligible: true, reason: "eligible-for-separate-approval" });
  });

  test("CLI decision exits nonzero for every incomplete receipt", () => {
    const incomplete = physicalPdfReceipt();
    incomplete.lifecycle.destroyCalls = 2;
    expect(evaluateQualificationProbeInput(JSON.stringify(incomplete))).toMatchObject({
      exitCode: 1,
      result: {
        valid: true,
        eligibleForSeparateApproval: false,
        reason: "incomplete-boundary-evidence",
      },
    });
    expect(evaluateQualificationProbeInput(JSON.stringify(physicalPdfReceipt()))).toMatchObject({
      exitCode: 0,
      result: {
        valid: true,
        eligibleForSeparateApproval: true,
        reason: "eligible-for-separate-approval",
      },
    });
  });
});
