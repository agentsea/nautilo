import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  REVIEWED_MAIN_2026_09_17_SOURCE_ALARMS,
  SUPERSEDED_MAIN_2026_09_17_SOURCE_ALARM_LOCATORS,
} from "../../baseline/reviewed-main-2026-09-17-source-alarms";
import { REVIEWED_MAIN_2026_09_09_PLATFORM_SOURCE_ALARMS } from
  "../../baseline/reviewed-main-2026-09-09-platform-source-alarms";
import {
  CURRENT_SOURCE_ALARM_REVIEWS,
  inspectSourceAlarmReviews,
} from "../../src/node/source-alarm-review";
import {
  scanSourceAlarms,
  SOURCE_DECLARATIONS,
} from "../../src/node/source-inventory";

const repositoryRoot = resolve(import.meta.dir, "../../../..");
const sourceScan = scanSourceAlarms({ repoRoot: repositoryRoot });

describe("current-main 2026-09-17 source alarm review", () => {
  test("reconciles the exact 41 new and 15 stale locators without new alarm debt", async () => {
    const scan = await sourceScan;
    const inspection = inspectSourceAlarmReviews(scan.alarms);

    expect(scan.errors).toEqual([]);
    expect(inspection.errors).toEqual([]);
    expect(REVIEWED_MAIN_2026_09_17_SOURCE_ALARMS).toHaveLength(41);
    expect(SUPERSEDED_MAIN_2026_09_17_SOURCE_ALARM_LOCATORS.size).toBe(15);
    expect(REVIEWED_MAIN_2026_09_17_SOURCE_ALARMS.filter((review) =>
      review.closure === "baseline_debt"
    )).toEqual([]);
    expect(new Set(REVIEWED_MAIN_2026_09_17_SOURCE_ALARMS.map((review) =>
      review.locator
    )).size).toBe(41);

    for (const review of REVIEWED_MAIN_2026_09_17_SOURCE_ALARMS) {
      expect(CURRENT_SOURCE_ALARM_REVIEWS).toContainEqual(review);
      expect(scan.alarms.some((alarm) => alarm.locator === review.locator))
        .toBe(true);
    }
    for (const locator of SUPERSEDED_MAIN_2026_09_17_SOURCE_ALARM_LOCATORS) {
      expect(CURRENT_SOURCE_ALARM_REVIEWS.some((review) =>
        review.locator === locator
      )).toBe(false);
      expect(scan.alarms.some((alarm) => alarm.locator === locator)).toBe(false);
    }
  });

  test("keeps content-bearing file and subprocess calls explicit", () => {
    const declarations = REVIEWED_MAIN_2026_09_17_SOURCE_ALARMS.filter(
      (review) => review.closure === "declaration",
    );
    expect(declarations.map((review) => review.locator)).toEqual([
      "apps/desktop/electron/sequence-export-host.ts#subprocess_processor:1a362bfafa05b5d7:1",
      "bin/nautilo-dev/src/commands/restore.ts#subprocess_processor:c8fc3c3c55eefdd5:1",
      "deploy/compose-driver/src/artifact-relocation-backup.ts#subprocess_processor:a1bfc61b41ebbc7e:1",
    ]);
    expect(declarations.every((review) =>
      /explicit|existing/u.test(review.reason)
      && /plaintext|ordinary operator file/u.test(review.reason)
    )).toBe(true);
    expect(REVIEWED_MAIN_2026_09_17_SOURCE_ALARMS.filter((review) =>
      review.closure === "reviewed_exclusion"
    )).toHaveLength(38);

    const semanticIds = new Set(SOURCE_DECLARATIONS.map((entry) => entry.id));
    expect(declarations.slice(1).map((review) =>
      review.closure === "declaration" ? review.declarationId : ""
    )).toEqual(["source.backup.dev-snapshot", "source.backup.compose-bundle"]);
    expect(declarations.slice(1).every((review) =>
      review.closure === "declaration"
      && semanticIds.has(review.declarationId)
    )).toBe(true);

    const previousSequence = REVIEWED_MAIN_2026_09_09_PLATFORM_SOURCE_ALARMS
      .find((review) => review.locator ===
        "apps/desktop/electron/sequence-export-host.ts#subprocess_processor:a536c8590ec41360:1");
    expect(previousSequence?.closure).toBe("declaration");
    expect(declarations[0]?.closure === "declaration"
      ? declarations[0].declarationId
      : "").toBe(previousSequence?.closure === "declaration"
        ? previousSequence.declarationId
        : "missing");
  });

  test("pins the reviewed producer boundaries behind the classifications", async () => {
    const [
      plan,
      sequence,
      restore,
      backup,
      protection,
      preferences,
      board,
      disposableReset,
    ] =
      await Promise.all([
        readFile(resolve(repositoryRoot, "apps/cli/src/commands/artifacts-relocate.ts"), "utf8"),
        readFile(resolve(repositoryRoot, "apps/desktop/electron/sequence-export-host.ts"), "utf8"),
        readFile(resolve(repositoryRoot, "bin/nautilo-dev/src/commands/restore.ts"), "utf8"),
        readFile(resolve(repositoryRoot, "deploy/compose-driver/src/artifact-relocation-backup.ts"), "utf8"),
        readFile(resolve(repositoryRoot, "bin/nautilo-dev/src/lib/protected-durable-instance.ts"), "utf8"),
        readFile(resolve(repositoryRoot, "packages/server/src/routes/event-feed-preferences.ts"), "utf8"),
        readFile(resolve(repositoryRoot, "packages/first-party-apps/board/scripts/capture-preview.ts"), "utf8"),
        readFile(resolve(repositoryRoot, "packages/lattice-bridge/scripts/disposable-postgres-reset.ts"), "utf8"),
      ]);

    expect(plan).toContain("constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600");
    expect(plan).toContain("file.writeFile(JSON.stringify(plan, null, 2)");
    expect(sequence).toContain("execFile(ffmpegPath");
    expect(sequence).toContain('"-i", sourcePath');
    expect(restore).toContain('"--exclude=.protected-instance", "--exclude=profiles"');
    expect(backup).toContain('spawn("tar", args');
    expect(backup).toContain("hash.update(chunk)");
    expect(protection).toContain('writeFileSync(markerPath, "protected-by=operator\\n"');
    expect(preferences.match(/warn\("\[event-feed\] preference [^"]+"\)/gu))
      .toHaveLength(3);
    expect(preferences).not.toContain("warn(error");
    expect(board).toContain("no account, instance, or persisted user data");
    expect(disposableReset).toContain('spawnSync("docker", [...args]');
    expect(disposableReset.match(/dockerOutput\(\[/gu)).toHaveLength(4);
    expect(disposableReset).toContain(
      'container?.startsWith("nautilo-lattice-bridge-test-")',
    );
    expect(disposableReset).toContain('/^[0-9a-f]{64}$/.test(token)');
    expect(disposableReset).toContain('/^[0-9]+$/.test(port)');
    expect(disposableReset).toContain('url.hostname !== "127.0.0.1"');
    expect(disposableReset).toContain('url.pathname !== "/nautilo"');
    expect(disposableReset).toContain("label !== authority.token");
    expect(disposableReset).toContain('running !== "true"');
    expect(disposableReset).toContain("mapping.endsWith(`:${authority.port}`)");
    expect(disposableReset).toContain("DROP DATABASE nautilo WITH (FORCE)");
    expect(disposableReset).toContain(
      "WITH TEMPLATE ${DISPOSABLE_TEMPLATE_DATABASE} OWNER nautilo",
    );
    expect(disposableReset).not.toMatch(
      /DISABLE\s+TRIGGER|session_replication_role/iu,
    );
    expect(disposableReset).not.toContain("result.stderr");
  });

  test("fails closed when a replacement is omitted or a retired locator returns", async () => {
    const scan = await sourceScan;
    const replacement = REVIEWED_MAIN_2026_09_17_SOURCE_ALARMS[0]!;
    const withoutReplacement = CURRENT_SOURCE_ALARM_REVIEWS.filter((review) =>
      review.locator !== replacement.locator
    );
    expect(inspectSourceAlarmReviews(scan.alarms, withoutReplacement).errors)
      .toContain(`new source alarm has no closure: ${replacement.locator}`);

    const retiredLocator =
      "apps/desktop/electron/sequence-export-host.ts#subprocess_processor:a536c8590ec41360:1";
    const retiredReview = REVIEWED_MAIN_2026_09_09_PLATFORM_SOURCE_ALARMS.find(
      (review) => review.locator === retiredLocator,
    );
    expect(retiredReview).toBeDefined();
    expect(inspectSourceAlarmReviews(
      scan.alarms,
      [...CURRENT_SOURCE_ALARM_REVIEWS, retiredReview!],
    ).errors).toContain(`stale source alarm review: ${retiredLocator}`);
  });
});
