/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import type { CredentialMetadata } from "@nautilo/api-client/browser";
import { personalProviderKeyRows } from "./personal-provider-key-presentation";

const legacy: CredentialMetadata = {
  provider: "gateway", id: "legacy", revision: 1,
  createdAt: "2026-10-05T00:00:00Z", updatedAt: "2026-10-05T00:00:00Z",
  validationStatus: "accepted", validatedAt: null, requiresReplacement: false,
  masked: "gw-…", destination: null, receiptReadStatus: "unknown",
};

describe("personal provider key presentation", () => {
  test("keeps the shared order and never offers gateway as a normal personal provider", () => {
    const rows = personalProviderKeyRows(null);
    const ids = rows.map((row) => row.id);
    expect(ids.indexOf("surplus")).toBe(ids.indexOf("openrouter") + 1);
    expect(ids).not.toContain("gateway");
    expect(rows.every((row) => !row.available)).toBeTrue();
  });

  test("adds a saved legacy gateway only as an unavailable delete-only row", () => {
    const rows = personalProviderKeyRows({ credentials: [legacy], providers: [{ id: "gateway", name: "Gateway", purpose: "Legacy", personalCapabilities: ["chat"], destination: null }] });
    const gateway = rows.find((row) => row.id === "gateway");
    expect(gateway).toMatchObject({ catalogued: false, available: false });
  });
});
