import { describe, expect, test } from "bun:test";

import { BASELINE_REGISTRY } from "../../baseline/existing-debt";

describe("M318 Full Message inventory boundaries", () => {
  test("keeps mixed Shadow ordinary bytes in the frozen Message wire boundary", () => {
    const links = BASELINE_REGISTRY.reviewedDebtLinks?.filter((link) =>
      link.id.startsWith("link.wire.m318.shadow-read-")
    );

    expect(links).toHaveLength(2);
    expect(links?.map((link) => link.locator).sort()).toEqual([
      "http:request_response:POST /api/rooms/:id/messages/shadow-read",
      "http:request_response:POST /api/rooms/:id/messages/shadow-read/:operationId/ack#request.body",
    ]);
    expect(links?.every((link) =>
      link.targetDebtIds.includes(
        "debt.wire.http.accepted.arbitrary.packages.server.src.messaging.dispatch.ts.roompostmessagebody.cpix9d",
      )
    )).toBe(true);
  });

  test("classifies edit ciphertext across the exact closed Namespace families", () => {
    const editEntries = BASELINE_REGISTRY.entries.filter((entry) =>
      entry.locator.startsWith(
        "http:request_response:PATCH /api/rooms/:roomId/messages/:messageId/protected",
      )
    );

    expect(editEntries).toHaveLength(2);
    expect(editEntries.every((entry) =>
      entry.classification === "protected"
      && entry.keyFamily === "namespace_ai_or_human"
      && entry.migrationState === "ciphertext_only"
    )).toBe(true);
  });
});
