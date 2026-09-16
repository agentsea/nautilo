import { beforeEach, expect, mock, test } from "bun:test";

type Button = Readonly<{ text: string; style?: string; onPress?: () => void }>;

let platform = "ios";
let shareAvailable = true;
let presented: Readonly<{ title: string; message?: string; buttons: readonly Button[] }> | undefined;

mock.module("react-native", () => ({
  Alert: {
    alert: (title: string, message?: string, buttons: readonly Button[] = []) => {
      presented = { title, message, buttons };
    },
  },
  Platform: { get OS() { return platform; } },
}));
mock.module("@/lib/original-file-share", () => ({ canShareOriginalFile: () => shareAvailable && platform === "ios" }));

const { showArtifactExportMenu } = await import("./artifact-export-menu.native");

beforeEach(() => {
  platform = "ios";
  shareAvailable = true;
  presented = undefined;
});

test("iOS offers file, share, and Photos for media originals", () => {
  const exports: string[] = [];
  showArtifactExportMenu({ filename: "portrait.png", mimeType: "image/png", onExport: (destination) => exports.push(destination) });

  expect(presented?.title).toBe("portrait.png");
  expect(presented?.buttons.map((button) => button.text)).toEqual(["Save file…", "Share…", "Save to Photos", "Cancel"]);
  presented?.buttons.slice(0, 3).forEach((button) => button.onPress?.());
  expect(exports).toEqual(["file", "share", "media"]);
});

test("Android routes sharing through Files and offers Gallery only for media", () => {
  platform = "android";
  const exports: string[] = [];
  showArtifactExportMenu({ filename: "clip.mp4", mimeType: "video/mp4", onExport: (destination) => exports.push(destination) });

  expect(presented?.message).toContain("Android Files");
  expect(presented?.buttons.map((button) => button.text)).toEqual(["Save file…", "Save to Gallery", "Cancel"]);
  presented?.buttons.slice(0, 2).forEach((button) => button.onPress?.());
  expect(exports).toEqual(["file", "media"]);
});

test("non-media originals omit the library destination", () => {
  shareAvailable = false;
  showArtifactExportMenu({ filename: "notes.pdf", mimeType: "application/pdf", onExport: () => {} });

  expect(presented?.buttons.map((button) => button.text)).toEqual(["Save file…", "Cancel"]);
  expect(presented?.buttons.at(-1)?.style).toBe("cancel");
});
