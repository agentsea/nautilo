import { describe, expect, test } from "bun:test";

import { DTO_BASELINE_DECLARATIONS } from "../../baseline/dto-declarations";
import { BASELINE_REGISTRY } from "../../baseline/existing-debt";
import {
  REVIEWED_MAIN_2026_08_22_COVERAGE_ENTRIES,
  REVIEWED_MAIN_2026_08_22_DEBT_LINKS,
  SUPERSEDED_MAIN_2026_08_22_COVERAGE_LOCATORS,
} from "../../baseline/reviewed-main-2026-08-22-coverage";
import {
  REVIEWED_MAIN_2026_08_22_SOURCE_ALARMS,
  SUPERSEDED_MAIN_2026_08_22_SOURCE_ALARM_LOCATORS,
} from "../../baseline/reviewed-main-2026-08-22-source-alarms";
import { SUPERSEDED_MAIN_2026_08_29_SOURCE_ALARM_LOCATORS } from "../../baseline/reviewed-main-2026-08-29-source-alarms";
import { SUPERSEDED_MAIN_2026_09_03_COVERAGE_LOCATORS } from "../../baseline/reviewed-main-2026-09-03-coverage";
import { SUPERSEDED_MAIN_2026_09_03_SOURCE_ALARM_LOCATORS } from "../../baseline/reviewed-main-2026-09-03-source-alarms";
import { SUPERSEDED_D565_RELAY_SOURCE_ALARM_LOCATORS } from "../../baseline/reviewed-d565-relay-source-alarms";
import { isRetiredM306AuthorityLocator } from "../../baseline/retired-m306-authority";
import { SUPERSEDED_M300_SOURCE_ALARM_LOCATORS } from "../../baseline/reviewed-m300-source-alarms";
import { CURRENT_SOURCE_ALARM_REVIEWS } from "../../src/node/source-alarm-review";

describe("reviewed main 2026-08-22 encryption inventory", () => {
  test("keeps live-shadow payloads protected and coordination state content-free", () => {
    const protectedEntries = REVIEWED_MAIN_2026_08_22_COVERAGE_ENTRIES.filter(
      (entry) => entry.classification === "protected",
    );
    expect(protectedEntries.length).toBeGreaterThan(0);
    expect(protectedEntries.every((entry) =>
      entry.surface === "wire" && entry.keyFamily === "namespace_human"
    )).toBe(true);

    const databaseEntries = REVIEWED_MAIN_2026_08_22_COVERAGE_ENTRIES.filter(
      (entry) => entry.surface === "db",
    );
    expect(databaseEntries.length).toBeGreaterThan(0);
    expect(databaseEntries.every((entry) =>
      entry.classification === "bounded_metadata"
    )).toBe(true);
    expect(databaseEntries.some((entry) =>
      entry.classification === "bounded_metadata"
      && entry.metadataAllowlist.some((field) => field.includes("plaintext"))
    )).toBe(false);

    for (const entry of REVIEWED_MAIN_2026_08_22_COVERAGE_ENTRIES) {
      if (
        SUPERSEDED_MAIN_2026_09_03_COVERAGE_LOCATORS.has(entry.locator)
        || isRetiredM306AuthorityLocator(entry.locator)
      ) {
        expect(BASELINE_REGISTRY.entries.some((candidate) =>
          candidate.locator === entry.locator
        )).toBe(false);
      } else {
        expect(BASELINE_REGISTRY.entries).toContainEqual(entry);
      }
    }
  });

  test("links the compatibility session insert to the frozen session boundary", () => {
    expect(REVIEWED_MAIN_2026_08_22_DEBT_LINKS).toHaveLength(7);
    const sessionLink = REVIEWED_MAIN_2026_08_22_DEBT_LINKS.find((link) =>
      link.locator.includes("#inspectProductCandidate:")
    );
    expect(sessionLink?.targetDebtIds).toEqual([
      "debt.db.public.sessions.agent_id",
      "debt.db.public.sessions.channel",
      "debt.db.public.sessions.id",
      "debt.db.public.sessions.room_id",
      "debt.db.public.sessions.thread_id",
    ]);
    expect(BASELINE_REGISTRY.reviewedDebtLinks).toContainEqual(sessionLink);
    const namedRoomLinks = REVIEWED_MAIN_2026_08_22_DEBT_LINKS.filter((link) =>
      link.surface === "wire"
    );
    expect(namedRoomLinks).toHaveLength(6);
    for (const link of namedRoomLinks) {
      expect(BASELINE_REGISTRY.reviewedDebtLinks).toContainEqual(link);
    }
  });

  test("replaces only the renamed shadow-encryption policy coordinate", () => {
    expect(SUPERSEDED_MAIN_2026_08_22_COVERAGE_LOCATORS).toEqual(new Set([
      "public.encryption_transition_policy.shadow_writes_started_at",
    ]));
    expect(BASELINE_REGISTRY.entries.some((entry) =>
      entry.locator === "public.encryption_transition_policy.shadow_writes_started_at"
    )).toBe(false);
    expect(BASELINE_REGISTRY.entries.some((entry) =>
      entry.locator === "public.encryption_transition_policy.shadow_encryption_started_at"
    )).toBe(true);
  });

  test("declares live-shadow open payload leaves as concrete crypto contracts", () => {
    const liveShadowDeclarations = DTO_BASELINE_DECLARATIONS.filter(
      (declaration) => declaration.locator.includes("live-shadow")
        || declaration.locator.includes("LiveShadow")
        || declaration.locator.endsWith("#RoomPostMessageBody")
        || declaration.locator.endsWith("#RoomMessageSendResponse"),
    );
    expect(liveShadowDeclarations.length).toBeGreaterThan(0);
    const payloads = liveShadowDeclarations.flatMap(
      (declaration) => declaration.arbitraryPayloads,
    ).filter((payload) =>
      payload.path.includes("liveShadow")
      || payload.path.includes("protectedMessage")
      || payload.path === "request.body"
    );
    expect(payloads.some((payload) =>
      payload.schema === "ProtectedMessageDtoV2"
    )).toBe(true);
    expect(payloads.some((payload) =>
      payload.schema === "LiveShadowMessageRequestV1"
    )).toBe(true);
    expect(payloads.every((payload) => payload.debtId === undefined)).toBe(true);
  });

  test("closes only reviewed local-tooling and fixed diagnostic alarms", () => {
    expect(REVIEWED_MAIN_2026_08_22_SOURCE_ALARMS).toHaveLength(16);
    expect(REVIEWED_MAIN_2026_08_22_SOURCE_ALARMS.every(
      (review) => review.closure === "declaration",
    )).toBe(true);
    for (const review of REVIEWED_MAIN_2026_08_22_SOURCE_ALARMS) {
      if (
        SUPERSEDED_MAIN_2026_08_29_SOURCE_ALARM_LOCATORS.has(review.locator)
        || SUPERSEDED_M300_SOURCE_ALARM_LOCATORS.has(review.locator)
        || SUPERSEDED_MAIN_2026_09_03_SOURCE_ALARM_LOCATORS.has(review.locator)
        || SUPERSEDED_D565_RELAY_SOURCE_ALARM_LOCATORS.has(review.locator)
        || isRetiredM306AuthorityLocator(review.locator)
      ) {
        continue;
      }
      expect(CURRENT_SOURCE_ALARM_REVIEWS).toContainEqual(review);
    }
    for (const locator of SUPERSEDED_MAIN_2026_08_22_SOURCE_ALARM_LOCATORS) {
      expect(CURRENT_SOURCE_ALARM_REVIEWS.some((review) =>
        review.locator === locator
      )).toBe(false);
    }
  });
});
