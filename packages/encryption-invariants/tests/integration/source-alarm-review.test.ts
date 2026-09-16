import { REVIEWED_REFLECTION_REPLAY_SOURCE_ALARMS } from "../../baseline/reviewed-main-2026-09-12-reflection";
import { REVIEWED_M314_SOURCE_ALARMS } from "../../baseline/reviewed-m314-source-alarms";
import {
  REVIEWED_MAIN_2026_09_12_SOURCE_ALARMS,
  SUPERSEDED_MAIN_2026_09_12_SOURCE_ALARM_LOCATORS,
} from "../../baseline/reviewed-main-2026-09-12-source-alarms";
import { REVIEWED_D581_SOURCE_ALARMS } from "../../baseline/reviewed-d581-research-continuity";
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { SOURCE_ALARM_BASELINE_REVIEWS } from "../../baseline/source-alarm-reviews";
import { isRetiredM306AuthorityLocator } from
  "../../baseline/retired-m306-authority";
import {
  REVIEWED_WAVE_4_SOURCE_ALARMS,
  SUPERSEDED_WAVE_0_SOURCE_ALARM_LOCATORS,
} from "../../baseline/reviewed-wave-4-source-alarms";
import {
  REVIEWED_WAVE_6_SOURCE_ALARMS,
} from "../../baseline/reviewed-wave-6-source-alarms";
import {
  REVIEWED_WAVE_7_SOURCE_ALARMS,
} from "../../baseline/reviewed-wave-7-source-alarms";
import {
  REVIEWED_WAVE_9_SOURCE_ALARMS,
} from "../../baseline/reviewed-wave-9-source-alarms";
import {
  REVIEWED_WAVE_10_SOURCE_ALARMS,
} from "../../baseline/reviewed-wave-10-source-alarms";
import {
  REVIEWED_WAVE_11_SOURCE_ALARMS,
} from "../../baseline/reviewed-wave-11-source-alarms";
import {
  REVIEWED_WAVE_12_SOURCE_ALARMS,
  SUPERSEDED_WAVE_12_SOURCE_ALARM_LOCATORS,
} from "../../baseline/reviewed-wave-12-source-alarms";
import {
  REVIEWED_WAVE_14_SOURCE_ALARMS,
} from "../../baseline/reviewed-wave-14-source-alarms";
import {
  REVIEWED_MAIN_2026_08_03_SOURCE_ALARMS,
  SUPERSEDED_MAIN_2026_08_03_SOURCE_ALARM_LOCATORS,
} from "../../baseline/reviewed-main-2026-08-03-source-alarms";
import {
  REVIEWED_MAIN_2026_08_04_SOURCE_ALARMS,
  SUPERSEDED_MAIN_2026_08_04_SOURCE_ALARM_LOCATORS,
} from "../../baseline/reviewed-main-2026-08-04-source-alarms";
import {
  REVIEWED_MAIN_2026_08_11_SOURCE_ALARMS,
  SUPERSEDED_MAIN_2026_08_11_SOURCE_ALARM_LOCATORS,
} from "../../baseline/reviewed-main-2026-08-11-source-alarms";
import {
  REVIEWED_MAIN_2026_08_12_SOURCE_ALARMS,
  SUPERSEDED_MAIN_2026_08_12_SOURCE_ALARM_LOCATORS,
} from "../../baseline/reviewed-main-2026-08-12-source-alarms";
import {
  REVIEWED_MAIN_2026_08_13_SOURCE_ALARMS,
  SUPERSEDED_MAIN_2026_08_13_SOURCE_ALARM_LOCATORS,
} from "../../baseline/reviewed-main-2026-08-13-source-alarms";
import {
  REVIEWED_MAIN_2026_08_13_MERGED_SOURCE_ALARMS,
} from "../../baseline/reviewed-main-2026-08-13-merged-source-alarms";
import {
  REVIEWED_MAIN_2026_08_13_LATE_MERGE_SOURCE_ALARMS,
} from "../../baseline/reviewed-main-2026-08-13-late-merge-source-alarms";
import {
  REVIEWED_MAIN_2026_08_14_SOURCE_ALARMS,
  SUPERSEDED_MAIN_2026_08_14_SOURCE_ALARM_LOCATORS,
} from "../../baseline/reviewed-main-2026-08-14-source-alarms";
import {
  REVIEWED_MAIN_2026_08_14_M267_SOURCE_ALARMS,
} from "../../baseline/reviewed-main-2026-08-14-m267-source-alarms";
import {
  REVIEWED_MAIN_2026_08_15_SOURCE_ALARMS,
  SUPERSEDED_MAIN_2026_08_15_SOURCE_ALARM_LOCATORS,
} from "../../baseline/reviewed-main-2026-08-15-source-alarms";
import {
  REVIEWED_MAIN_2026_08_17_SOURCE_ALARMS,
  SUPERSEDED_MAIN_2026_08_17_SOURCE_ALARM_LOCATORS,
} from "../../baseline/reviewed-main-2026-08-17-source-alarms";
import {
  REVIEWED_MAIN_2026_08_20_SOURCE_ALARMS,
  SUPERSEDED_MAIN_2026_08_20_SOURCE_ALARM_LOCATORS,
} from "../../baseline/reviewed-main-2026-08-20-source-alarms";
import {
  REVIEWED_MAIN_2026_08_21_SOURCE_ALARMS,
  SUPERSEDED_MAIN_2026_08_21_SOURCE_ALARM_LOCATORS,
} from "../../baseline/reviewed-main-2026-08-21-source-alarms";
import {
  REVIEWED_MAIN_2026_08_22_SOURCE_ALARMS,
  SUPERSEDED_MAIN_2026_08_22_SOURCE_ALARM_LOCATORS,
} from "../../baseline/reviewed-main-2026-08-22-source-alarms";
import {
  REVIEWED_MAIN_2026_08_29_SOURCE_ALARMS,
  SUPERSEDED_MAIN_2026_08_29_SOURCE_ALARM_LOCATORS,
} from "../../baseline/reviewed-main-2026-08-29-source-alarms";
import {
  REVIEWED_M300_SOURCE_ALARMS,
  SUPERSEDED_M300_SOURCE_ALARM_LOCATORS,
} from "../../baseline/reviewed-m300-source-alarms";
import { REVIEWED_M301_SOURCE_ALARMS } from "../../baseline/reviewed-m301-source-alarms";
import { REVIEWED_M303_SOURCE_ALARMS } from "../../baseline/reviewed-m303-source-alarms";
import {
  REVIEWED_D565_RELAY_SOURCE_ALARMS,
  SUPERSEDED_D565_RELAY_SOURCE_ALARM_LOCATORS,
} from "../../baseline/reviewed-d565-relay-source-alarms";
import {
  REVIEWED_MAIN_2026_08_31_SOURCE_ALARMS,
  SUPERSEDED_MAIN_2026_08_31_SOURCE_ALARM_LOCATORS,
} from "../../baseline/reviewed-main-2026-08-31-source-alarms";
import {
  REVIEWED_MAIN_2026_09_03_SOURCE_ALARMS,
  SUPERSEDED_MAIN_2026_09_03_SOURCE_ALARM_LOCATORS,
} from "../../baseline/reviewed-main-2026-09-03-source-alarms";
import {
  REVIEWED_MAIN_2026_09_04_SOURCE_ALARMS,
} from "../../baseline/reviewed-main-2026-09-04-source-alarms";
import {
  REVIEWED_MAIN_2026_09_05_SOURCE_ALARMS,
} from "../../baseline/reviewed-main-2026-09-05-source-alarms";
import { REVIEWED_LANDING_SOURCE_ALARMS, SUPERSEDED_LANDING_SOURCE_LOCATORS } from "../../baseline/reviewed-main-2026-09-05-landing-source-alarms";
import {
  REVIEWED_D487_SOURCE_ALARMS,
  SUPERSEDED_D487_SOURCE_ALARM_LOCATORS,
} from "../../baseline/reviewed-d487-source-alarms";
import {
  REVIEWED_M240_SOURCE_ALARMS,
  SUPERSEDED_M240_SOURCE_ALARM_LOCATORS,
} from "../../baseline/reviewed-m240-source-alarms";
import type { CoverageSurface } from "../../src/model";
import {
  CURRENT_SOURCE_ALARM_REVIEWS,
  inspectSourceAlarmReviews,
  sourceAlarmDebtId,
  type SourceAlarmReview,
} from "../../src/node/source-alarm-review";
import {
  REVIEWED_M318_SOURCE_ALARMS,
  SUPERSEDED_M318_SOURCE_ALARM_LOCATORS,
} from "../../baseline/reviewed-m318-source-alarms";
import { REVIEWED_M321_SOURCE_ALARMS } from
  "../../baseline/reviewed-m321-source-alarms";
import {
  REVIEWED_MAIN_2026_09_09_DOCUMENTMEDIA_SOURCE_ALARMS,
  SUPERSEDED_MAIN_2026_09_09_DOCUMENTMEDIA_SOURCE_LOCATORS,
} from "../../baseline/reviewed-main-2026-09-09-document-media-source-alarms";
import {
  REVIEWED_MAIN_2026_09_09_MESSAGEBACKFILL_SOURCE_ALARMS,
  SUPERSEDED_MAIN_2026_09_09_MESSAGEBACKFILL_SOURCE_LOCATORS,
} from "../../baseline/reviewed-main-2026-09-09-message-backfill-source-alarms";
import {
  REVIEWED_MAIN_2026_09_09_PLATFORM_SOURCE_ALARMS,
  SUPERSEDED_MAIN_2026_09_09_PLATFORM_SOURCE_LOCATORS,
} from "../../baseline/reviewed-main-2026-09-09-platform-source-alarms";
import type { SourceAlarm } from "../../src/node/source-inventory";

function alarm(locator: string): SourceAlarm {
  const match = /#([^:]+):/.exec(locator);
  if (!match) throw new Error(`invalid fixture locator: ${locator}`);
  return {
    kind: match[1] as SourceAlarm["kind"],
    path: locator.slice(0, locator.indexOf("#")),
    line: 1,
    locator,
    evidence: "fixture(",
  };
}

const SURFACE_BY_KIND: Record<SourceAlarm["kind"], CoverageSurface> = {
  filesystem_write: "file",
  network_processor: "processor",
  subprocess_processor: "processor",
  log_emitter: "log",
  notification_emitter: "notification",
  temporary_storage: "cache",
  backup_export: "backup",
};

const EXPORT_LOCATORS = new Set([
  "apps/cli/src/commands/agent.ts#backup_export:9a76abb64c71107c:1",
  "apps/cli/src/commands/agent.ts#backup_export:9033c6e2930cf77b:1",
  "apps/cli/src/lib/profile-bundle.ts#backup_export:06e62f3001fa4c45:1",
  "packages/api-client/src/client.ts#backup_export:66723b3e59c70e42:1",
]);

const KIND_MARKER: Record<SourceAlarm["kind"], string> = {
  filesystem_write: "filesystem-write alarm",
  network_processor: "network-processor alarm",
  subprocess_processor: "subprocess-processor alarm",
  log_emitter: "log-emitter alarm",
  notification_emitter: "notification-emitter alarm",
  temporary_storage: "temporary-storage alarm",
  backup_export: "backup/export alarm",
};

function debtId(locator: string, surface: CoverageSurface): string {
  const kind = alarm(locator).kind;
  const digest = createHash("sha256").update(locator).digest("hex").slice(0, 16);
  return `debt.source-alarm.${surface}.${kind}.${digest}`;
}

function debtReview(locator: string): SourceAlarmReview {
  const kind = alarm(locator).kind;
  const surface = EXPORT_LOCATORS.has(locator)
    ? "export"
    : SURFACE_BY_KIND[kind];
  const owner =
    locator.split("#", 1)[0]?.split("/").slice(0, 2).join("/")
    || "packages/example";
  return {
    locator,
    debtId: debtId(locator, surface),
    surface,
    owner,
    closure: "baseline_debt",
    remediationState: "untriaged",
    releaseImpact: "blocks_whole_product_claim",
    reason:
      `${locator} is a reviewed ${KIND_MARKER[kind]} whose payload classification remains untriaged.`,
    evidenceGap:
      `${locator} lacks kind-specific executable payload-boundary evidence for this ${KIND_MARKER[kind]}.`,
  };
}

describe("source alarm review closure", () => {
  test("the current review set is the exact non-superseded baseline plus reviewed additions", () => {
    const previous = [
      ...SOURCE_ALARM_BASELINE_REVIEWS.filter(
        (review) =>
          !SUPERSEDED_WAVE_0_SOURCE_ALARM_LOCATORS.has(review.locator)
          && !SUPERSEDED_MAIN_2026_08_03_SOURCE_ALARM_LOCATORS.has(
            review.locator,
          )
          && !SUPERSEDED_MAIN_2026_08_04_SOURCE_ALARM_LOCATORS.has(
            review.locator,
          )
          && !SUPERSEDED_D487_SOURCE_ALARM_LOCATORS.has(review.locator)
          && !SUPERSEDED_M240_SOURCE_ALARM_LOCATORS.has(review.locator)
          && !SUPERSEDED_MAIN_2026_08_15_SOURCE_ALARM_LOCATORS.has(
            review.locator,
          ),
      ),
      ...REVIEWED_WAVE_4_SOURCE_ALARMS,
      ...REVIEWED_WAVE_6_SOURCE_ALARMS,
      ...REVIEWED_WAVE_7_SOURCE_ALARMS,
      ...REVIEWED_WAVE_9_SOURCE_ALARMS,
      ...REVIEWED_WAVE_10_SOURCE_ALARMS,
      ...REVIEWED_WAVE_11_SOURCE_ALARMS,
      ...REVIEWED_MAIN_2026_08_03_SOURCE_ALARMS.filter((review) =>
        !SUPERSEDED_MAIN_2026_08_04_SOURCE_ALARM_LOCATORS.has(review.locator)
      ),
      ...REVIEWED_MAIN_2026_08_04_SOURCE_ALARMS.filter((review) =>
        !SUPERSEDED_D487_SOURCE_ALARM_LOCATORS.has(review.locator)
        && !SUPERSEDED_M240_SOURCE_ALARM_LOCATORS.has(review.locator)
      ),
      ...REVIEWED_M240_SOURCE_ALARMS,
      ...REVIEWED_D487_SOURCE_ALARMS,
    ];
    const beforeAugust13 = [
      ...previous.filter((review) =>
        !SUPERSEDED_MAIN_2026_08_11_SOURCE_ALARM_LOCATORS.has(review.locator)
        && !SUPERSEDED_MAIN_2026_08_12_SOURCE_ALARM_LOCATORS.has(review.locator)
        && !SUPERSEDED_WAVE_12_SOURCE_ALARM_LOCATORS.has(review.locator)
      ),
      ...REVIEWED_MAIN_2026_08_11_SOURCE_ALARMS.filter((review) =>
        !SUPERSEDED_MAIN_2026_08_12_SOURCE_ALARM_LOCATORS.has(review.locator)
      ),
      ...REVIEWED_WAVE_12_SOURCE_ALARMS,
      ...REVIEWED_MAIN_2026_08_12_SOURCE_ALARMS,
      ...REVIEWED_WAVE_14_SOURCE_ALARMS,
    ];
    const beforeAugust17 = [
      ...[
        ...beforeAugust13.filter((review) =>
          !SUPERSEDED_MAIN_2026_08_13_SOURCE_ALARM_LOCATORS.has(review.locator)
        ),
        ...REVIEWED_MAIN_2026_08_13_SOURCE_ALARMS,
        ...REVIEWED_MAIN_2026_08_13_MERGED_SOURCE_ALARMS,
        ...REVIEWED_MAIN_2026_08_13_LATE_MERGE_SOURCE_ALARMS,
      ].filter((review) =>
        !SUPERSEDED_MAIN_2026_08_14_SOURCE_ALARM_LOCATORS.has(review.locator)
      ),
      ...[
        ...REVIEWED_MAIN_2026_08_14_SOURCE_ALARMS,
        ...REVIEWED_MAIN_2026_08_14_M267_SOURCE_ALARMS,
      ],
      ...REVIEWED_MAIN_2026_08_15_SOURCE_ALARMS,
    ];
    const beforeAugust20 = [
      ...beforeAugust17.filter((review) =>
        !SUPERSEDED_MAIN_2026_08_17_SOURCE_ALARM_LOCATORS.has(review.locator)
      ),
      ...REVIEWED_MAIN_2026_08_17_SOURCE_ALARMS,
    ];
    const beforeAugust22 = [
      ...[
        ...beforeAugust20.filter((review) =>
          !SUPERSEDED_MAIN_2026_08_20_SOURCE_ALARM_LOCATORS.has(review.locator)
        ),
        ...REVIEWED_MAIN_2026_08_20_SOURCE_ALARMS,
      ].filter((review) =>
        !SUPERSEDED_MAIN_2026_08_21_SOURCE_ALARM_LOCATORS.has(review.locator)
      ),
      ...REVIEWED_MAIN_2026_08_21_SOURCE_ALARMS,
    ];
    const beforeAugust29 = [
      ...beforeAugust22.filter((review) =>
        !SUPERSEDED_MAIN_2026_08_22_SOURCE_ALARM_LOCATORS.has(review.locator)
      ),
      ...REVIEWED_MAIN_2026_08_22_SOURCE_ALARMS,
    ];
    const beforeM300 = [
      ...beforeAugust29.filter((review) =>
        !SUPERSEDED_MAIN_2026_08_29_SOURCE_ALARM_LOCATORS.has(review.locator)
      ),
      ...REVIEWED_MAIN_2026_08_29_SOURCE_ALARMS,
    ];
    const beforeAugust31 = [
      ...beforeM300.filter((review) =>
        !SUPERSEDED_M300_SOURCE_ALARM_LOCATORS.has(review.locator)
      ),
      ...REVIEWED_M300_SOURCE_ALARMS,
    ];
    const beforeD565 = [
      ...beforeAugust31.filter((review) =>
        !SUPERSEDED_MAIN_2026_08_31_SOURCE_ALARM_LOCATORS.has(review.locator)
      ),
      ...REVIEWED_MAIN_2026_08_31_SOURCE_ALARMS,
      ...REVIEWED_M301_SOURCE_ALARMS,
      ...REVIEWED_M303_SOURCE_ALARMS,
    ];
    expect(CURRENT_SOURCE_ALARM_REVIEWS).toEqual([
      ...[
        ...beforeD565.filter((review) =>
          !SUPERSEDED_MAIN_2026_09_03_SOURCE_ALARM_LOCATORS.has(review.locator)
        ),
        ...REVIEWED_MAIN_2026_09_03_SOURCE_ALARMS,
        ...REVIEWED_MAIN_2026_09_04_SOURCE_ALARMS,
      ].filter((review) =>
        !SUPERSEDED_D565_RELAY_SOURCE_ALARM_LOCATORS.has(review.locator)
      ),
      ...REVIEWED_D565_RELAY_SOURCE_ALARMS,
    ].filter((review) => !isRetiredM306AuthorityLocator(review.locator)).concat(
      REVIEWED_MAIN_2026_09_05_SOURCE_ALARMS,
    ).filter((review) => !SUPERSEDED_LANDING_SOURCE_LOCATORS.has(review.locator))
      .concat(REVIEWED_LANDING_SOURCE_ALARMS)
      .filter((review) => !SUPERSEDED_M318_SOURCE_ALARM_LOCATORS.has(review.locator))
      .concat(REVIEWED_M318_SOURCE_ALARMS)
      .concat(REVIEWED_M321_SOURCE_ALARMS)
      .concat(REVIEWED_D581_SOURCE_ALARMS)
      .filter((review) =>
        !SUPERSEDED_MAIN_2026_09_09_DOCUMENTMEDIA_SOURCE_LOCATORS.has(review.locator)
        && !SUPERSEDED_MAIN_2026_09_09_MESSAGEBACKFILL_SOURCE_LOCATORS.has(review.locator)
        && !SUPERSEDED_MAIN_2026_09_09_PLATFORM_SOURCE_LOCATORS.has(review.locator)
      )
      .concat(REVIEWED_MAIN_2026_09_09_DOCUMENTMEDIA_SOURCE_ALARMS)
      .concat(REVIEWED_MAIN_2026_09_09_MESSAGEBACKFILL_SOURCE_ALARMS)
      .concat(REVIEWED_MAIN_2026_09_09_PLATFORM_SOURCE_ALARMS)
      .concat(REVIEWED_M314_SOURCE_ALARMS)
      .filter((review) => !SUPERSEDED_MAIN_2026_09_12_SOURCE_ALARM_LOCATORS.has(review.locator))
      .concat(REVIEWED_MAIN_2026_09_12_SOURCE_ALARMS)
      .concat(REVIEWED_REFLECTION_REPLAY_SOURCE_ALARMS));
  });

  test("maps every exact baseline alarm to owned, release-blocking closure", () => {
    const alarms = SOURCE_ALARM_BASELINE_REVIEWS.map((review) => alarm(review.locator));
    const inspection = inspectSourceAlarmReviews(
      alarms,
      SOURCE_ALARM_BASELINE_REVIEWS,
    );

    expect(inspection.errors).toEqual([]);
    expect(inspection.reviews).toHaveLength(alarms.length);
    expect(inspection.counts).toEqual({
      baselineDebt: alarms.length,
      declaration: 0,
      reviewedExclusion: 0,
      unmapped: 0,
    });
    for (const review of inspection.reviews) {
      expect(review.owner.length).toBeGreaterThan(0);
      expect(review.reason.length).toBeGreaterThan(12);
      expect(review.closure).toBe("baseline_debt");
      if (review.closure === "baseline_debt") {
        const kind = alarm(review.locator).kind;
        expect(review.surface).toBe(
          EXPORT_LOCATORS.has(review.locator)
            ? "export"
            : SURFACE_BY_KIND[kind],
        );
        expect(review.debtId).toBe(debtId(review.locator, review.surface));
        expect(review.reason).toContain(review.locator);
        expect(review.reason).toContain(KIND_MARKER[kind]);
        expect(review.evidenceGap).toContain(KIND_MARKER[kind]);
        expect(review.remediationState).toBe("untriaged");
        expect(review.releaseImpact).toBe("blocks_whole_product_claim");
        expect(review.evidenceGap).toContain(review.locator);
      }
    }
    expect(new Set(
      inspection.reviews.flatMap((review) =>
        review.closure === "baseline_debt" ? [review.debtId] : []
      ),
    ).size).toBe(alarms.length);
  });

  test("rejects malformed, colliding, non-derived debt identity and alarm-kind surface", () => {
    const filesystemLocator =
      "packages/example/src/a.ts#filesystem_write:0123456789abcdef:1";
    const logLocator =
      "packages/example/src/b.ts#log_emitter:fedcba9876543210:1";
    const validFilesystem = debtReview(filesystemLocator);
    const invalidIdentity = {
      ...debtReview(logLocator),
      debtId: validFilesystem.closure === "baseline_debt"
        ? validFilesystem.debtId
        : "unreachable",
      surface: "file",
    } as SourceAlarmReview;

    const inspection = inspectSourceAlarmReviews(
      [alarm(filesystemLocator), alarm(logLocator)],
      [validFilesystem, invalidIdentity],
    );

    expect(inspection.errors).toEqual([
      `duplicate source alarm closure id: ${
        validFilesystem.closure === "baseline_debt"
          ? validFilesystem.debtId
          : "unreachable"
      }`,
      `new source alarm has no closure: ${logLocator}`,
      `source alarm debt ID does not match locator and surface: ${logLocator}`,
      `source alarm debt surface file is invalid for log_emitter: ${logLocator}`,
    ]);
  });

  test.each(Object.keys(SURFACE_BY_KIND) as SourceAlarm["kind"][])(
    "requires explicit %s markers in both debt descriptions",
    (kind) => {
      const locator =
        `packages/example/src/a.ts#${kind}:0123456789abcdef:1`;
      const review = debtReview(locator);
      if (review.closure !== "baseline_debt") throw new Error("expected debt review");
      const inspection = inspectSourceAlarmReviews(
        [alarm(locator)],
        [{
          ...review,
          reason:
            `${locator} is deliberately retained as exact untriaged review debt.`,
          evidenceGap:
            `${locator} lacks deliberately reviewed executable boundary evidence.`,
        }],
      );

      expect(inspection.errors).toEqual([
        `new source alarm has no closure: ${locator}`,
        `source alarm debt evidence gap is not kind-specific: ${locator}`,
        `source alarm debt reason is not kind-specific: ${locator}`,
      ]);
    },
  );

  test.each(["prefix", "suffix"])(
    "requires an end-anchored debt ID (%s case)",
    (position) => {
      const locator =
        "packages/example/src/a.ts#log_emitter:0123456789abcdef:1";
      const review = debtReview(locator);
      if (review.closure !== "baseline_debt") throw new Error("expected debt review");
      const invalidId = position === "prefix"
        ? `x${review.debtId}`
        : `${review.debtId}x`;
      const inspection = inspectSourceAlarmReviews(
        [alarm(locator)],
        [{ ...review, debtId: invalidId }],
      );

      expect(inspection.errors).toEqual([
        `new source alarm has no closure: ${locator}`,
        `source alarm debt ID does not match locator and surface: ${locator}`,
        `source alarm debt has invalid ID: ${locator}`,
      ]);
    },
  );

  test("derives an explicit invalid-kind debt identity for malformed locators", () => {
    expect(sourceAlarmDebtId("not-a-locator", "log")).toMatch(
      /^debt[.]source-alarm[.]log[.]invalid[.][0-9a-f]{16}$/u,
    );
  });

  test("does not apply known-kind checks to an unknown-kind locator", () => {
    const locator =
      "packages/example/src/a.ts#unknown_kind:0123456789abcdef:1";
    const malformedAlarm = {
      kind: "filesystem_write",
      path: "packages/example/src/a.ts",
      line: 1,
      locator,
      evidence: "fixture(",
    } satisfies SourceAlarm;
    const malformedReview = {
      locator,
      debtId: sourceAlarmDebtId(locator, "log"),
      surface: "log",
      owner: "packages/example",
      closure: "baseline_debt",
      remediationState: "untriaged",
      releaseImpact: "blocks_whole_product_claim",
      reason: `${locator} is deliberate exact untriaged review debt.`,
      evidenceGap: `${locator} lacks deliberate executable boundary evidence.`,
    } satisfies SourceAlarmReview;

    expect(inspectSourceAlarmReviews(
      [malformedAlarm],
      [malformedReview],
    ).errors).toEqual([
      `invalid source alarm review locator: ${locator}`,
      `new source alarm has no closure: ${locator}`,
      `source alarm debt has invalid ID: ${locator}`,
    ]);
  });

  test("fails closed for new, stale, duplicate, and malformed exact locators", () => {
    const [firstReview, secondReview] = SOURCE_ALARM_BASELINE_REVIEWS;
    if (!firstReview || !secondReview) {
      throw new Error("source alarm baseline must contain at least two reviews");
    }
    const first = firstReview.locator;
    const second = secondReview.locator;
    const newAlarm = alarm(
      "packages/example/src/new.ts#filesystem_write:0123456789abcdef:1",
    );

    const inspection = inspectSourceAlarmReviews(
      [alarm(first), newAlarm],
      [
        debtReview(first),
        debtReview(first),
        debtReview(second),
        {
          locator: "not-an-alarm-locator",
          owner: "packages/example",
          closure: "declaration",
          declarationId: "source.example.invalid-locator",
          reason: "This malformed locator cannot close a source alarm.",
        },
      ],
    );

    expect(inspection.errors).toEqual([
      `duplicate source alarm review locator: ${first}`,
      "invalid source alarm review locator: not-an-alarm-locator",
      `new source alarm has no closure: ${newAlarm.locator}`,
      `stale source alarm review: ${second}`,
    ]);
    expect(inspection.counts.unmapped).toBe(1);
  });

  test("rejects an auto-accepted review without deliberate owner, reason, or evidence gap", () => {
    const firstReview = SOURCE_ALARM_BASELINE_REVIEWS[0];
    if (!firstReview) {
      throw new Error("source alarm baseline must contain at least one review");
    }
    const locator = firstReview.locator;

    const inspection = inspectSourceAlarmReviews(
      [alarm(locator)],
      [{
        locator,
        debtId: "invalid",
        surface: "log",
        owner: "",
        closure: "baseline_debt",
        remediationState: "untriaged",
        releaseImpact: "blocks_whole_product_claim",
        reason: "generic",
        evidenceGap: "missing",
      }],
    );

    expect(inspection.errors).toEqual([
      `new source alarm has no closure: ${locator}`,
      `source alarm debt ID does not match locator and surface: ${locator}`,
      `source alarm debt evidence gap is not kind-specific: ${locator}`,
      `source alarm debt evidence gap is not locator-specific: ${locator}`,
      `source alarm debt has invalid ID: ${locator}`,
      `source alarm debt has no descriptive evidence gap: ${locator}`,
      `source alarm debt reason is not kind-specific: ${locator}`,
      `source alarm debt reason is not locator-specific: ${locator}`,
      `source alarm review has no descriptive reason: ${locator}`,
      `source alarm review has no owner: ${locator}`,
    ]);
    expect(inspection.reviews).toEqual([]);
  });

  test("rejects invalid debt state, release impact, and non-specific evidence", () => {
    const firstReview = SOURCE_ALARM_BASELINE_REVIEWS[0];
    if (!firstReview) {
      throw new Error("source alarm baseline must contain at least one review");
    }
    const locator = firstReview.locator;
    const invalid = {
      ...debtReview(locator),
      remediationState: "done",
      releaseImpact: "does_not_block",
      evidenceGap: "No executable payload-boundary evidence exists for this call site.",
    } as unknown as SourceAlarmReview;

    const inspection = inspectSourceAlarmReviews([alarm(locator)], [invalid]);

    expect(inspection.errors).toEqual([
      `new source alarm has no closure: ${locator}`,
      `source alarm debt evidence gap is not kind-specific: ${locator}`,
      `source alarm debt evidence gap is not locator-specific: ${locator}`,
      `source alarm debt has invalid release impact: ${locator}`,
      `source alarm debt has invalid remediation state: ${locator}`,
    ]);
    expect(inspection.reviews).toEqual([]);
  });

  test("rejects a debt owner that does not own the locator path", () => {
    const firstReview = SOURCE_ALARM_BASELINE_REVIEWS[0];
    if (!firstReview) {
      throw new Error("source alarm baseline must contain at least one review");
    }
    const locator = firstReview.locator;
    const inspection = inspectSourceAlarmReviews(
      [alarm(locator)],
      [{ ...debtReview(locator), owner: "packages/unrelated" }],
    );

    expect(inspection.errors).toEqual([
      `new source alarm has no closure: ${locator}`,
      `source alarm debt owner packages/unrelated does not match locator owner apps/cli: ${locator}`,
    ]);
    expect(inspection.reviews).toEqual([]);
  });

  test("requires an anchored locator with a reviewed alarm kind", () => {
    const firstReview = SOURCE_ALARM_BASELINE_REVIEWS[0];
    if (!firstReview) {
      throw new Error("source alarm baseline must contain at least one review");
    }
    const invalidLocators = [
      `#${firstReview.locator}`,
      `${firstReview.locator}-suffix`,
      firstReview.locator.replace("#log_emitter:", "#unknown_kind:"),
      "single.ts#log_emitter:0123456789abcdef:1",
    ];
    const inspection = inspectSourceAlarmReviews(
      invalidLocators.map(alarm),
      invalidLocators.map(debtReview),
    );

    for (const locator of invalidLocators) {
      expect(inspection.errors).toContain(
        `invalid source alarm review locator: ${locator}`,
      );
      expect(inspection.errors).toContain(
        `new source alarm has no closure: ${locator}`,
      );
    }

    const singleSegment = invalidLocators.at(-1)!;
    const exact = inspectSourceAlarmReviews(
      [alarm(singleSegment)],
      [debtReview(singleSegment)],
    );
    expect(exact.errors).toEqual([
      `invalid source alarm review locator: ${singleSegment}`,
      `new source alarm has no closure: ${singleSegment}`,
    ]);
  });

  test("accepts the exact two-segment owner boundary", () => {
    const locator =
      "packages/example#log_emitter:0123456789abcdef:1";
    expect(inspectSourceAlarmReviews(
      [alarm(locator)],
      [debtReview(locator)],
    ).errors).toEqual([]);
  });

  test("rejects an observation whose declared kind disagrees with its locator", () => {
    const locator =
      "packages/example/src/a.ts#filesystem_write:0123456789abcdef:1";
    const mismatched = {
      ...alarm(locator),
      kind: "log_emitter",
    } satisfies SourceAlarm;

    expect(inspectSourceAlarmReviews(
      [mismatched],
      [debtReview(locator)],
    ).errors).toEqual([
      `source alarm observation kind log_emitter does not match filesystem_write: ${locator}`,
    ]);
  });

  test("uses trimmed exact boundaries for descriptions, owners, and closure IDs", () => {
    const [firstReview, secondReview, thirdReview] =
      SOURCE_ALARM_BASELINE_REVIEWS;
    if (!firstReview || !secondReview || !thirdReview) {
      throw new Error("source alarm baseline must contain at least three reviews");
    }
    expect(inspectSourceAlarmReviews(
      [alarm(firstReview.locator)],
      [{
        locator: firstReview.locator,
        owner: "apps/cli",
        closure: "declaration",
        declarationId: "source.apps-cli.boundary",
        reason: "abcdefghijkl",
      }],
    ).errors).toEqual([]);

    const invalidDebt = {
      ...debtReview(firstReview.locator),
      owner: "   ",
      reason: " 12345678901 ",
    } satisfies SourceAlarmReview;
    const invalidDeclaration = {
      locator: secondReview.locator,
      owner: "apps/cli",
      closure: "declaration",
      declarationId: "   ",
      reason: "This exact alarm has a semantic declaration.",
    } satisfies SourceAlarmReview;
    const invalidExclusion = {
      locator: thirdReview.locator,
      owner: "apps/cli",
      closure: "reviewed_exclusion",
      exclusionId: "   ",
      reason: "This exact alarm is a reviewed exclusion.",
    } satisfies SourceAlarmReview;
    const inspection = inspectSourceAlarmReviews(
      [
        alarm(firstReview.locator),
        alarm(secondReview.locator),
        alarm(thirdReview.locator),
      ],
      [invalidDebt, invalidDeclaration, invalidExclusion],
    );

    expect(inspection.errors).toContain(
      `source alarm review has no owner: ${firstReview.locator}`,
    );
    expect(inspection.errors).toContain(
      `source alarm review has no descriptive reason: ${firstReview.locator}`,
    );
    expect(inspection.errors).toContain(
      `source alarm declaration closure has no ID: ${secondReview.locator}`,
    );
    expect(inspection.errors).toContain(
      `source alarm exclusion closure has no ID: ${thirdReview.locator}`,
    );
    expect(inspection.errors).not.toContain(
      `source alarm debt owner     does not match locator owner apps/cli: ${firstReview.locator}`,
    );
    expect(inspection.errors).not.toContain(
      "duplicate source alarm closure id:    ",
    );
  });

  test("validates declaration and reviewed-exclusion closure IDs", () => {
    const firstReview = SOURCE_ALARM_BASELINE_REVIEWS[0];
    const secondReview = SOURCE_ALARM_BASELINE_REVIEWS[1];
    if (!firstReview || !secondReview) {
      throw new Error("source alarm baseline must contain at least two reviews");
    }
    const declaration = {
      locator: firstReview.locator,
      owner: "apps/cli",
      closure: "declaration",
      declarationId: "source.apps-cli.copy-compose",
      reason: "This exact source alarm is closed by its semantic declaration.",
    } satisfies SourceAlarmReview;
    const exclusion = {
      locator: secondReview.locator,
      owner: "apps/cli",
      closure: "reviewed_exclusion",
      exclusionId: "exclusion.apps-cli.copy-compose",
      reason: "This exact source alarm is a reviewed non-payload diagnostic.",
    } satisfies SourceAlarmReview;

    expect(inspectSourceAlarmReviews(
      [alarm(firstReview.locator), alarm(secondReview.locator)],
      [declaration, exclusion],
    )).toEqual({
      reviews: [declaration, exclusion],
      errors: [],
      counts: {
        declaration: 1,
        baselineDebt: 0,
        reviewedExclusion: 1,
        unmapped: 0,
      },
    });

    const invalid = inspectSourceAlarmReviews(
      [alarm(firstReview.locator), alarm(secondReview.locator)],
      [
        { ...declaration, declarationId: "" },
        { ...exclusion, exclusionId: "" },
      ],
    );
    expect(invalid.errors).toEqual([
      `new source alarm has no closure: ${firstReview.locator}`,
      `new source alarm has no closure: ${secondReview.locator}`,
      `source alarm declaration closure has no ID: ${firstReview.locator}`,
      `source alarm exclusion closure has no ID: ${secondReview.locator}`,
    ]);
  });

  test("keeps review output deterministic when alarm input order changes", () => {
    const reviews = SOURCE_ALARM_BASELINE_REVIEWS.slice(0, 3);
    const alarms = reviews.map((review) => alarm(review.locator));
    const first = inspectSourceAlarmReviews(alarms, reviews);
    const second = inspectSourceAlarmReviews([...alarms].reverse(), [...reviews].reverse());

    expect(first).toEqual(second);
    expect(first.reviews satisfies readonly SourceAlarmReview[]).toBeDefined();
  });
});
