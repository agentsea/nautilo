import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { publishCaptureCase } from "./capture.ts";
import { BROWSER_VISUAL_GROUNDING_SCHEMA_VERSION, type BrowserVisualGroundingCase } from "./schema.ts";

const manifest: BrowserVisualGroundingCase = {
  schemaVersion: BROWSER_VISUAL_GROUNDING_SCHEMA_VERSION,
  id: "new-case",
  description: "Publication fixture",
  sourceUrl: "https://example.test/",
  capturedAt: "2026-01-01T00:00:00.000Z",
  captureDurationMs: 1,
  evidencePairWindowMs: 1,
  agentBrowserVersion: "fixture",
  viewport: {
    css: { width: 1, height: 1 },
    image: { width: 1, height: 1 },
    dpr: 1,
    imageToCssScale: 1,
  },
  refs: {},
  snapshot: { file: "snapshot.txt", bytes: 1, sha256: "fixture" },
  screenshot: { file: "screenshot.png", bytes: 1, sha256: "fixture" },
};

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "browser-capture-publication-"));
  const casesRoot = path.join(root, "cases");
  const screenshotPath = path.join(root, "screenshot.png");
  await mkdir(casesRoot);
  await writeFile(screenshotPath, new Uint8Array([7]));
  await writeFile(path.join(casesRoot, "manifest.json"), JSON.stringify({
    schemaVersion: BROWSER_VISUAL_GROUNDING_SCHEMA_VERSION,
    cases: [],
  }));
  return { root, casesRoot, screenshotPath };
}

async function expectFailure(promise: Promise<unknown>): Promise<void> {
  let failed = false;
  try {
    await promise;
  } catch {
    failed = true;
  }
  expect(failed).toBe(true);
}

describe("browser visual-grounding capture publication", () => {
  it("publishes one complete case and removes staging files", async () => {
    const { root, casesRoot, screenshotPath } = await fixture();
    try {
      const destination = await publishCaptureCase({
        casesRoot, manifest, snapshotBytes: new Uint8Array([5]), screenshotPath,
      });
      expect(destination).toBe(path.join(casesRoot, manifest.id));
      expect((await readdir(casesRoot)).sort()).toEqual(["manifest.json", "new-case"]);
      expect(await readFile(path.join(destination, "screenshot.png"))).toEqual(Buffer.from([7]));
      expect(JSON.parse(await readFile(path.join(casesRoot, "manifest.json"), "utf8"))).toEqual({
        schemaVersion: BROWSER_VISUAL_GROUNDING_SCHEMA_VERSION,
        cases: [{ id: manifest.id }],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("removes the newly created case if manifest update fails", async () => {
    const { root, casesRoot, screenshotPath } = await fixture();
    try {
      await writeFile(path.join(casesRoot, "manifest.json"), "not JSON");
      await expectFailure(publishCaptureCase({
        casesRoot, manifest, snapshotBytes: new Uint8Array([5]), screenshotPath,
      }));
      expect(await readdir(casesRoot)).toEqual(["manifest.json"]);
      expect(await readFile(path.join(casesRoot, "manifest.json"), "utf8")).toBe("not JSON");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("never replaces or removes a preexisting empty case directory", async () => {
    const { root, casesRoot, screenshotPath } = await fixture();
    try {
      const destination = path.join(casesRoot, manifest.id);
      await mkdir(destination);
      await expectFailure(publishCaptureCase({
        casesRoot, manifest, snapshotBytes: new Uint8Array([5]), screenshotPath,
      }));
      expect(existsSync(destination)).toBe(true);
      expect(await readdir(destination)).toEqual([]);
      expect((await readdir(casesRoot)).sort()).toEqual(["manifest.json", "new-case"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("cleans staging when a write fails before destination creation", async () => {
    const { root, casesRoot } = await fixture();
    try {
      await expectFailure(publishCaptureCase({
        casesRoot, manifest, snapshotBytes: new Uint8Array([5]),
        screenshotPath: path.join(root, "missing.png"),
      }));
      expect(await readdir(casesRoot)).toEqual(["manifest.json"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
