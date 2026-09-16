import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  MAIN_2026_09_12_ORDINAL_RUN_SOURCE_LOCATORS,
  MAIN_2026_09_12_UNMAPPED_SOURCE_ALARM_LOCATORS,
  RETIRED_MAIN_2026_09_12_SOURCE_ALARM_LOCATORS,
  REVIEWED_MAIN_2026_09_12_SOURCE_ALARMS,
  SUPERSEDED_MAIN_2026_09_12_SOURCE_ALARM_LOCATORS,
} from "../../baseline/reviewed-main-2026-09-12-source-alarms";
import { inspectSourceAlarmReviews } from "../../src/node/source-alarm-review";
import {
  scanSourceAlarms,
  type SourceAlarm,
} from "../../src/node/source-inventory";

const repositoryRoot = resolve(import.meta.dir, "../../../..");
const sourceScan = scanSourceAlarms({ repoRoot: repositoryRoot });

type Run = readonly [path: string, kind: string, signature: string, count: number];

const ordinalRuns: readonly Run[] = [
  ["apps/workbench/src/adapters/nautilo-runtime.tsx", "log_emitter", "c6d53eb0eb42455b", 9],
  ["bin/nautilo-dev/src/commands/dev-stack.ts", "log_emitter", "468c68ed4723a1f2", 10],
  ["bin/nautilo-dev/src/commands/dev-stack.ts", "log_emitter", "6eab313eca52a747", 5],
  ["bin/nautilo-dev/src/commands/dev-stack.ts", "log_emitter", "c467686340f4efc2", 27],
  ["bin/nautilo-dev/src/commands/dev-stack.ts", "log_emitter", "c6d53eb0eb42455b", 15],
  ["bin/nautilo-server/src/index.ts", "log_emitter", "89b81c36ea23316a", 7],
  ["packages/agent/src/tools/invocation-service.ts", "log_emitter", "89b81c36ea23316a", 13],
  ["packages/config-guard/src/setup-toml-migration.ts", "log_emitter", "c467686340f4efc2", 8],
  ["packages/office-docs/scripts/verify-ime-browser.mjs", "log_emitter", "468c68ed4723a1f2", 10],
  ["packages/office-docs/scripts/verify-ime-browser.mjs", "log_emitter", "c467686340f4efc2", 2],
  ["packages/office-docs/scripts/verify-ime-browser.mjs", "log_emitter", "c4f22f3fb6bab4a7", 2],
  ["packages/office-slides/scripts/gen-shape-text-rects.mjs", "log_emitter", "468c68ed4723a1f2", 2],
  ["packages/office-slides/scripts/generate-model-schema.mjs", "log_emitter", "468c68ed4723a1f2", 3],
  ["packages/office-slides/src/view/editor/interactions/keyboard.ts", "log_emitter", "1b166cbf08993886", 2],
  ["packages/office-slides/src/view/editor/interactions/keyboard.ts", "log_emitter", "e40d8ce76a53e94b", 2],
  ["packages/runtime/src/stenographer/ordinary-stenographer-data-operation.ts", "log_emitter", "7100fec63ac40eee", 6],
  ["packages/runtime/src/stenographer/ordinary-stenographer-data-operation.ts", "log_emitter", "db40054dd207df4f", 2],
  ["packages/runtime/src/tasks/resume-task-approval.ts", "log_emitter", "89b81c36ea23316a", 2],
  ["packages/server/src/apps/app-tool-host.ts", "log_emitter", "89b81c36ea23316a", 2],
  ["packages/server/src/reflection/protected-authority-composition.ts", "log_emitter", "41b017e1495b9b88", 3],
  ["packages/server/src/routes/rooms.ts", "log_emitter", "a1436e7c26c240df", 11],
  ["packages/server/src/routes/workspace-artifacts.ts", "log_emitter", "89b81c36ea23316a", 6],
] as const;

function locatorsForRun([path, kind, signature, count]: Run): string[] {
  return Array.from(
    { length: count },
    (_, index) => `${path}#${kind}:${signature}:${index + 1}`,
  );
}

const contentLocators = [
  "apps/desktop/electron/mini-app-draft-recovery.ts#filesystem_write:4bc031be8d6ad2b1:1",
  "apps/desktop/electron/mini-app-draft-recovery.ts#filesystem_write:4dc03b77ebd364d7:1",
  "apps/workbench/src/components/browser-column/apps-panel.tsx#filesystem_write:f3b4ac401ae53efc:1",
  "packages/agent/src/tools/file/atomic-write.ts#filesystem_write:cfc3acd96c1a1e48:1",
  "packages/agent/src/tools/file/atomic-write.ts#filesystem_write:4d8e0a93dfa6dec5:1",
  "packages/agent/src/tools/file/workspace-binary-artifact.ts#filesystem_write:137c83a01103bf0e:1",
  "packages/server/src/lib/slide-template-service.ts#filesystem_write:379f023cfe42faf3:1",
  "packages/server/src/lib/slide-template-service.ts#filesystem_write:a8e48bc462634843:1",
  "packages/office-docs/src/export/pdf-fonts.ts#network_processor:596abf2787d03931:1",
] as const;

const stenographerCallbackLocators = [
  "packages/runtime/src/stenographer/ordinary-stenographer-data-operation.ts#log_emitter:6a450c440341d85b:1",
  "packages/runtime/src/stenographer/ordinary-stenographer-data-operation.ts#log_emitter:808faa524bf2b947:1",
  "packages/runtime/src/stenographer/ordinary-stenographer-data-operation.ts#log_emitter:c4c1a9cb106e92c7:1",
  "packages/runtime/src/stenographer/ordinary-stenographer-data-operation.ts#log_emitter:cbad719ce71c6b05:1",
  "packages/runtime/src/stenographer/worker.ts#log_emitter:0a4bb0710f8dd93b:1",
  "packages/runtime/src/stenographer/worker.ts#log_emitter:4a2b3cc9166e95d2:1",
  "packages/runtime/src/stenographer/worker.ts#log_emitter:7acab573ad5b8d95:1",
  "packages/runtime/src/stenographer/worker.ts#log_emitter:8dd02458440676ae:1",
  "packages/runtime/src/stenographer/worker.ts#log_emitter:c0a5d9b378ca0a91:1",
  "packages/runtime/src/stenographer/worker.ts#log_emitter:d2c051d87939b278:1",
] as const;

const devStackExceptionLocators = [
  "bin/nautilo-dev/src/commands/dev-stack.ts#log_emitter:c6d53eb0eb42455b:2",
  "bin/nautilo-dev/src/commands/dev-stack.ts#log_emitter:c6d53eb0eb42455b:4",
] as const;

const runtimeAcceptanceForwarderLocator =
  "bin/nautilo-dev/src/commands/dev-stack.ts#log_emitter:9a0075a24c1b046c:1";

const otherBoundedLogLocators = [
  "apps/workbench/src/adapters/nautilo-runtime.tsx#log_emitter:c6d53eb0eb42455b:1",
  "apps/workbench/src/adapters/nautilo-runtime.tsx#log_emitter:c6d53eb0eb42455b:4",
  "apps/workbench/src/adapters/nautilo-runtime.tsx#log_emitter:c6d53eb0eb42455b:5",
  "apps/workbench/src/adapters/nautilo-runtime.tsx#log_emitter:c6d53eb0eb42455b:9",
  "packages/agent/src/tools/file/artifact-store.ts#log_emitter:89b81c36ea23316a:1",
  "packages/config-guard/src/env-writer.ts#log_emitter:064983095de744a8:1",
  "packages/runtime/src/tasks/task-run-executor.ts#log_emitter:89b81c36ea23316a:1",
  "packages/server/src/app.ts#log_emitter:9c37cff80e0cfebb:1",
  "packages/server/src/media-generation/production-worker.ts#log_emitter:4838fc5285bf34e1:1",
  "packages/server/src/reflection/protected-authority-composition.ts#log_emitter:41b017e1495b9b88:1",
  "packages/server/src/reflection/protected-authority-composition.ts#log_emitter:41b017e1495b9b88:2",
  "packages/server/src/reflection/protected-authority-composition.ts#log_emitter:41b017e1495b9b88:3",
] as const;

function reviewAt(locator: string) {
  const review = REVIEWED_MAIN_2026_09_12_SOURCE_ALARMS.find((candidate) =>
    candidate.locator === locator
  );
  if (!review) throw new Error(`missing reviewed source alarm: ${locator}`);
  return review;
}

async function source(path: string): Promise<string> {
  return await readFile(resolve(repositoryRoot, path), "utf8");
}

describe("reviewed main 2026-09-12 source-alarm reconciliation", () => {
  test("closes the exact 128 unmapped observations and every shifted ordinal occurrence", async () => {
    const scan = await sourceScan;
    expect(scan.errors).toEqual([]);

    const observedByLocator = new Map(scan.alarms.map((alarm) => [alarm.locator, alarm]));
    const ownedLocators = new Set(REVIEWED_MAIN_2026_09_12_SOURCE_ALARMS.map(
      (review) => review.locator,
    ));
    const ownedAlarms = [...ownedLocators].map((locator) => {
      const alarm = observedByLocator.get(locator);
      if (!alarm) throw new Error(`reviewed current locator is absent: ${locator}`);
      return alarm;
    });

    expect(MAIN_2026_09_12_UNMAPPED_SOURCE_ALARM_LOCATORS.size).toBe(128);
    expect(MAIN_2026_09_12_ORDINAL_RUN_SOURCE_LOCATORS.size).toBe(149);
    expect(REVIEWED_MAIN_2026_09_12_SOURCE_ALARMS).toHaveLength(225);
    expect(inspectSourceAlarmReviews(
      ownedAlarms,
      REVIEWED_MAIN_2026_09_12_SOURCE_ALARMS,
    ).errors).toEqual([]);

    const newReviews = REVIEWED_MAIN_2026_09_12_SOURCE_ALARMS.filter((review) =>
      MAIN_2026_09_12_UNMAPPED_SOURCE_ALARM_LOCATORS.has(review.locator)
    );
    expect(newReviews).toHaveLength(128);
    expect(newReviews.filter((review) => review.closure === "reviewed_exclusion"))
      .toHaveLength(70);
    expect(newReviews.filter((review) => review.closure === "declaration"))
      .toHaveLength(27);
    expect(newReviews.filter((review) => review.closure === "baseline_debt"))
      .toHaveLength(31);
  });

  test("re-reviews complete identical-signature runs and supersedes only exact old locators", async () => {
    const scan = await sourceScan;
    const observed = new Set(scan.alarms.map((alarm) => alarm.locator));
    const expectedOrdinalLocators = new Set(ordinalRuns.flatMap(locatorsForRun));

    expect(expectedOrdinalLocators.size).toBe(149);
    expect(MAIN_2026_09_12_ORDINAL_RUN_SOURCE_LOCATORS)
      .toEqual(expectedOrdinalLocators);
    for (const locator of expectedOrdinalLocators) expect(observed.has(locator)).toBe(true);

    expect(RETIRED_MAIN_2026_09_12_SOURCE_ALARM_LOCATORS.size).toBe(22);
    for (const locator of RETIRED_MAIN_2026_09_12_SOURCE_ALARM_LOCATORS) {
      expect(observed.has(locator)).toBe(false);
    }

    const replacedCurrent = [...SUPERSEDED_MAIN_2026_09_12_SOURCE_ALARM_LOCATORS]
      .filter((locator) => observed.has(locator));
    expect(SUPERSEDED_MAIN_2026_09_12_SOURCE_ALARM_LOCATORS.size).toBe(119);
    expect(replacedCurrent).toHaveLength(97);
    expect(new Set([
      ...RETIRED_MAIN_2026_09_12_SOURCE_ALARM_LOCATORS,
      ...replacedCurrent,
    ])).toEqual(SUPERSEDED_MAIN_2026_09_12_SOURCE_ALARM_LOCATORS);
  });

  test("keeps exact content boundaries explicit without claiming Namespace encryption", async () => {
    expect(contentLocators).toHaveLength(9);
    for (const locator of contentLocators) {
      const review = reviewAt(locator);
      expect(review.closure).toBe("declaration");
      expect(review.reason).toMatch(
        /not .*encrypt|no (?:Namespace-)?encryption claim|encryption status|rather than an encryption claim/,
      );
      expect(review.reason).toMatch(/retention|lifecycle|cache|cleanup/);
    }

    for (const locator of contentLocators.slice(0, 2)) {
      const review = reviewAt(locator);
      expect(review.reason).toContain("source.file.desktop-mini-app-draft-recovery");
      expect(review.reason).toContain("device-local");
      expect(review.reason).toMatch(/(?:not a|no) Namespace-encryption claim/);
    }

    const draftRecovery = await source(
      "apps/desktop/electron/mini-app-draft-recovery.ts",
    );
    expect(draftRecovery).toContain("safeStorage.isEncryptionAvailable()");
    expect(draftRecovery).toContain("!== \"basic_text\"");
    expect(draftRecovery).toContain(
      "this.options.safeStorage.encryptString(JSON.stringify(envelope))",
    );
    expect(draftRecovery).toContain("Buffer.concat([HEADER, encrypted])");
    expect(draftRecovery).toContain("await this.#requireAuthorized(isAuthorized)");

    const slideTemplate = await source(
      "packages/server/src/lib/slide-template-service.ts",
    );
    expect(slideTemplate).toContain("await open(temporary, \"wx\", 0o600)");
    expect(slideTemplate).toContain("await link(temporary, path)");
    expect(slideTemplate).toContain("await rm(temporary, { force: true })");

    for (const path of [
      "packages/db/scripts/finalize-content-access-operations.ts",
      "packages/db/scripts/finalize-event-feed.ts",
    ]) {
      const finalizer = await source(path);
      expect(finalizer).toContain("../src/migrations");
      expect(finalizer).toContain("`${latest.tag}.sql`");
      expect(finalizer).toContain("writeFileSync(path, result)");
    }
  });

  test("bounds concrete Stenographer diagnostics but preserves callback and exception debt", async () => {
    for (const locator of stenographerCallbackLocators) {
      const review = reviewAt(locator);
      expect(review.closure).toBe("baseline_debt");
      if (review.closure !== "baseline_debt") continue;
      expect(review.releaseImpact).toBe("blocks_whole_product_claim");
      expect(review.reason).toContain("unconstrained message");
      expect(review.evidenceGap).toContain("every upstream callback path");
    }

    for (const locator of devStackExceptionLocators) {
      const review = reviewAt(locator);
      expect(review.closure).toBe("baseline_debt");
      if (review.closure !== "baseline_debt") continue;
      expect(review.releaseImpact).toBe("blocks_whole_product_claim");
      expect(review.reason).toContain("error.message or String(error)");
    }
    const devStack = await source("bin/nautilo-dev/src/commands/dev-stack.ts");
    expect(devStack.match(/error instanceof Error \? error\.message : String\(error\)/g))
      .toHaveLength(2);

    const acceptanceForwarder = reviewAt(runtimeAcceptanceForwarderLocator);
    expect(acceptanceForwarder.closure).toBe("baseline_debt");
    if (acceptanceForwarder.closure === "baseline_debt") {
      expect(acceptanceForwarder.releaseImpact).toBe("blocks_whole_product_claim");
      expect(acceptanceForwarder.reason).toContain("probe stderr");
      expect(acceptanceForwarder.reason).toContain("arbitrary exception messages");
    }
    expect(MAIN_2026_09_12_UNMAPPED_SOURCE_ALARM_LOCATORS.has(
      runtimeAcceptanceForwarderLocator,
    )).toBe(false);
    expect(SUPERSEDED_MAIN_2026_09_12_SOURCE_ALARM_LOCATORS.has(
      runtimeAcceptanceForwarderLocator,
    )).toBe(true);
    expect(devStack).toContain(
      "if (!merged.asJson) console.log(`[dev-stack] ${message}`)",
    );
    const runtimeAcceptance = await source("bin/nautilo-dev/src/lib/verify.ts");
    expect(runtimeAcceptance).toContain(
      "logger(`  ✗ [${c.id}] ${c.title}: ${c.detail}`)",
    );
    const acceptance = await source(
      "packages/db/src/restore-acceptance/acceptance.ts",
    );
    expect(acceptance).toContain("${probeRes.stderr.trim()}");
    expect(acceptance).toContain("${errorMessage(err)}");

    const ordinary = await source(
      "packages/runtime/src/stenographer/ordinary-stenographer-data-operation.ts",
    );
    expect(ordinary).toContain(
      "info: (message: string, fields?: Record<string, unknown>) => log(message, fields)",
    );
    expect(ordinary).toContain("failureDetail: publicationFailureDetail(error)");
    expect(ordinary).toContain("failureOrigin: publicationFailureOrigin(error)");
    expect(ordinary).toContain("databaseCode: publicationDatabaseCode(error)");

    for (const locator of otherBoundedLogLocators) {
      expect(reviewAt(locator).closure).toBe("declaration");
    }
    const workbench = await source("apps/workbench/src/adapters/nautilo-runtime.tsx");
    expect(workbench.match(
      /error instanceof Error \? error\.name : typeof error/g,
    )).toHaveLength(4);
    expect(await source("packages/agent/src/tools/file/artifact-store.ts"))
      .toContain("warn(\"[artifact-store] artifact creation observer failed after commit\")");
    expect(await source("packages/config-guard/src/env-writer.ts"))
      .toContain("logWarn(\"[config-guard] Environment reload listener failed\")");
    expect(await source("packages/runtime/src/tasks/task-run-executor.ts"))
      .toContain("task=${taskId} run=${taskRunId}");
    expect(await source("packages/server/src/app.ts"))
      .toContain("warn: ({ operation, code }) => warn(`[event-feed] ${operation}: ${code}`)");
    expect(await source("packages/server/src/media-generation/production-worker.ts"))
      .toContain("warn(\"[media-generation] creation feed origin unavailable\")");
    expect((await source(
      "packages/server/src/reflection/protected-authority-composition.ts",
    )).match(/failureClass: classifyDataOperationFailure\(error\)/g))
      .toHaveLength(8);

    const debt = REVIEWED_MAIN_2026_09_12_SOURCE_ALARMS.filter((review) =>
      review.closure === "baseline_debt"
    );
    expect(debt).toHaveLength(81);
    for (const review of debt) {
      if (review.closure !== "baseline_debt") continue;
      expect(review.surface).toBe("log");
      expect(review.releaseImpact).toBe("blocks_whole_product_claim");
      expect(review.reason).toContain("not classified as content-free or encrypted");
    }
  });

  test("fails closed when one unknown current call is added", async () => {
    const scan = await sourceScan;
    const reviewed = new Set(REVIEWED_MAIN_2026_09_12_SOURCE_ALARMS.map(
      (review) => review.locator,
    ));
    const ownedAlarms = scan.alarms.filter((alarm) => reviewed.has(alarm.locator));
    const future = {
      kind: "log_emitter",
      path: "packages/server/src/future-source.ts",
      line: 1,
      locator: "packages/server/src/future-source.ts#log_emitter:0123456789abcdef:1",
      evidence: "warn(",
    } satisfies SourceAlarm;

    expect(inspectSourceAlarmReviews(
      [...ownedAlarms, future],
      REVIEWED_MAIN_2026_09_12_SOURCE_ALARMS,
    ).errors).toContain(`new source alarm has no closure: ${future.locator}`);
  });
});
