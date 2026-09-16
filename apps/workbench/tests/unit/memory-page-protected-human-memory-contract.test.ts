import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL("../../src/pages/memory/memory-page.tsx", import.meta.url),
  "utf8",
);
const facade = readFileSync(
  new URL("../../src/lib/memory-read-operations.ts", import.meta.url),
  "utf8",
);

describe("Memory page protected Human Memory activation", () => {
  test("binds Browser custody to the exact signed-in account and admission status", () => {
    expect(source).toContain("createBrowserHumanMemoryClient({");
    expect(source).toContain("userId: auth.viewer.sessionUserId");
    expect(source).toContain("humanActorId: auth.viewer.sessionActorId");
    expect(source).toContain(
      "resolveDeviceAdmissionStatus: () => apiClient.deviceAdmission.status()",
    );
    expect(source).toContain("if (accountKeyRef.current !== requestedAccount) return");
  });

  test("hides list, detail, search and brief representation selection behind the facade", () => {
    expect(source).toContain("memoryReads.list(options)");
    expect(source).toContain("memoryReads.detail(memoryId)");
    expect(source).toContain("memoryReads.search({ q, includeArchive: showArchived })");
    expect(source).toContain("memoryReads.brief()");
    expect(source).not.toContain("protectedMode");
    expect(source).not.toContain("policyMode");
    expect(facade).toContain('mode: "text"');
    expect(facade).toContain("protectedPort(input.protected).search");
  });

  test("uses server-advertised embedding coordinates for protected edits", () => {
    expect(source).toContain("await apiClient.getMemoryProcessorRecipient()");
    expect(facade).toContain("requestedProvider: embedding.provider");
    expect(facade).toContain("requestedModel: embedding.model");
    expect(source).not.toContain('requestedProvider: "openai"');
  });

  test("reports committed updates whose durable follow-up is pending", () => {
    expect(source).toContain("Memory saved; follow-up processing pending");
    expect(source).toContain('"followUpPending" in receipt && receipt.followUpPending === true');
  });

  test("routes protected archive, restore, and tier actions through custody", () => {
    expect(source).toContain("await memoryReads.archive(id)");
    expect(source).toContain("operations.transitionTier(initial.id, action)");
    expect(source).toContain("operations.restore(initial.id)");
    expect(facade).toContain("protectedMutationPort(input.protected).archive");
  });

  test("routes protected access and detach actions without claiming hard deletion", () => {
    expect(source).toContain("operations.grantUser(initial.id, handle)");
    expect(source).toContain("operations.revokeUser(initial.id, userHandle)");
    expect(source).toContain("memoryReads.revokeUser(id, personFilter)");
    expect(source).toContain("operations.makePrivate(initial.id)");
    expect(source).toContain("operations.delete(initial.id)");
    expect(source).toContain("Remove from my library…");
    expect(facade).toContain(
      "Removing from your library does not delete other authorized views.",
    );
  });
});
