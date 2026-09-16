export type AmbiencePreset = "calm" | "standard" | "lush" | "off";

export interface AmbienceSettings {
  density: number;
  drift: number;
  links: number;
  glow: number;
  hubPct: number;
  hubSize: number;
}

export const AMBIENCE_PRESETS: Record<Exclude<AmbiencePreset, "off">, AmbienceSettings> = {
  calm: { density: 90, drift: 0.3, links: 40, glow: 0.8, hubPct: 8, hubSize: 3.0 },
  standard: { density: 199, drift: 0.69, links: 23, glow: 2.0, hubPct: 16, hubSize: 4.1 },
  lush: { density: 320, drift: 0.9, links: 60, glow: 2.4, hubPct: 20, hubSize: 4.5 },
};

const STORAGE_KEY_PREFIX = "nautilo:memory:ambience:";

const VALID_PRESETS = new Set<AmbiencePreset>(["calm", "standard", "lush", "off"]);

export function ambienceStorageKey(userId: string): string {
  return `${STORAGE_KEY_PREFIX}${userId}`;
}

export function loadAmbience(userId: string): AmbiencePreset {
  if (typeof window === "undefined") return "standard";
  try {
    const raw = window.localStorage.getItem(ambienceStorageKey(userId));
    if (raw && VALID_PRESETS.has(raw as AmbiencePreset)) {
      return raw as AmbiencePreset;
    }
  } catch {
    // private browsing / quota — fall back to default
  }
  return "standard";
}

export function saveAmbience(userId: string, preset: AmbiencePreset): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(ambienceStorageKey(userId), preset);
  } catch {
    // tolerate storage failure
  }
}

export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

export function settingsForPreset(preset: Exclude<AmbiencePreset, "off">): AmbienceSettings {
  return { ...AMBIENCE_PRESETS[preset] };
}
