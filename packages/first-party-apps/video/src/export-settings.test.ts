import { describe, expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { normalizeVideoExportSettings, videoExportCodecArgs, videoExportDimensions } from "@nautilo/types";
import { createEmptyProject } from "./edl";
import { buildSequenceRenderPlan } from "./render-plan";
import { parseMediaCommand } from "./media-agent";

describe("shared export settings", () => {
  test("defaults preserve quality and settings never mutate the saved project", () => {
    expect(normalizeVideoExportSettings(undefined)).toEqual({ resolution: "1080p", quality: "balanced", audioBitrateKbps: 192 });
    const project = createEmptyProject();
    project.sequences[0]!.durationSec = 1;
    project.sequences[0]!.frameRate = { numerator: 60000, denominator: 1001 };
    const before = JSON.stringify(project);
    for (const resolution of ["720p", "1080p", "4k"] as const) {
      const settings = normalizeVideoExportSettings({ resolution, quality: "high" })!;
      expect(buildSequenceRenderPlan(project, undefined, { exportSettings: settings })).toMatchObject({
        ok: true, plan: { ...videoExportDimensions(settings), frameRate: { numerator: 60000, denominator: 1001 }, exportSettings: settings },
      });
    }
    expect(JSON.stringify(project)).toBe(before);
  });

  test("presets and target bitrate generate mutually exclusive encoder options", () => {
    for (const [quality, crf] of [["smaller", "28"], ["balanced", "23"], ["high", "18"]] as const) {
      expect(videoExportCodecArgs(normalizeVideoExportSettings({ quality })!)).toEqual(["-crf", crf, "-b:a", "192k"]);
    }
    expect(videoExportCodecArgs(normalizeVideoExportSettings({ quality: "custom", videoBitrateKbps: 6750, audioBitrateKbps: 320 })!))
      .toEqual(["-b:v", "6750000", "-b:a", "320k"]);
  });

  test("invalid settings fail closed for humans and Genie commands", () => {
    for (const value of [null, [], "high", { resolution: null }, { quality: null }, { audioBitrateKbps: null },
      { resolution: "8k" }, { quality: "ultra" }, { audioBitrateKbps: 256 }, { ffmpegArgs: ["-i", "/secret"] },
      { quality: "custom" }, { videoBitrateKbps: 8000 }, ...[0, -1, NaN, Infinity, "8000", 0.0001].map(videoBitrateKbps => ({ quality: "custom", videoBitrateKbps }))]) {
      expect(normalizeVideoExportSettings(value)).toBeNull();
      expect(parseMediaCommand({ action: "export-media", publishToWorkspace: false, exportSettings: value })).toBeNull();
    }
    const command = parseMediaCommand({ action: "export-media", publishToWorkspace: false, exportSettings: { resolution: "720p" } });
    expect(command).toMatchObject({ exportSettings: { resolution: "720p", quality: "balanced", audioBitrateKbps: 192 } });
  });

  test("the sandbox embeds a self-contained validator", () => {
    const embedded = runInNewContext("(" + normalizeVideoExportSettings.toString() + ")") as typeof normalizeVideoExportSettings;
    expect(embedded({ quality: "custom", videoBitrateKbps: 0.001 })).toEqual({ resolution: "1080p", quality: "custom", videoBitrateKbps: 0.001, audioBitrateKbps: 192 });
    expect(embedded({ resolution: "wrong" })).toBeNull();
  });
});
