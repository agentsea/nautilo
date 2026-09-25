import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { parseCaptureArgs, parsePngDimensions } from "./capture.ts";
import { BROWSER_VISUAL_GROUNDING_SCHEMA_VERSION, parseCorpusIndex } from "./schema.ts";

const casesRoot = path.join(import.meta.dir, "cases");
const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

describe("browser visual-grounding corpus", () => {
  it("accepts explicit safe capture arguments", () => {
    expect(parseCaptureArgs([
      "--id", "gym-click-button",
      "--description", "AgentSea Gym click-button initial state",
      "--profile", "/tmp/Nautilo-qa",
    ])).toEqual({
      id: "gym-click-button",
      description: "AgentSea Gym click-button initial state",
      profileDir: "/tmp/Nautilo-qa",
    });
    expect(() => parseCaptureArgs([
      "--id", "../escape", "--description", "unsafe", "--profile", "/tmp/Nautilo-qa",
    ])).toThrow();
  });

  it("validates every indexed paired capture and rejects orphan directories", async () => {
    const index = parseCorpusIndex(JSON.parse(await readFile(path.join(casesRoot, "manifest.json"), "utf8")));
    const directoryEntries = (await readdir(casesRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort();
    expect(directoryEntries).toEqual(index.cases.map(({ id }) => id));

    for (const { id } of index.cases) {
      const root = path.join(casesRoot, id);
      const metadata = JSON.parse(await readFile(path.join(root, "case.json"), "utf8")) as Record<string, unknown>;
      const snapshot = new Uint8Array(await readFile(path.join(root, "snapshot.txt")));
      const screenshot = new Uint8Array(await readFile(path.join(root, "screenshot.png")));
      const snapshotMetadata = metadata["snapshot"] as Record<string, unknown>;
      const screenshotMetadata = metadata["screenshot"] as Record<string, unknown>;
      const viewport = metadata["viewport"] as Record<string, unknown>;
      const image = viewport["image"] as Record<string, unknown>;
      expect(metadata["schemaVersion"]).toBe(BROWSER_VISUAL_GROUNDING_SCHEMA_VERSION);
      expect(metadata["id"]).toBe(id);
      expect(snapshotMetadata["bytes"]).toBe(snapshot.byteLength);
      expect(snapshotMetadata["sha256"]).toBe(digest(snapshot));
      expect(screenshotMetadata["bytes"]).toBe(screenshot.byteLength);
      expect(screenshotMetadata["sha256"]).toBe(digest(screenshot));
      const width = image["width"];
      const height = image["height"];
      if (typeof width !== "number" || typeof height !== "number") throw new Error(`Case ${id} has invalid image dimensions`);
      expect(parsePngDimensions(screenshot)).toEqual({ width, height });
    }
  });
});
