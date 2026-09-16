import { afterEach, expect, test } from "bun:test";
import { spawnSync, execFile } from "node:child_process";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { testFfmpegPath } from "../helpers/test-ffmpeg";

const exec = promisify(execFile);
const enabled = process.env["NAUTILO_VIDEO_TEXT_PIXEL_TEST"] === "1";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fsp.rm(root, { recursive: true, force: true }); });

test.skipIf(!enabled)("real isolated Chromium text captures burn into timed transparent MP4 layers", async () => {
  const ffmpeg = testFfmpegPath();
  const electron = createRequire(import.meta.url)("electron") as string;
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "nautilo-text-pixels-")); roots.push(root);
  const built = await Bun.build({ entrypoints: [path.resolve(import.meta.dir, "../fixtures/sequence-text-electron.ts")], target: "node", format: "cjs", external: ["electron"], outdir: root, naming: "fixture.cjs" });
  expect(built.success).toBe(true);
  await exec(ffmpeg, ["-hide_banner", "-y", "-f", "lavfi", "-i", "color=blue:s=640x360:d=0.1", "-frames:v", "1", path.join(root, "blue.png")]);
  // Explicit opt-in: this launches a hidden, non-activatable test process with
  // an ephemeral profile. It never touches the installed app or live stack.
  const env = { ...process.env }; delete env["ELECTRON_RUN_AS_NODE"];
  await exec(electron, [path.join(root, "fixture.cjs"), root, ffmpeg], { env, timeout: 45_000 });
  expect(JSON.parse(await fsp.readFile(path.join(root, "result.json"), "utf8"))).toMatchObject({ result: { status: "succeeded" }, overflow: true, windowsRemaining: 0 });
  expect(await fsp.access(path.join(root, "overflow.png")).then(() => true, () => false)).toBe(false);
  const pixels = (input: string, seconds?: number) => {
    const result = spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", ...(seconds === undefined ? [] : ["-ss", String(seconds)]), "-i", input, "-frames:v", "1", "-vf", "format=rgba", "-f", "rawvideo", "pipe:1"], { maxBuffer: 640 * 360 * 4 * 2 });
    expect(result.status).toBe(0); expect(result.stdout.length).toBe(640 * 360 * 4);
    return result.stdout;
  };
  const pngs = ["text", "caption", "callout"].map((kind) => pixels(path.join(root, `${kind}.png`)));
  for (const png of pngs) {
    expect(png[3]).toBe(0); // transparent corners, not a black title card
    let painted = 0; for (let at = 3; at < png.length; at += 4) if (png[at]! > 0) painted++;
    expect(painted).toBeGreaterThan(100);
  }
  const yExtent = (png: Buffer) => {
    const ys: number[] = [];
    for (let at = 3; at < png.length; at += 4) if (png[at]! > 0) ys.push(Math.floor(at / 4 / 640));
    return [Math.min(...ys), Math.max(...ys)];
  };
  expect(yExtent(pngs[0]!)[0]!).toBeGreaterThan(120);
  expect(yExtent(pngs[1]!)[0]!).toBeGreaterThan(260);
  expect(yExtent(pngs[1]!)[1]!).toBeLessThan(343);
  const output = path.join(root, "text.mp4");
  for (const [index, seconds] of [0.1, 0.35, 0.6].entries()) {
    const frame = pixels(output, seconds); const png = pngs[index]!;
    let totalDifference = 0;
    for (let at = 0; at < frame.length; at += 4) {
      const alpha = png[at + 3]! / 255;
      for (let c = 0; c < 3; c++) totalDifference += Math.abs(frame[at + c]! - (png[at + c]! * alpha + (c === 2 ? 255 : 0) * (1 - alpha)));
    }
    expect(totalDifference / (640 * 360 * 3)).toBeLessThan(5); // lossy H.264, same raster/layout
  }
  const gap = pixels(output, 0.85);
  expect(gap[0]!).toBeLessThan(10); expect(gap[2]!).toBeGreaterThan(240);
}, 60_000);
