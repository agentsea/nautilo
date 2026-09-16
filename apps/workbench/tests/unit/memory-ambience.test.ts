import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  AMBIENCE_PRESETS,
  ambienceStorageKey,
  loadAmbience,
  prefersReducedMotion,
  saveAmbience,
  settingsForPreset,
} from "../../src/pages/memory/memory-ambience";
import { installLocalStorageShim } from "../../src/test-helpers/local-storage-shim";

const USER = "550e8400-e29b-41d4-a716-446655440000";

describe("memory-ambience presets", () => {
  test("Standard matches operator baseline", () => {
    expect(AMBIENCE_PRESETS.standard).toEqual({
      density: 199,
      drift: 0.69,
      links: 23,
      glow: 2.0,
      hubPct: 16,
      hubSize: 4.1,
    });
  });

  test("Calm is fewer/slower/softer than Standard", () => {
    const calm = AMBIENCE_PRESETS.calm;
    const standard = AMBIENCE_PRESETS.standard;
    expect(calm.density).toBeLessThan(standard.density);
    expect(calm.drift).toBeLessThan(standard.drift);
    expect(calm.glow).toBeLessThan(standard.glow);
    expect(calm.hubPct).toBeLessThan(standard.hubPct);
    expect(calm.hubSize).toBeLessThan(standard.hubSize);
  });

  test("Lush is denser/brighter than Standard", () => {
    const lush = AMBIENCE_PRESETS.lush;
    const standard = AMBIENCE_PRESETS.standard;
    expect(lush.density).toBeGreaterThan(standard.density);
    expect(lush.drift).toBeGreaterThan(standard.drift);
    expect(lush.glow).toBeGreaterThan(standard.glow);
    expect(lush.links).toBeGreaterThan(standard.links);
  });

  test("settingsForPreset returns a copy", () => {
    const a = settingsForPreset("standard");
    const b = settingsForPreset("standard");
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    a.density = 1;
    expect(settingsForPreset("standard").density).toBe(199);
  });
});

describe("memory-ambience persistence", () => {
  beforeAll(() => {
    installLocalStorageShim();
  });

  beforeEach(() => {
    window.localStorage.clear();
  });

  test("storage key is namespaced per user", () => {
    expect(ambienceStorageKey(USER)).toBe(`nautilo:memory:ambience:${USER}`);
  });

  test("load defaults to standard when missing", () => {
    expect(loadAmbience(USER)).toBe("standard");
  });

  test("load tolerates invalid stored values", () => {
    window.localStorage.setItem(ambienceStorageKey(USER), "banana");
    expect(loadAmbience(USER)).toBe("standard");
  });

  test("save and load round-trip each preset", () => {
    for (const preset of ["calm", "standard", "lush", "off"] as const) {
      saveAmbience(USER, preset);
      expect(loadAmbience(USER)).toBe(preset);
    }
  });

  test("users do not share storage slots", () => {
    saveAmbience("user-a", "lush");
    saveAmbience("user-b", "calm");
    expect(loadAmbience("user-a")).toBe("lush");
    expect(loadAmbience("user-b")).toBe("calm");
  });
});

describe("prefersReducedMotion", () => {
  test("returns boolean without throwing", () => {
    expect(typeof prefersReducedMotion()).toBe("boolean");
  });
});
