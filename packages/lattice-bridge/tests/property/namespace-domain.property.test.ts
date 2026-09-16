import { describe, expect, test } from "bun:test";
import {
  exactHumanSetsMatch,
  nautiloActorId,
  translateParticipants,
  type HumanActorFact,
  type TranslationResult,
} from "../../src/index.ts";

function valueOf<T>(result: TranslationResult<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function human(index: number): HumanActorFact {
  const suffix = index.toString(16).padStart(12, "0");
  return {
    id: valueOf(
      nautiloActorId(`00000000-0000-4000-8000-${suffix}`),
    ),
    actorKind: "user",
  };
}

function shuffled<T>(input: readonly T[], seed: number): T[] {
  const result = [...input];
  let state = seed >>> 0;
  for (let index = result.length - 1; index > 0; index -= 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    const target = state % (index + 1);
    [result[index], result[target]] = [result[target]!, result[index]!];
  }
  return result;
}

describe("Namespace/Crypto Domain translation properties", () => {
  test("all deterministic input permutations produce one exact Human set", () => {
    const participants = Array.from({ length: 16 }, (_, index) =>
      human(index + 1)
    );
    const expected = valueOf(translateParticipants(participants));
    for (let seed = 1; seed <= 256; seed += 1) {
      const actual = valueOf(
        translateParticipants(shuffled(participants, seed)),
      );
      expect(actual.participants).toEqual(expected.participants);
      expect(actual.participantDigest).toEqual(expected.participantDigest);
      expect(exactHumanSetsMatch(actual, expected)).toBe(true);
    }
  });

  test("changing one Human never aliases the original exact set", () => {
    for (let seed = 1; seed <= 128; seed += 1) {
      const width = 2 + (seed % 15);
      const participants = Array.from({ length: width }, (_, index) =>
        human(index + 1)
      );
      const changed = [...participants];
      changed[seed % width] = human(1_000 + seed);
      const originalSet = valueOf(translateParticipants(participants));
      const changedSet = valueOf(translateParticipants(changed));
      expect(exactHumanSetsMatch(originalSet, changedSet)).toBe(false);
    }
  });
});
