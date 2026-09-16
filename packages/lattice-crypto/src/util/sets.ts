import type { UserId } from "../types/index.ts";

/**
 * Participant-set canonicalization + the fundamental subset predicate.
 *
 * A Namespace is identified (for lookup) by its canonical participant set:
 * sorted + de-duplicated. This mirrors Nautilo's `rooms.human_actor_ids`
 * which is stored sorted so the `= ARRAY[...]` and `@> ARRAY[...]` queries
 * behave deterministically.
 */

export function canonicalizeParticipants(users: UserId[]): UserId[] {
  return [...new Set(users)].sort();
}

export function participantsKey(users: UserId[]): string {
  return canonicalizeParticipants(users).join(",");
}

/**
 * The fundamental access rule: `S ⊆ N`. This is the crypto-free predicate
 * that both `EnumerationScheme` (v1) and any future ABE scheme (v2) must
 * agree on. Equivalent to Nautilo's `human_actor_ids @> ARRAY[scope]`.
 */
export function isSubset(scope: UserId[], namespace: UserId[]): boolean {
  const set = new Set(namespace);
  return scope.every((u) => set.has(u));
}
