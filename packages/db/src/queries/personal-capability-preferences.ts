import { and, eq } from "drizzle-orm";
import {
  parsePersonalCapabilityPreferenceOverrides,
  type PersonalCapabilityPreferenceOverrides,
  type PersonalCapabilityPreferences,
} from "@nautilo/types";
import type { Database } from "../config/database";
import { personalCapabilityPreferences } from "../schema/personal-capability-preferences";

export type PersonalCapabilityPreferencesReadDb = Pick<Database, "select">;
export type PersonalCapabilityPreferencesWriteDb = Pick<
  Database,
  "insert" | "select" | "transaction" | "update"
>;

export type ReplacePersonalCapabilityPreferencesResult =
  | { readonly status: "updated"; readonly preferences: PersonalCapabilityPreferences }
  | { readonly status: "conflict"; readonly currentRevision: number };

function project(
  row: { readonly revision: number; readonly overrides: unknown } | undefined,
): PersonalCapabilityPreferences {
  if (!row) return { revision: 0, overrides: {} };
  const overrides = parsePersonalCapabilityPreferenceOverrides(row.overrides);
  if (!overrides) {
    throw new Error("Invalid personal capability preference overrides");
  }
  return { revision: row.revision, overrides };
}

/** Missing rows are the canonical all-inherited revision-zero state. */
export async function getPersonalCapabilityPreferences(
  db: PersonalCapabilityPreferencesReadDb,
  humanId: string,
): Promise<PersonalCapabilityPreferences> {
  const [row] = await db
    .select({
      revision: personalCapabilityPreferences.revision,
      overrides: personalCapabilityPreferences.overrides,
    })
    .from(personalCapabilityPreferences)
    .where(eq(personalCapabilityPreferences.userId, humanId))
    .limit(1);
  return project(row);
}

/**
 * Atomically replaces the sparse map. Revision zero creates the Human's first
 * row; every later write must match the exact current revision.
 */
export async function replacePersonalCapabilityPreferences(
  db: PersonalCapabilityPreferencesWriteDb,
  input: {
    readonly humanId: string;
    readonly expectedRevision: number;
    readonly overrides: PersonalCapabilityPreferenceOverrides;
  },
): Promise<ReplacePersonalCapabilityPreferencesResult> {
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
    throw new RangeError("Personal capability preference revision must be a non-negative safe integer");
  }
  const overrides = parsePersonalCapabilityPreferenceOverrides(input.overrides);
  if (!overrides) {
    throw new TypeError("Personal capability preference overrides are invalid");
  }

  return db.transaction(async (tx) => {
    if (input.expectedRevision === 0) {
      const [created] = await tx
        .insert(personalCapabilityPreferences)
        .values({
          userId: input.humanId,
          revision: 1,
          overrides,
        })
        .onConflictDoNothing({ target: personalCapabilityPreferences.userId })
        .returning({
          revision: personalCapabilityPreferences.revision,
          overrides: personalCapabilityPreferences.overrides,
        });
      if (created) {
        return { status: "updated", preferences: project(created) };
      }
    } else {
      const [updated] = await tx
        .update(personalCapabilityPreferences)
        .set({
          revision: input.expectedRevision + 1,
          overrides,
          updatedAt: new Date(),
        })
        .where(and(
          eq(personalCapabilityPreferences.userId, input.humanId),
          eq(personalCapabilityPreferences.revision, input.expectedRevision),
        ))
        .returning({
          revision: personalCapabilityPreferences.revision,
          overrides: personalCapabilityPreferences.overrides,
        });
      if (updated) {
        return { status: "updated", preferences: project(updated) };
      }
    }

    const [current] = await tx
      .select({ revision: personalCapabilityPreferences.revision })
      .from(personalCapabilityPreferences)
      .where(eq(personalCapabilityPreferences.userId, input.humanId))
      .limit(1);
    return {
      status: "conflict",
      currentRevision: current?.revision ?? 0,
    };
  });
}
