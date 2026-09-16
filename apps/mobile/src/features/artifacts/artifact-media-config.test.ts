import { expect, test } from "bun:test";
import config from "../../../app.json";
import { createRequire } from "node:module";
type Manifest = { $?: Record<string, string>; "uses-permission": Array<{ $: Record<string, string> }> };
const { addLegacyMediaWritePermission } = createRequire(import.meta.url)("../../../plugins/with-nautilo-media-export.js") as { addLegacyMediaWritePermission(manifest: Manifest): Manifest };

test("media export requests iOS add-only and restricts Android write permission to legacy devices", () => {
  expect(config.expo.ios.infoPlist.NSPhotoLibraryAddUsageDescription).toContain("photos and videos you choose");
  expect(config.expo.plugins).toContain("./plugins/with-nautilo-media-export");
  const manifest: Manifest = { "uses-permission": [{ $: { "android:name": "android.permission.INTERNET" } }] };
  addLegacyMediaWritePermission(manifest);
  addLegacyMediaWritePermission(manifest);
  expect(manifest["uses-permission"]).toEqual([
    { $: { "android:name": "android.permission.INTERNET" } },
    { $: { "android:name": "android.permission.WRITE_EXTERNAL_STORAGE", "android:maxSdkVersion": "28", "tools:replace": "android:maxSdkVersion" } },
  ]);
  expect(JSON.stringify(manifest)).not.toContain("READ_MEDIA");
  expect(JSON.stringify(manifest)).not.toContain("READ_EXTERNAL_STORAGE");
  expect(manifest.$?.["xmlns:tools"]).toBe("http://schemas.android.com/tools");
});
