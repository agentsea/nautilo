import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { BASELINE_REGISTRY } from "../../baseline/existing-debt";
import { DTO_BASELINE_DECLARATIONS } from "../../baseline/dto-declarations";
import { SUPERSEDED_D565_RELAY_DTO_LOCATORS } from "../../baseline/reviewed-d565-relay-dto";
import {
  RETIRED_D565_RELAY_SOURCE_FROZEN_DEBT,
  REVIEWED_D565_RELAY_SOURCE_DEBT_LINKS,
} from "../../baseline/reviewed-d565-relay-source-migration";
import {
  D565_RELAY_SOURCE_ALARM_MIGRATIONS,
  RETIRED_D565_RELAY_SOURCE_ALARMS,
  REVIEWED_D565_RELAY_SOURCE_ALARMS,
  SUPERSEDED_D565_RELAY_SOURCE_ALARM_LOCATORS,
} from "../../baseline/reviewed-d565-relay-source-alarms";
import {
  REINTRODUCED_D565_SOURCE_ALARM_LOCATORS,
} from "../../baseline/reviewed-main-2026-09-05-source-alarms";
import { SOURCE_ALARM_BASELINE_REVIEWS } from "../../baseline/source-alarm-reviews";
import { REVIEWED_MAIN_2026_08_11_SOURCE_ALARMS } from "../../baseline/reviewed-main-2026-08-11-source-alarms";
import {
  CURRENT_SOURCE_ALARM_REVIEWS,
  inspectSourceAlarmReviews,
} from "../../src/node/source-alarm-review";
import {
  collectRepositoryInventory,
  repositoryVerificationCategories,
} from "../../src/node/repository-inventory";
import {
  scanSourceAlarms,
  SOURCE_DECLARATIONS,
} from "../../src/node/source-inventory";

const repositoryRoot = resolve(import.meta.dir, "../../../..");
const D565_SOURCE_PATHS = [
  "apps/desktop/electron/relay-",
  "apps/desktop/electron/relay-dispatch/",
  "apps/desktop/scripts/vendor-relay-host.ts",
  "bin/nautilo-relay/",
  "packages/server/src/mcp/relay-mcp-bridge.ts",
] as const;

describe("D565 Desktop Relay source migration", () => {
  test("repoints frozen relay debt without replacing it", () => {
    const locators = new Set(SOURCE_DECLARATIONS.map((item) => item.locator));
    expect(locators).toContain(
      "apps/desktop/electron/relay.ts#browser-capture-temporary-roots",
    );
    expect(locators).toContain(
      "apps/desktop/electron/relay-dispatch/media.ts#media-extract-temporary-roots",
    );
    expect(locators).toContain(
      "apps/desktop/electron/relay-dispatch/router.ts#createFixedDesktopDispatchRouter",
    );
    expect(locators).not.toContain(
      "apps/desktop/electron/relay.ts#desktop-capture-temporary-roots",
    );
    expect(locators).not.toContain(
      "apps/desktop/electron/relay.ts#relay-dispatch",
    );

    expect(REVIEWED_D565_RELAY_SOURCE_DEBT_LINKS).toHaveLength(3);
    for (const link of REVIEWED_D565_RELAY_SOURCE_DEBT_LINKS) {
      expect(BASELINE_REGISTRY.reviewedDebtLinks).toContainEqual(link);
    }
    expect(RETIRED_D565_RELAY_SOURCE_FROZEN_DEBT).toHaveLength(2);
    for (const retirement of RETIRED_D565_RELAY_SOURCE_FROZEN_DEBT) {
      expect(BASELINE_REGISTRY.retiredFrozenDebt).toContainEqual(retirement);
    }
  });

  test("records the exact sidecar routing and authentication wire evolution", async () => {
    const inventory = await collectRepositoryInventory(repositoryRoot);
    for (const locator of SUPERSEDED_D565_RELAY_DTO_LOCATORS) {
      const observed = inventory.dto.find((candidate) =>
        candidate.locator === locator
      );
      const reviewed = DTO_BASELINE_DECLARATIONS.find((candidate) =>
        candidate.locator === locator
      );
      expect(reviewed?.structuralSignatures).toEqual(
        observed === undefined ? undefined : [...observed.structuralSignatures],
      );
      expect(reviewed?.arbitraryPayloads.map((item) => item.path)).toEqual(
        observed === undefined ? undefined : [...observed.arbitraryPayloads],
      );
    }

    const dtoErrors = repositoryVerificationCategories(
      inventory,
      BASELINE_REGISTRY,
    ).find((category) => category.category === "dto_declarations")?.errors ?? [];
    expect(dtoErrors.filter((failure) =>
      [...SUPERSEDED_D565_RELAY_DTO_LOCATORS].some((locator) =>
        failure.startsWith(`${locator}:`)
      )
    )).toEqual([]);
  });

  test("closes current alarms and preserves moved or removed debt history", async () => {
    expect(REVIEWED_D565_RELAY_SOURCE_ALARMS).toHaveLength(31);
    for (const review of REVIEWED_D565_RELAY_SOURCE_ALARMS) {
      expect(CURRENT_SOURCE_ALARM_REVIEWS).toContainEqual(review);
    }
    expect(REVIEWED_D565_RELAY_SOURCE_ALARMS.filter((review) =>
      review.closure === "baseline_debt"
    )).toHaveLength(27);
    expect(REVIEWED_D565_RELAY_SOURCE_ALARMS.filter((review) =>
      review.closure === "reviewed_exclusion"
    )).toHaveLength(4);
    for (const locator of SUPERSEDED_D565_RELAY_SOURCE_ALARM_LOCATORS) {
      expect(CURRENT_SOURCE_ALARM_REVIEWS.some((review) =>
        review.locator === locator
      )).toBe(REINTRODUCED_D565_SOURCE_ALARM_LOCATORS.has(locator));
    }

    const historicalDebtByLocator = new Map(
      [
        ...SOURCE_ALARM_BASELINE_REVIEWS,
        ...REVIEWED_MAIN_2026_08_11_SOURCE_ALARMS,
      ].flatMap((review) =>
        review.closure === "baseline_debt"
          ? [[review.locator, review.debtId] as const]
          : []
      ),
    );
    for (const [locator, debtId] of RETIRED_D565_RELAY_SOURCE_ALARMS) {
      expect(SUPERSEDED_D565_RELAY_SOURCE_ALARM_LOCATORS).toContain(locator);
      expect(historicalDebtByLocator.get(locator)).toBe(debtId);
    }
    expect(RETIRED_D565_RELAY_SOURCE_ALARMS).toHaveLength(6);

    for (const migration of D565_RELAY_SOURCE_ALARM_MIGRATIONS) {
      if (migration.priorLocator === undefined) {
        expect(migration.priorDebtId).toBeUndefined();
        continue;
      }
      expect(historicalDebtByLocator.get(migration.priorLocator)).toBe(
        migration.priorDebtId,
      );
    }

    const source = await scanSourceAlarms({ repoRoot: repositoryRoot });
    expect(source.errors).toEqual([]);
    expect(inspectSourceAlarmReviews(source.alarms).errors.filter((failure) =>
      D565_SOURCE_PATHS.some((path) => failure.includes(path))
    )).toEqual([]);
  });
});
