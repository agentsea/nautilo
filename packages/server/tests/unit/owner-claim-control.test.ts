import { describe, expect, test } from "bun:test";
import { inviteRedemptions, invites, users } from "@nautilo/db";

import {
  OWNER_CLAIM_TTL_MS,
  installOwnerClaim,
  isValidOwnerClaimHash,
  parseOwnerClaimExpiresAt,
} from "../../src/lib/owner-claim-control";

const NOW = new Date("2026-08-07T12:00:00.000Z");
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

type ClaimRow = {
  id: string;
  tokenHash: string;
  expiresAt: Date | null;
};

function makeDb(opts: {
  ownerBound?: boolean;
  rows?: ClaimRow[];
  bindings?: Array<{ inviteId: string; userId: string; completedAt: Date | null }>;
}) {
  const events: Array<{ kind: string; value?: Record<string, unknown> }> = [];
  const rows = opts.rows ?? [];
  const ownerQuery = {
    innerJoin: () => ownerQuery,
    where: () => ({
      orderBy: () => ({ limit: () => Promise.resolve(opts.ownerBound ? [{ id: "owner-1" }] : []) }),
    }),
  };
  const tx = {
    execute: async () => [],
    select: (fields: Record<string, unknown>) => ({
      from: (table: unknown) => {
        if (table === users && "id" in fields) return ownerQuery;
        if (table === invites) {
          if (!("tokenHash" in fields)) {
            return {
              where: () => ({
                orderBy: () => ({
                  offset: () => Promise.resolve([]),
                }),
              }),
            };
          }
          return {
            where: () => ({
              for: () => Promise.resolve(rows),
            }),
          };
        }
        if (table === inviteRedemptions) {
          return {
            where: () => Promise.resolve(
              (opts.bindings ?? [])
                .filter((row) => row.completedAt === null)
                .map((row) => ({ userId: row.userId })),
            ),
          };
        }
        throw new Error("unexpected select");
      },
    }),
    update: (table: unknown) => {
      expect(table).toBe(invites);
      return {
        set: (value: Record<string, unknown>) => ({
          where: async () => {
            events.push({ kind: "revoke", value });
          },
        }),
      };
    },
    insert: (table: unknown) => {
      if (table === inviteRedemptions) {
        return {
          values: async (value: Record<string, unknown>) => {
            events.push({ kind: "binding", value });
          },
        };
      }
      expect(table).toBe(invites);
      return {
        values: (value: Record<string, unknown>) => {
          events.push({ kind: "insert", value });
          return { returning: async () => [{ id: "new-claim" }] };
        },
      };
    },
  };
  return {
    events,
    db: {
      transaction: async (fn: (inner: typeof tx) => Promise<unknown>) => fn(tx),
    },
  };
}

describe("D488 owner claim control", () => {
  test("accepts only the controller hash and a bounded canonical expiry", () => {
    expect(isValidOwnerClaimHash(HASH_A)).toBe(true);
    // The plaintext capability remains the legacy/current `inv_` + 32
    // base64url chars (24 random bytes); this boundary accepts only its hash.
    expect(isValidOwnerClaimHash(`inv_${"a".repeat(32)}`)).toBe(false);
    expect(isValidOwnerClaimHash("A".repeat(64))).toBe(false);
    expect(parseOwnerClaimExpiresAt("2026-08-07T12:15:00.000Z")).toEqual(
      new Date("2026-08-07T12:15:00.000Z"),
    );
    expect(parseOwnerClaimExpiresAt("2026-08-07T12:15:00Z")).toBeNull();
  });

  test("same active hash is idempotent and does not issue a replacement", async () => {
    const expiresAt = new Date(NOW.getTime() + 10 * 60 * 1000);
    const fake = makeDb({ rows: [{ id: "claim-a", tokenHash: HASH_A, expiresAt }] });
    const result = await installOwnerClaim({
      claimHash: HASH_A,
      expiresAt: expiresAt.toISOString(),
      now: NOW,
      db: fake.db as never,
    });

    expect(result).toEqual({ ok: true, status: "already-installed", expiresAt });
    expect(fake.events).toEqual([]);
  });

  test("replacement revokes every prior unconsumed claim before it inserts", async () => {
    const replacementExpiry = new Date(NOW.getTime() + 10 * 60 * 1000);
    const fake = makeDb({
      rows: [
        { id: "expired", tokenHash: HASH_A, expiresAt: new Date(NOW.getTime() - 1) },
        { id: "old", tokenHash: HASH_B, expiresAt: replacementExpiry },
      ],
    });
    const result = await installOwnerClaim({
      claimHash: "c".repeat(64),
      expiresAt: replacementExpiry.toISOString(),
      now: NOW,
      db: fake.db as never,
    });

    expect(result.ok).toBe(true);
    expect(result).toMatchObject({ status: "installed" });
    expect(fake.events.map((event) => event.kind)).toEqual(["revoke", "insert"]);
    expect(fake.events[1]?.value).toMatchObject({
      tokenHash: "c".repeat(64),
      expiresAt: replacementExpiry,
      maxUses: 1,
      usedCount: 0,
      revokedAt: null,
    });
  });

  test("replacement preserves the user reserved by an interrupted browser claim", async () => {
    const replacementExpiry = new Date(NOW.getTime() + 10 * 60 * 1000);
    const fake = makeDb({
      rows: [{
        id: "half-bound",
        tokenHash: HASH_A,
        expiresAt: new Date(NOW.getTime() - 1),
      }],
      bindings: [{ inviteId: "half-bound", userId: "user-1", completedAt: null }],
    });
    const result = await installOwnerClaim({
      claimHash: HASH_B,
      expiresAt: replacementExpiry.toISOString(),
      now: NOW,
      db: fake.db as never,
    });

    expect(result).toMatchObject({ ok: true, status: "installed" });
    expect(fake.events.at(-1)).toMatchObject({
      kind: "binding",
      value: {
        inviteId: "new-claim",
        userId: "user-1",
        boundAt: NOW,
      },
    });
  });

  test("rejects an owner-bound target before touching claim rows", async () => {
    const fake = makeDb({ ownerBound: true });
    const result = await installOwnerClaim({
      claimHash: HASH_A,
      expiresAt: new Date(NOW.getTime() + OWNER_CLAIM_TTL_MS).toISOString(),
      now: NOW,
      db: fake.db as never,
    });

    expect(result).toEqual({ ok: false, status: "owner-bound" });
    expect(fake.events).toEqual([]);
  });
});
