import { describe, expect, test } from "bun:test";
import {
  BROWSER_DOCUMENT_VIEWER_SECURITY_MAXIMA,
  validateOoxmlHostPolicy,
  validatePdfHostPolicy,
} from "../src/policy";

describe("browser document viewer host policy", () => {
  test("requires an explicit PDF policy within the shared ceiling", () => {
    expect(validatePdfHostPolicy({ maxSourceBytes: 1 })).toEqual({ ok: true });
    expect(
      validatePdfHostPolicy({
        maxSourceBytes:
          BROWSER_DOCUMENT_VIEWER_SECURITY_MAXIMA.pdf.maxSourceBytes + 1,
      }),
    ).toEqual({ ok: false, reason: "exceeds_shared_maximum" });
  });

  test("rejects invalid and oversized OOXML host policies", () => {
    const maxima = BROWSER_DOCUMENT_VIEWER_SECURITY_MAXIMA.ooxml;
    const policy = {
      maxSourceBytes: maxima.maxSourceBytes,
      archivePreflight: {
        maxEntries: maxima.maxArchiveEntries,
        maxDeclaredTotalUncompressedBytes: BigInt(
          maxima.maxDeclaredTotalUncompressedBytes,
        ),
        maxDeclaredPerEntryUncompressedBytes: BigInt(
          maxima.maxDeclaredPerEntryUncompressedBytes,
        ),
      },
      workerTimeoutMs: maxima.workerTimeoutMs,
      totalLoadTimeoutMs: maxima.totalLoadTimeoutMs,
    };
    expect(validateOoxmlHostPolicy(policy)).toEqual({ ok: true });
    expect(
      validateOoxmlHostPolicy({
        ...policy,
        archivePreflight: { ...policy.archivePreflight, maxEntries: 0 },
      }),
    ).toEqual({ ok: false, reason: "invalid" });
    expect(
      validateOoxmlHostPolicy({
        ...policy,
        totalLoadTimeoutMs: maxima.totalLoadTimeoutMs + 1,
      }),
    ).toEqual({ ok: false, reason: "exceeds_shared_maximum" });
    expect(
      validateOoxmlHostPolicy({
        ...policy,
        archivePreflight: {
          ...policy.archivePreflight,
          maxDeclaredTotalUncompressedBytes: 0n,
        },
      }),
    ).toEqual({ ok: false, reason: "invalid" });
    expect(
      validateOoxmlHostPolicy({
        ...policy,
        archivePreflight: {
          ...policy.archivePreflight,
          maxDeclaredTotalUncompressedBytes: 1n,
          maxDeclaredPerEntryUncompressedBytes: 2n,
        },
      }),
    ).toEqual({ ok: false, reason: "invalid" });
    expect(
      validateOoxmlHostPolicy({
        ...policy,
        totalLoadTimeoutMs: policy.workerTimeoutMs - 1,
      }),
    ).toEqual({ ok: false, reason: "invalid" });
  });
});
