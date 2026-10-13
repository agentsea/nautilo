import { describe, expect, test } from "bun:test";
import {
  foregroundMemoryCryptoPublicationReceipts,
  protectedTaskWakeContinuationReceipts,
} from "@nautilo/db/schema";
import { getTableConfig } from "drizzle-orm/pg-core";

import {
  REVIEWED_TASK_PROTECTION_COVERAGE_ENTRIES,
  REVIEWED_TASK_PROTECTION_DEBT_LINKS,
} from "../../baseline/reviewed-task-protection-coverage";
import { BASELINE_REGISTRY, WAVE_0_FROZEN_BASELINE_DEBT } from "../../baseline/existing-debt";

describe("Task protection inventory review", () => {
  test("covers the exact new Task database and wire observations", () => {
    const entries = REVIEWED_TASK_PROTECTION_COVERAGE_ENTRIES;
    const database = entries.filter((entry) => entry.surface === "db");
    const wire = entries.filter((entry) => entry.surface === "wire");

    expect(database).toHaveLength(203);
    expect(wire).toHaveLength(20);
    expect(REVIEWED_TASK_PROTECTION_DEBT_LINKS).toHaveLength(3);
    expect(new Set([
      ...entries.map((entry) => entry.locator),
      ...REVIEWED_TASK_PROTECTION_DEBT_LINKS.map((entry) => entry.locator),
    ]).size).toBe(226);
  });

  test("covers every fresh foreground Memory publication receipt field", () => {
    const tableLocator = "public.foreground_memory_crypto_publication_receipts";
    const expectedLocators = [
      tableLocator,
      ...getTableConfig(foregroundMemoryCryptoPublicationReceipts).columns.map(
        (column) => `${tableLocator}.${column.name}`,
      ),
    ].sort();
    const entries = REVIEWED_TASK_PROTECTION_COVERAGE_ENTRIES.filter(
      (entry) => entry.locator === tableLocator
        || entry.locator.startsWith(`${tableLocator}.`),
    );
    expect(entries.map((entry) => entry.locator).sort()).toEqual(expectedLocators);
    expect(entries).toHaveLength(10);
    for (const entry of entries) {
      expect(entry.classification === "bounded_metadata"
        ? entry.plaintextReason
        : "").toMatch(/no Memory content, ciphertext, envelope, prompt, result, transcript, private key, recipient key or signed request bytes/i);
    }
  });

  test("covers every immutable wake continuation receipt field as content-free metadata", () => {
    const tableLocator = "public.protected_task_wake_continuation_receipts";
    const expectedLocators = [
      tableLocator,
      ...getTableConfig(protectedTaskWakeContinuationReceipts).columns.map(
        (column) => `${tableLocator}.${column.name}`,
      ),
    ].sort();
    const entries = REVIEWED_TASK_PROTECTION_COVERAGE_ENTRIES.filter(
      (entry) => entry.locator === tableLocator
        || entry.locator.startsWith(`${tableLocator}.`),
    );

    expect(entries.map((entry) => entry.locator).sort()).toEqual(expectedLocators);
    expect(entries).toHaveLength(31);
    for (const entry of entries) {
      expect(entry.classification).toBe("bounded_metadata");
      expect(entry.classification === "bounded_metadata"
        ? entry.plaintextReason
        : "").toMatch(/no prompt, result, transcript, checkpoint payload, private key or recipient key/i);
    }
  });

  test("keeps crypto lifecycle and repair state content-free", () => {
    const metadata = REVIEWED_TASK_PROTECTION_COVERAGE_ENTRIES.filter(
      (entry) => entry.surface === "db",
    );
    expect(metadata.every((entry) => entry.classification === "bounded_metadata"))
      .toBe(true);

    for (const suffix of [
      ".historical_repair",
      ".operational_metadata",
      ".signed_publication_request_bytes",
      ".raw_result_message_intent",
      ".claim",
      ".local_execution_delegation",
      ".funding_binding",
    ]) {
      const entry = metadata.find((candidate) => candidate.locator.endsWith(suffix));
      expect(entry, `missing reviewed ${suffix}`).toBeDefined();
      expect(entry?.classification === "bounded_metadata"
        ? entry.plaintextReason
        : "").toMatch(/no |cannot contain|outside|remain|content-free/i);
    }
  });

  test("classifies private content transport under current Namespace authority", () => {
    const protectedLocators = REVIEWED_TASK_PROTECTION_COVERAGE_ENTRIES
      .filter((entry) => entry.classification === "protected")
      .map((entry) => entry.locator);

    expect(protectedLocators).toHaveLength(13);
    expect(protectedLocators).toContain(
      "http:request_response:GET /api/protected/tasks/:taskId/definition",
    );
    expect(protectedLocators).toContain(
      "http:request_response:GET /api/protected/tasks/:taskId/runs/:taskRunId/result",
    );
    expect(protectedLocators).toContain(
      "http:request_response:POST /api/tasks/content/backfill/source",
    );
    expect(protectedLocators).toContain(
      "http:request_response:POST /api/tasks/pending-attention/read#response.body.events[].tools[].args",
    );
  });

  test("retains ordinary content-v1 projections as existing Task debt", () => {
    const links = new Map(REVIEWED_TASK_PROTECTION_DEBT_LINKS.map((entry) => [
      entry.locator,
      entry.targetDebtIds,
    ]));
    expect(links.get("http:request_response:GET /api/tasks/content-v1"))
      .toEqual(["debt.wire.http.request.response.get.api.tasks.1veo2i8"]);
    expect(links.get(
      "http:request_response:GET /api/tasks/:id/content-v1#response.body.runs[].content.transcript[].toolCalls[].args",
    )).toEqual(["debt.wire.arbitrary.19ijf0o"]);
    const originalDebt = WAVE_0_FROZEN_BASELINE_DEBT.find((entry) => entry.id === "debt.wire.arbitrary.19ijf0o");
    expect(originalDebt?.locator).toBe("http:request_response:GET /api/tasks/:id#response.body.runs[].transcript[].toolCalls[].args");
    expect(BASELINE_REGISTRY.debt.some((entry) => entry.id === originalDebt?.id)).toBe(true);
    // Plain callers still receive the original transcript detail. The new
    // content-v1 entrance is additive; it cannot retire that existing debt.
    expect(BASELINE_REGISTRY.retiredFrozenDebt?.some((entry) => entry.debtId === originalDebt?.id)).toBe(false);
  });
});
