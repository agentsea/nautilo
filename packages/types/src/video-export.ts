/** One export contract for the editor, Genie commands and native renderer. */
export type VideoExportSettings = Readonly<{
  resolution: "720p" | "1080p" | "4k";
  quality: "smaller" | "balanced" | "high" | "custom";
  audioBitrateKbps: 128 | 192 | 320;
  videoBitrateKbps?: number;
}>;

/** Self-contained so the sandbox bridge can embed this exact validator. */
export function normalizeVideoExportSettings(value: unknown): VideoExportSettings | null {
  if (value === undefined) return { resolution: "1080p", quality: "balanced", audioBitrateKbps: 192 };
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some((key) => !["resolution", "quality", "audioBitrateKbps", "videoBitrateKbps"].includes(key))) return null;
  const resolution = v["resolution"] === undefined ? "1080p" : v["resolution"];
  const quality = v["quality"] === undefined ? "balanced" : v["quality"];
  const audioBitrateKbps = v["audioBitrateKbps"] === undefined ? 192 : v["audioBitrateKbps"];
  const bitrate = v["videoBitrateKbps"];
  if (!["720p", "1080p", "4k"].includes(resolution as string) ||
      !["smaller", "balanced", "high", "custom"].includes(quality as string) ||
      ![128, 192, 320].includes(audioBitrateKbps as number)) return null;
  if (quality === "custom"
    ? typeof bitrate !== "number" || bitrate <= 0 || !Number.isSafeInteger(bitrate * 1000)
    : bitrate !== undefined) return null;
  return { resolution, quality, audioBitrateKbps, ...(quality === "custom" ? { videoBitrateKbps: bitrate } : {}) } as VideoExportSettings;
}

export function videoExportDimensions(settings: VideoExportSettings): { width: number; height: number } {
  return settings.resolution === "720p" ? { width: 1280, height: 720 }
    : settings.resolution === "4k" ? { width: 3840, height: 2160 } : { width: 1920, height: 1080 };
}

export function videoExportCodecArgs(settings: VideoExportSettings, encoder: "libx264" | "videotoolbox" = "libx264"): string[] {
  // Mac VideoToolbox uses target bitrate on both Intel and Apple Silicon.
  // Presets are quality choices, not admission ceilings; custom remains exact.
  if (encoder === "videotoolbox") {
    const targets = { "720p": [2_000, 4_000, 6_000], "1080p": [4_000, 8_000, 12_000], "4k": [10_000, 20_000, 35_000] } as const;
    const kbps = settings.quality === "custom" ? settings.videoBitrateKbps!
      : targets[settings.resolution][settings.quality === "smaller" ? 0 : settings.quality === "high" ? 2 : 1];
    return ["-b:v", String(kbps * 1000), "-b:a", `${settings.audioBitrateKbps}k`];
  }
  // Named, overridable quality presets, not media admission ceilings. CRF 23
  // preserves the previous export quality; custom uses FFmpeg's target bitrate.
  const video = settings.quality === "custom"
    ? ["-b:v", String(settings.videoBitrateKbps! * 1000)]
    : ["-crf", String(settings.quality === "high" ? 18 : settings.quality === "smaller" ? 28 : 23)];
  return [...video, "-b:a", `${settings.audioBitrateKbps}k`];
}
