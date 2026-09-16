import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import appConfig from "../../app.json";

const pluginPath = path.resolve(import.meta.dir, "../../plugins/with-nautilo-share-handoff.js");
const moduleRoot = path.resolve(import.meta.dir, "../../modules/nautilo-share-handoff");
const requireFromThisFile = createRequire(import.meta.url);
const plugin = requireFromThisFile(pluginPath) as {
  constants: {
    CAPTURE: string;
    MAX_TEXT_OR_URL_BYTES: number;
    MAX_INBOUND_FILE_BYTES: number;
    FILE_PREFERENCES_NAME: string;
  };
  patchMainActivity(source: string): string;
};

describe("native share handoff", () => {
  test("declares compact supported Android MIME families without a universal receiver", () => {
    const filters = appConfig.expo.android.intentFilters;
    expect(filters).toHaveLength(1);
    expect(filters).toMatchObject([{
      action: "SEND",
      category: ["DEFAULT"],
    }]);
    const declared = filters[0]?.data?.map(({ mimeType }) => mimeType).sort();
    expect(declared).toEqual([
      "application/json",
      "application/octet-stream",
      "application/pdf",
      "application/toml",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/x-ndjson",
      "application/xml",
      "application/yaml",
      "audio/*",
      "image/*",
      "text/*",
      "video/mp4",
      "video/webm",
    ]);
    expect(declared).toContain("video/mp4");
    expect(declared).not.toContain("*/*");
  });

  test("captures cold and warm Android shares before OAuth can replace the Activity intent", () => {
    const pluginSource = readFileSync(pluginPath, "utf8");
    expect(pluginSource).toContain("override fun onNewIntent(intent: Intent)");
    expect(pluginSource).toContain("captureNautiloShareIntent(intent)");
    expect(pluginSource).toContain("setIntent(intent)");
    expect(pluginSource).toContain("override fun onCreate(savedInstanceState: Bundle?)");
    expect(plugin.constants.CAPTURE).toContain('getSharedPreferences("ai.nautilo.share.handoff.v1", Context.MODE_PRIVATE)');
    expect(plugin.constants.CAPTURE).toContain("UUID.randomUUID().toString()");
    expect(plugin.constants.CAPTURE).toContain("preferences.getString(\"value\", null) == value");
    expect(plugin.constants.CAPTURE).toContain(".commit()");
    expect(plugin.constants.CAPTURE).toContain("intent.hasExtra(Intent.EXTRA_STREAM)");
    expect(plugin.constants.CAPTURE).toContain("intent.clipData?.itemCount != 1");
    expect(plugin.constants.CAPTURE).toContain("FileOutputStream(temporary)");
    expect(plugin.constants.CAPTURE).toContain("output.fd.sync()");
    expect(plugin.constants.CAPTURE).toContain("copied > 104857600");
    expect(plugin.constants.CAPTURE).toContain("Never overwrite a receipt JS has not yet securely staged");
  });

  test("upgrades the prior warm-intent patch instead of leaving an undefined capture helper", () => {
    const priorOutput = `import android.content.Intent
import android.os.Build

class MainActivity {
  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    // Set the theme
  }
}`;
    const output = plugin.patchMainActivity(priorOutput);
    expect(output).toContain("private fun captureNautiloShareIntent");
    expect(output).toContain("captureNautiloShareIntent(intent)\n    // Set the theme");
    expect(output.match(/private fun captureNautiloShareIntent/g)?.length).toBe(1);
    expect(output.match(/override fun onNewIntent/g)?.length).toBe(1);
    expect(output.match(/captureNautiloShareIntent\(intent\)/g)?.length).toBe(2);
    expect(output).toContain("captureNautiloShareIntent(intent)\n    super.onNewIntent(intent)");
    expect(plugin.patchMainActivity(output)).toBe(output);
  });

  test("uses the same post-custody acknowledgement shape on iOS and Android", () => {
    const ios = readFileSync(path.join(moduleRoot, "ios/NautiloShareHandoffModule.swift"), "utf8");
    const android = readFileSync(path.join(moduleRoot, "android/src/main/java/ai/nautilo/sharehandoff/NautiloShareHandoffModule.kt"), "utf8");
    expect(ios).toContain('"ai.nautilo.share.pending-v1"');
    expect(ios).toContain("record[\"id\"] as? String == id");
    expect(ios).toContain("removeObject(forKey: payloadKey)");
    expect(android).toContain('const val PREFERENCES_NAME = "ai.nautilo.share.handoff.v1"');
    expect(android).toContain("preferences.getString(ID_KEY, null) != id");
    expect(android).toContain(".commit()");
    expect(android).not.toContain("getStringExtra(Intent.EXTRA_TEXT)");
    expect(android).not.toContain("java.time.Instant");
    expect(android).not.toContain("URLSession");
    expect(android).not.toContain("Authorization");
  });

  test("keeps binary Android receipts private, opaque, bounded, and separate from text peek", () => {
    const android = readFileSync(path.join(moduleRoot, "android/src/main/java/ai/nautilo/sharehandoff/NautiloShareHandoffModule.kt"), "utf8");
    const manifest = readFileSync(path.join(moduleRoot, "android/src/main/AndroidManifest.xml"), "utf8");
    const fileProviderPaths = readFileSync(path.join(moduleRoot, "android/src/main/res/xml/nautilo_share_handoff_paths.xml"), "utf8");
    expect(plugin.constants.MAX_INBOUND_FILE_BYTES).toBe(100 * 1024 * 1024);
    expect(android).toContain('const val FILE_PREFERENCES_NAME = "ai.nautilo.share.handoff.file.v1"');
    expect(android).toContain('AsyncFunction("peekInboundFileAsync")');
    expect(android).toContain('AsyncFunction("openInboundFileAsync")');
    expect(android).toContain('AsyncFunction("ackInboundFileAsync")');
    expect(android).toContain('AsyncFunction("discardInboundFileAsync")');
    expect(android).toContain('"nativeReceiptId" to nativeReceiptId');
    expect(android).not.toContain('"uri" to');
    expect(android).not.toContain('"path" to');
    expect(android).not.toContain('"base64" to');
    expect(android).toContain("clearInboundFilePreferences(preferences)");
    expect(android).toContain("inboundInbox(context).listFiles()");
    expect(manifest).toContain('android:name="androidx.core.content.FileProvider"');
    expect(manifest).toContain('android:exported="false"');
    // AndroidX FileProvider rejects installation unless its URI grant contract
    // is enabled. The provider remains non-exported, and only the native
    // `openInboundFileAsync` escape hatch ever returns a URI.
    expect(manifest).toContain('android:grantUriPermissions="true"');
    expect(fileProviderPaths).toContain('path="nautilo-share-handoff/"');
  });

  test("gives iOS the same opaque bounded binary receipt lifecycle", () => {
    const ios = readFileSync(path.join(moduleRoot, "ios/NautiloShareHandoffModule.swift"), "utf8");
    expect(ios).toContain('private let filePayloadKey = "ai.nautilo.share.pending-file-v1"');
    expect(ios).toContain('AsyncFunction("peekInboundFileAsync")');
    expect(ios).toContain('AsyncFunction("openInboundFileAsync")');
    expect(ios).toContain('AsyncFunction("ackInboundFileAsync")');
    expect(ios).toContain('AsyncFunction("discardInboundFileAsync")');
    expect(ios).toContain('"nativeReceiptId": nativeReceiptId');
    expect(ios).toContain('return ["contentUri": file.absoluteString]');
    expect(ios).not.toContain('"uri":');
    expect(ios).not.toContain('"path":');
    expect(ios).not.toContain('"base64":');
  });

  test("treats native intake as bounded candidate custody, never canonical Workspace or Room admission", () => {
    const pluginSource = readFileSync(pluginPath, "utf8");
    expect(pluginSource).toContain("private fun isNautiloShareCandidate");
    expect(pluginSource).not.toContain("isNautiloWorkspaceEligibleShare");
    expect(pluginSource).toContain("not canonical upload or Room admission");
    expect(pluginSource).toContain("server's classifyArtifactUpload");
    expect(pluginSource).toContain("Room attachment policy");
    expect(pluginSource).toContain("mimeType == \"application/octet-stream\") return extension in setOf");
    expect(pluginSource).toContain("mimeType == \"image/svg+xml\"");
    expect(pluginSource).toContain("mimeType.contains(\"zip\")");
  });

  test("keeps the Android share boundary byte-bounded, CharSequence-safe, and API-24 timestamp-safe", () => {
    const android = readFileSync(path.join(moduleRoot, "android/src/main/java/ai/nautilo/sharehandoff/NautiloShareHandoffModule.kt"), "utf8");
    expect(plugin.constants.CAPTURE).toContain("getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()?.trim()");
    expect(plugin.constants.MAX_TEXT_OR_URL_BYTES).toBe(1024);
    expect(plugin.constants.CAPTURE).toContain("value.toByteArray(Charsets.UTF_8).size > 1024");
    expect(android).toContain("SimpleDateFormat(\"yyyy-MM-dd'T'HH:mm:ss.SSS'Z'\", Locale.US)");
    expect(android).toContain("TimeZone.getTimeZone(\"UTC\")");
    expect(android).not.toContain("java.time.");
  });

  test("keeps destination choice exact and routes native back through durable cancel", () => {
    const screen = readFileSync(path.resolve(import.meta.dir, "../app/share.tsx"), "utf8");
    const inbound = readFileSync(path.resolve(import.meta.dir, "../providers/inbound-intent.native.tsx"), "utf8");
    const layout = readFileSync(path.resolve(import.meta.dir, "../app/_layout.tsx"), "utf8");
    expect(screen).toContain("servers.map");
    expect(screen).toContain("await switchTo(serverId)");
    expect(screen).toContain("getApiClient(activeServer.serverUrl).listRooms()");
    expect(screen).toContain("getApiClient(activeServer.serverUrl).whoami()");
    expect(screen).toContain("const scope = { serverId: activeServer.id, viewerId }");
    expect(screen).toContain("claimPendingShare(scope)");
    expect(screen).toContain("claimInboundShareReceipt(scope)");
    expect(screen).toContain("saveRoomDraftSnapshot");
    expect(screen).toContain("uploadMessageAttachment");
    expect(screen).toContain("createWorkspaceArtifact");
    expect(screen).toContain("roomId: selectedId");
    expect(screen).toContain("Choose where it belongs");
    expect(screen).toContain("Workspace Files for the people in this conversation");
    expect(screen).toContain("deleteMessageAttachment");
    expect(inbound).toContain("stageNativeInboundFileReceipt");
    expect(inbound).toContain("saveInboundShareReceipt");
    expect(inbound).toContain("claimInboundShareReceipt");
    expect(screen).not.toContain("loadPendingShare");
    expect(screen).toContain('BackHandler.addEventListener("hardwareBackPress"');
    expect(screen).toContain("await clearPendingShare()");
    expect(screen).toContain('router.replace("/(drawer)/(tabs)")');
    expect(screen).not.toContain("router.back()");
    expect(layout).toContain('name="share"');
    expect(layout).toContain("gestureEnabled: false");
  });
});
