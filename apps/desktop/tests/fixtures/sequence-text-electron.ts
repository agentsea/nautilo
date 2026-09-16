/** Isolated pixel fixture. Never opens or authenticates a Nautilo window. */
import { app, BrowserWindow } from "electron";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { rasterizeSequenceText } from "../../electron/sequence-text-raster";
import { renderSequence, type SequenceRenderPlan } from "../../electron/sequence-renderer";

const root = process.argv[2]!;
const ffmpegPath = process.argv[3]!;
app.setPath("userData", path.join(root, "electron-profile"));
if (process.platform === "darwin") app.setActivationPolicy("prohibited");
app.disableHardwareAcceleration();
app.on("window-all-closed", () => { /* fixture owns its lifecycle */ });

void app.whenReady().then(async () => {
  try {
    for (const kind of ["text", "caption", "callout"] as const) {
      await rasterizeSequenceText({ kind, text: "Hello\nمرحبا 日本語 🎬", width: 640, height: 360, outputPath: path.join(root, `${kind}.png`) });
    }
    let overflow = false;
    try { await rasterizeSequenceText({ kind: "caption", text: "too tall\n".repeat(100), width: 640, height: 360, outputPath: path.join(root, "overflow.png") }); }
    catch (error) { overflow = error instanceof Error && error.message === "text_overflow"; }
    const plan: SequenceRenderPlan = { version: 1, durationSec: 1, width: 640, height: 360, frameRate: { numerator: 30, denominator: 1 }, layers: [
      { clipId: "background", kind: "image", trackKind: "video", mediaId: "blue", timelineStartSec: 0, durationSec: 1, sourceInSec: 0, visual: true, gain: 0 },
      ...(["text", "caption", "callout"] as const).map((kind, index) => ({ clipId: kind, kind, trackKind: "overlay" as const, text: "Hello\nمرحبا 日本語 🎬", timelineStartSec: index * 0.25, durationSec: 0.25, sourceInSec: 0, visual: true, gain: 0 })),
      { clipId: "hidden", kind: "caption", trackKind: "caption", text: "hidden\n".repeat(100), timelineStartSec: 0, durationSec: 1, sourceInSec: 0, visual: false, gain: 0 },
    ] };
    const result = await renderSequence(plan, { ffmpegPath, sources: new Map([["blue", { canonicalPath: path.join(root, "blue.png"), format: "png", hasVideo: true, hasAudio: false }]]), outputPath: path.join(root, "text.mp4") });
    await fs.writeFile(path.join(root, "result.json"), JSON.stringify({ result, overflow, windowsRemaining: BrowserWindow.getAllWindows().length }));
    app.exit(result.status === "succeeded" && overflow ? 0 : 1);
  } catch (error) {
    await fs.writeFile(path.join(root, "result.json"), JSON.stringify({ error: String(error) }));
    app.exit(1);
  }
});
