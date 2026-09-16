import { getKeyByEnvVar } from "@nautilo/config-guard";
import { candidatesForModelRole } from "@nautilo/config";
import type { GenieAvatarValue, GenieBlock } from "@nautilo/api-client";
import names from "../data/genie-names.json" with { type: "json" };
import personalities from "../data/genie-personalities.json" with { type: "json" };
import voices from "../data/genie-voices.json" with { type: "json" };
import type { GenieResolvedIdentity } from "./genie-mapping.ts";

/** Preset avatar IDs matching server assets (avatar-08 absent). */
const PRESET_IDS: string[] = [
  ...Array.from({ length: 7 }, (_, i) => `avatar-${String(i + 1).padStart(2, "0")}`),
  ...Array.from({ length: 33 }, (_, i) => `avatar-${String(i + 9).padStart(2, "0")}`),
];

export type ResolvedProviderEntry = { key: string; value: { value: string } };

function splitmix32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    return ((z ^ (z >>> 16)) >>> 0) / 0xffffffff;
  };
}

function providerIdsFromEnvKeys(
  providers: ResolvedProviderEntry[],
): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const p of providers) {
    const def = getKeyByEnvVar(p.key);
    if (def) ids.add(def.id);
  }
  return ids;
}

function voiceProvider(voiceId: string): string {
  return voiceId.split(":", 2)[0]!.toLowerCase();
}

function filterVoices(
  allowedProviders: ReadonlySet<string>,
): typeof voices {
  return voices.filter((v) => allowedProviders.has(voiceProvider(v.id)));
}

/**
 * Filters the shared chat-role candidates to routes whose provider key was
 * loaded by setup. The server still revalidates signed-catalog availability
 * before persistence.
 */
function filterModels(allowedProviders: ReadonlySet<string>): readonly string[] {
  return candidatesForModelRole("chat").filter((id) =>
    allowedProviders.has(id.split(":", 1)[0] ?? ""),
  );
}

function pick<T>(rng: () => number, arr: readonly T[]): T {
  const idx = Math.floor(rng() * arr.length) % arr.length;
  return arr[idx]!;
}

/**
 * Deterministic Genie identity from a randomize block + resolved provider keys.
 */
export function randomizeGenie(
  block: Extract<GenieBlock, { mode: "randomize" }>,
  providers: ResolvedProviderEntry[],
  seed?: number,
): GenieResolvedIdentity {
  const effectiveSeed =
    seed ??
    (typeof performance !== "undefined" && performance.now
      ? (performance.now() * 1e6 + Date.now()) % 2 ** 31
      : Date.now() % 2 ** 31);
  const rng = splitmix32(effectiveSeed >>> 0);

  const allowed = providerIdsFromEnvKeys(providers);
  const voicePool = filterVoices(allowed);
  const modelPool = filterModels(allowed);

  const name = block.name ?? pick(rng, names as unknown as string[]);
  const personalityEntry = pick(rng, personalities);
  const personality = block.personality ?? personalityEntry.summary;
  // D112 Phase 19.6 — every archetype ships a hand-authored soul-file
  // markdown with `{{NAME}}` placeholder. Substitute the chosen name so
  // the profile lands with a real persona instead of `soulFile: null`,
  // which is the trigger for `onboarding_status` to nudge the model
  // toward `regenerate_soul` on the very first turn.
  const soulFile =
    block.personality !== undefined || personalityEntry.soulFile === undefined
      ? undefined
      : personalityEntry.soulFile.replaceAll("{{NAME}}", name);
  const voice =
    block.voice ?? (voicePool.length > 0 ? pick(rng, voicePool).id : undefined);
  // Model selection is provider-priority based, not randomized. Randomizing
  // persona/name/voice is good; randomly choosing a lower-priority LLM when a
  // better configured provider is loaded is surprising and makes smoke tests
  // look broken (e.g. seed 42 repeatedly landing on Fireworks GLM).
  const defaultModel =
    block.defaultModel ??
    (modelPool.length > 0 ? modelPool[0] : undefined);

  let avatar: GenieAvatarValue | undefined = block.avatar;
  if (!avatar) {
    const presetId = pick(rng, PRESET_IDS);
    avatar = { kind: "preset", presetId };
  }

  return {
    name,
    voice,
    defaultModel,
    personality,
    soulFile,
    avatar,
  };
}
