import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { REVIEWED_DRAFT_RECOVERY_COVERAGE } from "../../baseline/reviewed-main-2026-09-12-draft-recovery";
import { SOURCE_DECLARATIONS, inspectDeclaredSourceInventory } from "../../src/node/source-inventory";

const repoRoot = resolve(import.meta.dir, "../../../..");

describe("Desktop draft recovery coverage", () => {
  test("registers OS-account ciphertext custody without claiming namespace protection", async () => {
    const entries = REVIEWED_DRAFT_RECOVERY_COVERAGE;
    expect(entries).toHaveLength(1);
    expect(entries[0]!.classification).toBe("device_local");
    const declarations = SOURCE_DECLARATIONS.filter((entry) =>
      entry.id === "source.file.desktop-mini-app-draft-recovery"
    );
    expect(declarations).toHaveLength(1);
    expect(declarations[0]!.locator).toBe(entries[0]!.locator);
    const inspection = await inspectDeclaredSourceInventory({ repoRoot, declarations });
    expect(inspection.errors).toEqual([]);

    const source = await readFile(resolve(repoRoot,
      "apps/desktop/electron/mini-app-draft-recovery.ts"), "utf8");
    expect(source).toContain('safeStorage.getSelectedStorageBackend?.() !== "basic_text"');
    expect(source).toContain("safeStorage.isEncryptionAvailable()");
    expect(source).toContain("this.options.safeStorage.encryptString(JSON.stringify(envelope))");
    expect(source).toContain("Buffer.concat([HEADER, encrypted])");
    expect(source).toContain("await this.#requireAuthorized(isAuthorized)");
    expect(source).toContain("const DIR_MODE = 0o700");
    expect(source).toContain("const FILE_MODE = 0o600");

    // The behavioral suite exercises the production store with an injected
    // safeStorage contract; this observer test does not claim a live OS-keychain test.
    const behavior = await readFile(resolve(repoRoot,
      "apps/desktop/tests/unit/mini-app-draft-recovery.test.ts"), "utf8");
    expect(behavior).toContain("not.toContain(draft.content)");
    expect(behavior).toContain("basic_text");
    expect(behavior).toContain("tombstone");
  });
});
