import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL(
    "../../src/server/message/postgres-domain-key-v2-live-shadow-authority.ts",
    import.meta.url,
  ),
  "utf8",
);

describe("V2 live-Shadow room authority lifetime", () => {
  test("binds current policy mode to the plan's trusted execution representation", () => {
    expect(source).toContain(
      'representationMode: "shadow_encryption" | "full_encryption"',
    );
    expect(source).toContain('input.representationMode === "full_encryption"');
    expect(source).toContain('? "encrypted_only"');
    expect(source).toContain(': "shadow_encryption"');
    expect(source).toContain(
      'number(row, "policy_revision") !== input.plan.policyRevision',
    );
    expect(source).not.toContain('text(row, "mode") !== "shadow_encryption"');
  });

  test("keeps copied room authority alive until the asynchronous bundle open settles", () => {
    expect(source).toContain(
      "return await repository.withOpenedForegroundNamespaceKey({",
    );
    expect(source).toContain("destroyRoom(current.room);");
  });

  test("re-resolves and revalidates the exact readable Namespace set on every Grant use", () => {
    expect(source).toContain("const load = async (): Promise<Current | null> => {");
    expect(source).toContain(
      "readable = canonicalNamespaces(await input.resolveReadableNamespaces({",
    );
    expect(source).toContain("withCurrentReadableNamespaceSet({");
    expect(source).toContain("namespaceIds: readable,");
    expect(source).toContain("repository.inspectForegroundAuthority({");
    expect(source).toContain(
      "left.activeNamespaceBindingCount === right.activeNamespaceBindingCount",
    );
    expect(source).toContain(
      "left.activeNamespaceBindingSetDigest,\n      right.activeNamespaceBindingSetDigest,",
    );
    expect(source).toContain(
      "&& sameDomain(entry, inspected.domains.domains[index])",
    );
    expect(source).toContain('return reject("foreground_authorization_stale");');

    const verificationStart = source.indexOf("verifyCurrentPlan: async () => {");
    expect(verificationStart).toBeGreaterThan(-1);
    expect(source.slice(verificationStart, verificationStart + 180))
      .toContain("const current = await load();");
  });
});
