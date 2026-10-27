import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { SOURCE_ALARM_BASELINE_REVIEWS } from "../../baseline/source-alarm-reviews";
import { REVIEWED_WAVE_4_SOURCE_ALARMS } from "../../baseline/reviewed-wave-4-source-alarms";
import { REVIEWED_MAIN_2026_08_11_SOURCE_ALARMS } from "../../baseline/reviewed-main-2026-08-11-source-alarms";
import { REVIEWED_MAIN_2026_08_21_SOURCE_ALARMS } from "../../baseline/reviewed-main-2026-08-21-source-alarms";
import { REVIEWED_MAIN_2026_08_29_SOURCE_ALARMS } from "../../baseline/reviewed-main-2026-08-29-source-alarms";
import { REVIEWED_MAIN_2026_09_09_PLATFORM_SOURCE_ALARMS } from "../../baseline/reviewed-main-2026-09-09-platform-source-alarms";
import {
  REVIEWED_MAIN_2026_10_13_SOURCE_ALARMS,
  SUPERSEDED_MAIN_2026_10_13_SOURCE_ALARM_LOCATORS,
} from "../../baseline/reviewed-main-2026-10-13-source-alarms";
import { SUPERSEDED_RELEASE_RECONCILIATION_SOURCE_ALARM_LOCATORS } from
  "../../baseline/reviewed-release-reconciliation-source-alarms";
import { SUPERSEDED_CI_SOURCE_RECONCILIATION_LOCATORS } from
  "../../baseline/reviewed-ci-source-reconciliation";
import { CURRENT_SOURCE_ALARM_REVIEWS, inspectSourceAlarmReviews, sourceAlarmDebtId } from "../../src/node/source-alarm-review";
import { scanSourceAlarms } from "../../src/node/source-inventory";

const repoRoot = resolve(import.meta.dir, "../../../..");

describe("current-main October 13 source alarm review", () => {
  test("retires the exact 45 historical reviews and installs only live replacements", async () => {
    expect(SUPERSEDED_MAIN_2026_10_13_SOURCE_ALARM_LOCATORS.size).toBe(45);
    const predecessors = new Set([
      ...SOURCE_ALARM_BASELINE_REVIEWS,
      ...REVIEWED_WAVE_4_SOURCE_ALARMS,
      ...REVIEWED_MAIN_2026_08_11_SOURCE_ALARMS,
      ...REVIEWED_MAIN_2026_08_21_SOURCE_ALARMS,
      ...REVIEWED_MAIN_2026_08_29_SOURCE_ALARMS,
      ...REVIEWED_MAIN_2026_09_09_PLATFORM_SOURCE_ALARMS,
    ].map((entry) => entry.locator));
    for (const locator of SUPERSEDED_MAIN_2026_10_13_SOURCE_ALARM_LOCATORS) {
      expect(predecessors.has(locator)).toBe(true);
      expect(CURRENT_SOURCE_ALARM_REVIEWS.some((entry) =>
        entry.locator === locator
      )).toBe(false);
    }

    const scan = await scanSourceAlarms({ repoRoot });
    expect(scan.errors).toEqual([]);
    const live = new Set(scan.alarms.map((entry) => entry.locator));
    const reviewed = inspectSourceAlarmReviews(scan.alarms);
    expect(reviewed.errors).toEqual([]);
    expect(reviewed.counts.unmapped).toBe(0);
    expect(reviewed.reviews).toHaveLength(scan.alarms.length);
    // The scanner hashes single-line and multiline calls differently. Ground
    // the classification in the actual expression, not a neighboring ordinal.
    const invocationPath = "packages/agent/src/utils/chat-model-invocation.ts";
    const invocationLines = (await readFile(resolve(repoRoot, invocationPath), "utf8")).split("\n");
    for (const [suffix, expression, closure] of [
      ["7ef703451e44cded:13", '${personalFunding ? "Personal-funded model" : "Model"} ${currentModelId} failed (${classified.category}', "reviewed_exclusion"],
      ["7ef703451e44cded:14", "Falling back from ${currentModelId} to ${nextModelId}", "declaration"],
      ["0ae25e725db4e950:2", "providerError instanceof Error ? providerError.message : String(providerError)", "baseline_debt"],
      ["0ae25e725db4e950:3", "formatProviderError(providerError)", "baseline_debt"],
    ] as const) {
      const locator = `${invocationPath}#log_emitter:${suffix}`;
      const alarm = scan.alarms.find(entry => entry.locator === locator);
      expect(alarm).toBeDefined();
      const call = invocationLines.slice(alarm!.line - 1, alarm!.line + 2).join("\n");
      expect(call).toContain(expression);
      expect(reviewed.reviews.find(entry => entry.locator === locator)?.closure).toBe(closure);
    }

    for (const locator of SUPERSEDED_MAIN_2026_10_13_SOURCE_ALARM_LOCATORS) {
      expect(live.has(locator)).toBe(false);
    }
    expect(REVIEWED_MAIN_2026_10_13_SOURCE_ALARMS).toHaveLength(112);
    const replacements = new Map(REVIEWED_MAIN_2026_10_13_SOURCE_ALARMS.map((entry) =>
      [entry.locator, entry]
    ));
    const privateFile = replacements.get(
      "packages/agent/src/tools/file/file-tool.ts#log_emitter:4425a3d2e53035a0:1",
    );
    expect(privateFile).toMatchObject({
      closure: "baseline_debt",
      debtId: "debt.source-alarm.log.log_emitter.6ad3e2027b13ec60",
      releaseImpact: "blocks_whole_product_claim",
    });
    expect(privateFile?.reason).toContain("ordinary path");
    expect(privateFile?.reason).toContain("suppressed");
    const repoDocs = replacements.get(
      "packages/agent/src/tools/tasks/shortcuts/generate-repo-docs.ts#log_emitter:727a543dc5bffada:1",
    );
    expect(repoDocs).toMatchObject({
      closure: "baseline_debt",
      debtId: "debt.source-alarm.log.log_emitter.b1e0959f41ad4a8a",
      releaseImpact: "blocks_whole_product_claim",
    });
    expect(repoDocs?.reason).toContain("protected Task path");
    for (const locator of replacements.keys()) {
      expect(
        live.has(locator)
        || SUPERSEDED_RELEASE_RECONCILIATION_SOURCE_ALARM_LOCATORS.has(locator)
        || SUPERSEDED_CI_SOURCE_RECONCILIATION_LOCATORS.has(locator)
      ).toBe(true);
    }
  }, 120_000);

  test("keeps raw errors, provider speech/model bodies and repository bytes as exact debt", () => {
    const debt = REVIEWED_MAIN_2026_10_13_SOURCE_ALARMS.filter(entry => entry.closure === "baseline_debt");
    expect(debt).toHaveLength(23);
    for (const entry of debt) {
      expect(entry.debtId).toBe(sourceAlarmDebtId(entry.locator, entry.surface));
      expect(entry.reason).toContain(entry.locator);
      expect(entry.evidenceGap).toContain(entry.locator);
      expect(entry.releaseImpact).toBe("blocks_whole_product_claim");
      expect(entry.owner).toBe(entry.locator.split("/").slice(0, 2).join("/"));
    }
    for (const locator of [
      "packages/agent/src/providers/factory.ts#network_processor:e40f915063052bb5:1",
      "packages/agent/src/providers/surplus-transport.ts#network_processor:06a0f2ea2c601400:1",
      "packages/agent/src/tools/utilities/read-webpage.ts#log_emitter:89b81c36ea23316a:4",
      "packages/agent/src/usage/provider-cost-recorder.ts#log_emitter:89b81c36ea23316a:2",
      "apps/desktop/electron/github-broker/git-transport.ts#filesystem_write:ee2f23a152ca7d93:1",
      "packages/server/src/realtime/tts-service.ts#network_processor:883e8969131a2650:1",
      "packages/server/src/routes/voices.ts#network_processor:e13447c78a55d6f5:1",
      "packages/server/src/routes/rooms.ts#log_emitter:a1436e7c26c240df:12",
    ]) expect(debt.some(entry => entry.locator === locator)).toBe(true);
  });

  test("declarations have concrete bounded producers, not inferred Message crypto", async () => {
    const cases = [
      ["apps/desktop/electron/local-execution-history.ts", "this.protectedStorage();", "this.options.storage.encryptString(JSON.stringify(captured))"],
      ["apps/desktop/electron/ready-to-work-protected-receipt.ts", "this.options.safeStorage.encryptString(JSON.stringify(envelope))", "Buffer.concat([REMEMBERED_HEADER, encrypted])"],
      ["apps/desktop/electron/companion-window.ts", "bubbleAppearance: bound.state.bubbleAppearance", "bounds: bound.window.getBounds()"],
      ["apps/desktop/scripts/vendor-github-cli.ts", "githubCliDigest(bytes) !== expected", 'join(root, "manifest.json")'],
      ["packages/server/src/realtime/tts-service.ts", "this.deps.observe({ streamId: turn.streamId, stage, elapsedMs:", "audioBytes: turn.audioBytes"],
      ["packages/server/src/routes/moderation.ts", 'routes.log.error("Moderation request failed")', 'send({ error: "moderation_unavailable" })'],
      ["packages/server/src/lib/personal-provider-validation.ts", 'method: "GET"', 'redirect: "error"'],
      ["packages/agent/src/tools/utilities/read-webpage.ts", "if (options.confidential === true)", 'warn("[read_webpage] provider request failed")'],
      ["packages/operator-secrets/src/personal-provider-custody-file.ts", "publishPrivateFileAtomically(path", "serializePersonalProviderCustody(custody)"],
    ] as const;
    for (const [path, ...evidence] of cases) {
      const source = await readFile(resolve(repoRoot, path), "utf8");
      for (const text of evidence) expect(source).toContain(text);
      expect(REVIEWED_MAIN_2026_10_13_SOURCE_ALARMS.some(entry =>
        entry.closure === "declaration" && entry.locator.startsWith(`${path}#`)
      )).toBe(true);
    }
    for (const path of [
      "apps/desktop/electron/github-broker/git-transport.ts",
      "apps/desktop/electron/github-broker/credentials.ts",
    ]) {
      const historical = REVIEWED_MAIN_2026_10_13_SOURCE_ALARMS.filter((entry) =>
        entry.locator.startsWith(`${path}#`)
      );
      expect(historical.length).toBeGreaterThan(0);
      expect(historical.every((entry) =>
        SUPERSEDED_RELEASE_RECONCILIATION_SOURCE_ALARM_LOCATORS.has(entry.locator)
      )).toBe(true);
      expect(CURRENT_SOURCE_ALARM_REVIEWS.some((entry) =>
        entry.locator.startsWith(`${path}#`)
      )).toBe(false);
    }
  });

});
