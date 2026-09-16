/**
 * D266 Wave 2 — unit tests for the pure identity classifier in
 * `cleanup-test-cruft-classification.ts`.
 *
 * Table-driven cases model the actual default-inventory shapes the audit
 * named: the real `seedDefaultOwner` placeholder, D279 / D386 fixture
 * families, null-handle runtime fixtures, real operator users, and ordinary
 * authenticated users. No DB is touched — the classifier is pure.
 */
import { describe, expect, test } from "bun:test";
import {
  classifyAllUsers,
  classifyUserIdentity,
  findOldestUserId,
  isExplicitOverrideEligible,
  isProtectedRefusalClass,
  isSeedDefaultOwnerShape,
  SEED_DEFAULT_OWNER_EMAIL,
  SEED_DEFAULT_OWNER_NAME,
  type CleanupUserRecord,
  type UserIdentityClass,
} from "../../src/commands/cleanup-test-cruft-classification";

function row(partial: Partial<CleanupUserRecord> & Pick<CleanupUserRecord, "id">): CleanupUserRecord {
  return {
    handle: null,
    name: null,
    email: null,
    externalId: null,
    hasCredentials: false,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    ...partial,
  };
}

const SEED = {
  name: SEED_DEFAULT_OWNER_NAME,
  email: SEED_DEFAULT_OWNER_EMAIL,
};

describe("cleanup-test-cruft identity classification", () => {
  describe("findOldestUserId", () => {
    test("returns null for an empty set", () => {
      expect(findOldestUserId([])).toBeNull();
    });

    test("picks the earliest createdAt deterministically", () => {
      const a = row({ id: "a", createdAt: new Date("2026-03-01T00:00:00.000Z") });
      const b = row({ id: "b", createdAt: new Date("2026-01-01T00:00:00.000Z") });
      const c = row({ id: "c", createdAt: new Date("2026-02-01T00:00:00.000Z") });
      expect(findOldestUserId([a, b, c])).toBe("b");
    });

    test("ties resolve to the first encountered row", () => {
      const t = new Date("2026-01-01T00:00:00.000Z");
      const a = row({ id: "a", createdAt: t });
      const b = row({ id: "b", createdAt: t });
      expect(findOldestUserId([a, b])).toBe("a");
    });
  });

  describe("isSeedDefaultOwnerShape", () => {
    test("the real seedDefaultOwner placeholder (oldest) matches", () => {
      const seed = row({
        id: "seed",
        ...SEED,
        createdAt: new Date("2025-12-01T00:00:00.000Z"),
      });
      expect(isSeedDefaultOwnerShape(seed, true)).toBe(true);
    });

    test("is NOT keyed by handle — null handle still matches", () => {
      const seed = row({
        id: "seed",
        handle: null,
        ...SEED,
      });
      expect(isSeedDefaultOwnerShape(seed, true)).toBe(true);
    });

    test("a non-oldest row with the seed shape is NOT the seed", () => {
      const seed = row({ id: "seed", ...SEED });
      expect(isSeedDefaultOwnerShape(seed, false)).toBe(false);
    });

    test("wrong name is not the seed", () => {
      const r = row({ id: "x", name: "owner", email: SEED_DEFAULT_OWNER_EMAIL });
      expect(isSeedDefaultOwnerShape(r, true)).toBe(false);
    });

    test("wrong email is not the seed", () => {
      const r = row({ id: "x", name: SEED_DEFAULT_OWNER_NAME, email: "dev@example.com" });
      expect(isSeedDefaultOwnerShape(r, true)).toBe(false);
    });

    test("external_id set is not the seed", () => {
      const r = row({ id: "x", ...SEED, externalId: "logto-abc" });
      expect(isSeedDefaultOwnerShape(r, true)).toBe(false);
    });

    test("credentials present is not the seed", () => {
      const r = row({ id: "x", ...SEED, hasCredentials: true });
      expect(isSeedDefaultOwnerShape(r, true)).toBe(false);
    });
  });

  describe("classifyUserIdentity — table-driven inventory shapes", () => {
    const cases: Array<{
      name: string;
      user: CleanupUserRecord;
      isOldest: boolean;
      expected: UserIdentityClass;
    }> = [
      {
        name: "real seedDefaultOwner placeholder (oldest, null handle)",
        user: row({ id: "seed", handle: null, ...SEED }),
        isOldest: true,
        expected: "bootstrap-seed",
      },
      {
        name: "D279 fixture: credentialless, no external_id, NOT oldest",
        user: row({
          id: "d279-1",
          handle: "d104acct-alice",
          name: "D279 Alice",
          email: "d279-alice@example.com",
        }),
        isOldest: false,
        expected: "unknown-credentialless",
      },
      {
        name: "D386 fixture: half-redeemed (no credentials, external_id set)",
        user: row({
          id: "d386-1",
          handle: "whoami-d386-writer",
          name: "D386 Writer",
          email: "d386-writer@example.com",
          externalId: "logto-d386-claim",
        }),
        isOldest: false,
        expected: "half-redeemed",
      },
      {
        name: "null-handle runtime fixture: credentialless, no external_id, not oldest",
        user: row({ id: "rt-null", handle: null, name: "rt-fixture", email: "rt@example.com" }),
        isOldest: false,
        expected: "unknown-credentialless",
      },
      {
        name: "real operator user: authenticated (credentials + external_id)",
        user: row({
          id: "operator",
          handle: "alex",
          name: "Alex",
          email: "alex@example.com",
          externalId: "logto-alex",
          hasCredentials: true,
        }),
        isOldest: false,
        expected: "ordinary-authenticated",
      },
      {
        name: "ordinary authenticated user with credentials but no external_id",
        user: row({
          id: "pin-user",
          handle: "anna",
          name: "Anna",
          email: "anna@example.com",
          hasCredentials: true,
        }),
        isOldest: false,
        expected: "ordinary-authenticated",
      },
      {
        name: "credentialless seed-shaped row that is NOT oldest is unknown, not seed",
        user: row({ id: "late-seed", ...SEED }),
        isOldest: false,
        expected: "unknown-credentialless",
      },
      {
        name: "half-redeemed seed-shaped row (external_id set) is half-redeemed, not seed",
        user: row({ id: "claimed-seed", ...SEED, externalId: "logto-claim" }),
        isOldest: true,
        expected: "half-redeemed",
      },
    ];

    for (const c of cases) {
      test(c.name, () => {
        expect(classifyUserIdentity(c.user, c.isOldest)).toBe(c.expected);
      });
    }
  });

  describe("classifyAllUsers — oldest is computed across the set", () => {
    test("only the single oldest seed-shaped row is bootstrap-seed", () => {
      const seed = row({
        id: "seed",
        ...SEED,
        createdAt: new Date("2025-11-01T00:00:00.000Z"),
      });
      const lateSeed = row({
        id: "late-seed",
        ...SEED,
        createdAt: new Date("2026-06-01T00:00:00.000Z"),
      });
      const half = row({
        id: "d386",
        handle: "whoami-d386",
        name: "D386",
        email: "d386@example.com",
        externalId: "logto-x",
        createdAt: new Date("2026-03-01T00:00:00.000Z"),
      });
      const op = row({
        id: "alex",
        handle: "alex",
        name: "Alex",
        email: "alex@example.com",
        externalId: "logto-alex",
        hasCredentials: true,
        createdAt: new Date("2025-12-01T00:00:00.000Z"),
      });
      const classes = classifyAllUsers([seed, lateSeed, half, op]);
      expect(classes.get("seed")).toBe("bootstrap-seed");
      expect(classes.get("late-seed")).toBe("unknown-credentialless");
      expect(classes.get("d386")).toBe("half-redeemed");
      expect(classes.get("alex")).toBe("ordinary-authenticated");
    });

    test("empty set yields an empty classification", () => {
      expect(classifyAllUsers([]).size).toBe(0);
    });
  });

  describe("refusal / override eligibility helpers", () => {
    test("bootstrap-seed is a protected refusal and never override-eligible", () => {
      expect(isProtectedRefusalClass("bootstrap-seed")).toBe(true);
      expect(isExplicitOverrideEligible("bootstrap-seed")).toBe(false);
    });

    test("half-redeemed is a protected refusal but IS override-eligible", () => {
      expect(isProtectedRefusalClass("half-redeemed")).toBe(true);
      expect(isExplicitOverrideEligible("half-redeemed")).toBe(true);
    });

    test("unknown-credentialless is a protected refusal but IS override-eligible", () => {
      expect(isProtectedRefusalClass("unknown-credentialless")).toBe(true);
      expect(isExplicitOverrideEligible("unknown-credentialless")).toBe(true);
    });

    test("ordinary-authenticated is neither a refusal nor override-eligible", () => {
      expect(isProtectedRefusalClass("ordinary-authenticated")).toBe(false);
      expect(isExplicitOverrideEligible("ordinary-authenticated")).toBe(false);
    });
  });
});
