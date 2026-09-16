import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ReviewedLimitDecision } from "../../src/model";
import { checkRegistry, legacyLockFor, renderMatrix } from "../../src/node/registry";
import { scanRepository } from "../../src/node/scanner";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function scan(source: string) {
  const root = await mkdtemp(join(tmpdir(), "limit-gate-"));
  roots.push(root);
  const path = join(root, "packages/example/src/result.ts");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, source, "utf8");
  return scanRepository(root, { sourceRoots: ["packages"] });
}

describe("limit drift gate", () => {
  test("baseline regeneration cannot approve a new semantic crop", async () => {
    const current = await scan("export const result = input.slice(0, 1024);\n");
    expect(current).toHaveLength(1);
    const beforeRegeneration = checkRegistry({
      current,
      committedInventory: [],
      decisions: [],
      legacy: [],
      legacyLock: legacyLockFor([]),
    });
    expect(beforeRegeneration.errors.join("\n")).toContain("NEW observation");

    const afterRegeneration = checkRegistry({
      current,
      committedInventory: current,
      decisions: [],
      legacy: [],
      legacyLock: legacyLockFor([]),
    });
    expect(afterRegeneration.ok).toBe(false);
    expect(afterRegeneration.errors.join("\n")).toContain("legacy debt cannot grow");
  });

  test("an evidence-backed decision passes and a changed boundary invalidates it", async () => {
    const current = await scan("export const result = input.slice(0, 1024);\n");
    const observation = current[0]!;
    const decision: ReviewedLimitDecision = {
      locator: observation.locator,
      fingerprint: observation.fingerprint,
      classification: "arbitrary",
      disposition: "remove",
      authority: "No protocol, provider, caller, or measured environment owns the crop.",
      owner: observation.owner,
      lossAndCompleteness: "The expression drops all content after byte 1024.",
      visibility: "The caller currently receives a complete-looking partial value.",
      continuationOrRecovery: "The implementation removes the semantic crop and retains only lossless transport framing.",
      evidence: ["packages/example/tests/result.test.ts"],
      rationale: "A local round number cannot own reusable result semantics.",
    };
    expect(checkRegistry({
      current,
      committedInventory: current,
      decisions: [decision],
      legacy: [],
      legacyLock: legacyLockFor([]),
    }).ok).toBe(true);

    const changed = await scan("export const result = input.slice(0, 2048);\n");
    const result = checkRegistry({
      current: changed,
      committedInventory: current,
      decisions: [decision],
      legacy: [],
      legacyLock: legacyLockFor([]),
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("STALE decision");
  });

  test("legacy debt cannot be copied, deleted silently, duplicated, or widened", async () => {
    const [observation] = await scan("export const result = input.slice(0, 1024);\n");
    expect(observation).toBeDefined();
    const debt = {
      locator: observation!.locator,
      fingerprint: observation!.fingerprint,
      owner: observation!.owner,
      mechanicalPriority: observation!.mechanicalPriority,
    } as const;
    const copied = {
      ...observation!,
      locator: observation!.locator.replace("result.ts", "copied.ts"),
      path: observation!.path.replace("result.ts", "copied.ts"),
    };

    const copiedResult = checkRegistry({
      current: [observation!, copied],
      committedInventory: [observation!, copied],
      decisions: [],
      legacy: [debt],
      legacyLock: legacyLockFor([debt]),
    });
    expect(copiedResult.errors.join("\n")).toContain(`UNREVIEWED observation ${copied.locator}`);

    const deletedResult = checkRegistry({
      current: [],
      committedInventory: [observation!],
      decisions: [],
      legacy: [debt],
      legacyLock: legacyLockFor([debt]),
    });
    expect(deletedResult.errors.join("\n")).toContain(`REMOVED observation ${observation!.locator}`);
    expect(deletedResult.errors.join("\n")).toContain(`STALE legacy debt ${observation!.locator}`);

    const duplicateResult = checkRegistry({
      current: [observation!, observation!],
      committedInventory: [observation!],
      decisions: [],
      legacy: [debt],
      legacyLock: legacyLockFor([debt]),
    });
    expect(duplicateResult.errors.join("\n")).toContain(`current inventory contains duplicate locator ${observation!.locator}`);

    const widened = { ...observation!, fingerprint: "widened-boundary" };
    const widenedResult = checkRegistry({
      current: [widened],
      committedInventory: [observation!],
      decisions: [],
      legacy: [debt],
      legacyLock: legacyLockFor([debt]),
    });
    expect(widenedResult.errors.join("\n")).toContain("legacy debt cannot absorb changed limits");
    expect(renderMatrix({ observations: [observation!], decisions: [], legacy: [debt] }))
      .toBe(renderMatrix({ observations: [observation!], decisions: [], legacy: [debt] }));
  });
});
