const { withDangerousMod } = require("expo/config-plugins");
const fs = require("node:fs/promises");
const path = require("node:path");
const {
  writeDebugLoopbackNetworkPolicy,
} = require("./with-nautilo-local-dev-network");

// This plugin exists solely for the Stack 309 local Android acceptance run.
// It writes only `src/debug`; release/main artifacts must never contain this
// receiver or a staged-invite path.
const DEBUG_RECEIVER_ACTION = "ai.nautilo.app.debug.action.CONSUME_STACK309_INVITE";
const DEBUG_RECEIVER_CLASS = ".Stack309InviteHarnessReceiver";
const STAGED_FILENAME = "stack309-invite.staged";
const TEST_APPLICATION_ID = "ai.nautilo.app.test";
const TEST_INPUT_METHOD_CLASS = "ai.nautilo.app.Stack309SecureInputMethodService";
const TEST_INPUT_ACTION = "ai.nautilo.app.test.action.COMMIT_STACK309_INPUT";

const DEBUG_RECEIVER = `        <receiver
            android:name="${DEBUG_RECEIVER_CLASS}"
            android:exported="true">
            <intent-filter>
                <action android:name="${DEBUG_RECEIVER_ACTION}" />
            </intent-filter>
        </receiver>`;

const KOTLIN_SOURCE = `package ai.nautilo.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.net.Uri
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.UUID

/**
 * Debug-only acceptance harness. It receives no bearer data. The host streams
 * an invite locator into this app's private storage, then this receiver claims
 * and deletes it before starting Nautilo's ordinary internal invite deep link.
 */
class Stack309InviteHarnessReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != ACTION_CONSUME || intent.data != null || intent.extras != null || intent.clipData != null) return

    val staged = File(context.filesDir, STAGED_FILENAME)
    if (!staged.isFile) return
    val claimed = File(context.filesDir, ".stack309-invite-claimed-${'${'}UUID.randomUUID()}")
    // Both files live in app-private internal storage, so this claim is an
    // atomic rename and concurrent broadcasts cannot consume the same invite.
    if (!staged.renameTo(claimed)) return

    try {
      val locator = readBoundedLocator(claimed) ?: return
      val deepLink = canonicalInviteDeepLink(locator) ?: return
      context.startActivity(
        Intent(Intent.ACTION_VIEW, deepLink)
          .setPackage(context.packageName)
          .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
      )
    } finally {
      claimed.delete()
    }
  }

  private fun readBoundedLocator(file: File): String? {
    if (file.length() !in 1..MAX_LOCATOR_BYTES) return null
    val bytes = ByteArrayOutputStream()
    file.inputStream().use { input ->
      val buffer = ByteArray(1024)
      while (true) {
        val count = input.read(buffer)
        if (count < 0) break
        if (bytes.size() + count > MAX_LOCATOR_BYTES) return null
        bytes.write(buffer, 0, count)
      }
    }
    return bytes.toString(Charsets.UTF_8.name()).trim().takeIf { it.isNotEmpty() }
  }

  private fun canonicalInviteDeepLink(locator: String): Uri? {
    val source = try {
      Uri.parse(locator)
    } catch (_: Exception) {
      return null
    }
    val scheme = source.scheme?.lowercase() ?: return null
    if (scheme != "http" && scheme != "https") return null
    if (source.userInfo != null || source.query != null || source.fragment != null || source.host.isNullOrEmpty()) return null
    val segments = source.pathSegments
    if (segments.size != 2 || segments[0] != "redeem") return null
    val token = segments[1]
    if (!INVITE_TOKEN.matches(token)) return null
    val origin = "${'${'}source.scheme}://${'${'}source.encodedAuthority}"
    return Uri.Builder()
      .scheme("nautilo")
      .authority("invite")
      .appendQueryParameter("server", origin)
      .appendQueryParameter("token", token)
      .build()
  }

  private companion object {
    const val ACTION_CONSUME = "${DEBUG_RECEIVER_ACTION}"
    const val STAGED_FILENAME = "${STAGED_FILENAME}"
    const val MAX_LOCATOR_BYTES = 8192
    val INVITE_TOKEN = Regex("^inv_[A-Za-z0-9_-]+$")
  }
}
`;

const TEST_MANIFEST = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <application android:label="Stack 309 secure input">
        <service
            android:name="${TEST_INPUT_METHOD_CLASS}"
            android:exported="true"
            android:permission="android.permission.BIND_INPUT_METHOD">
            <intent-filter>
                <action android:name="android.view.InputMethod" />
            </intent-filter>
            <meta-data
                android:name="android.view.im"
                android:resource="@xml/stack309_input_method" />
        </service>
    </application>
</manifest>
`;

const TEST_INPUT_METHOD_XML = `<?xml version="1.0" encoding="utf-8"?>
<input-method xmlns:android="http://schemas.android.com/apk/res/android"
    android:supportsSwitchingToNextInputMethod="false" />
`;

const SECURE_INPUT_METHOD = `package ai.nautilo.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.inputmethodservice.InputMethodService;
import android.os.Build;
import android.text.InputType;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputConnection;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;

/**
 * Emulator-only secure-field acceptance bridge. It is an input method so the
 * same private fixture path works in Nautilo and in the hosted browser signup
 * form. The fixture is deleted before commit and never crosses adb arguments,
 * logs, clipboard state, screenshots, or production app artifacts.
 */
public final class Stack309SecureInputMethodService extends InputMethodService {
  private static final String ACTION_COMMIT = "${TEST_INPUT_ACTION}";
  private static final String SUCCESS_MARKER = "stack309-input.ok";
  private static final long MAX_SECRET_BYTES = 128L;
  private static final String[] STAGED_FILES = new String[] {
    "stack309-handle-input.staged",
    "stack309-password-input.staged",
    "stack309-pin-input.staged",
  };
  private static final Pattern HANDLE = Pattern.compile("^[a-z0-9_]{3,32}$");
  private static final Pattern PASSWORD = Pattern.compile("^[A-Za-z0-9_-]{12,64}$");
  private static final Pattern PIN = Pattern.compile("^\\\\d{6}$");

  private final BroadcastReceiver commitReceiver = new BroadcastReceiver() {
    @Override public void onReceive(Context context, Intent intent) {
      if (!ACTION_COMMIT.equals(intent.getAction()) || intent.getData() != null
          || intent.getExtras() != null || intent.getClipData() != null) return;
      commitFixture();
    }
  };

  @Override public void onCreate() {
    super.onCreate();
    IntentFilter filter = new IntentFilter(ACTION_COMMIT);
    if (Build.VERSION.SDK_INT >= 33) registerReceiver(commitReceiver, filter, Context.RECEIVER_EXPORTED);
    else registerReceiver(commitReceiver, filter);
  }

  @Override public void onDestroy() {
    unregisterReceiver(commitReceiver);
    super.onDestroy();
  }

  private void commitFixture() {
    String value = null;
    try {
      new File(getFilesDir(), SUCCESS_MARKER).delete();
      File fixture = claimSingleFixture();
      if (fixture == null) return;
      value = readFixture(fixture);
      fixture.delete();
      if (value == null || !validFixture(fixture.getName(), value)
          || !validEditor(fixture.getName(), getCurrentInputEditorInfo())) return;
      InputConnection connection = getCurrentInputConnection();
      if (connection != null && connection.commitText(value, 1)) {
        new File(getFilesDir(), SUCCESS_MARKER).createNewFile();
      }
    } catch (Throwable ignored) {
      // Fail closed. The host verifies the zero-byte success marker.
    } finally {
      value = null;
      for (String name : STAGED_FILES) new File(getFilesDir(), name).delete();
    }
  }

  private File claimSingleFixture() {
    List<File> present = new ArrayList<>();
    for (String name : STAGED_FILES) {
      File file = new File(getFilesDir(), name);
      if (file.isFile()) present.add(file);
    }
    if (present.size() != 1) {
      for (File file : present) file.delete();
      return null;
    }
    File staged = present.get(0);
    if (staged.length() < 1 || staged.length() > MAX_SECRET_BYTES) {
      staged.delete();
      return null;
    }
    File claimed = new File(getFilesDir(), "." + staged.getName() + ".claimed");
    claimed.delete();
    return staged.renameTo(claimed) ? claimed : null;
  }

  private String readFixture(File fixture) throws Exception {
    ByteArrayOutputStream bytes = new ByteArrayOutputStream();
    try (FileInputStream input = new FileInputStream(fixture)) {
      byte[] buffer = new byte[128];
      int count;
      while ((count = input.read(buffer)) >= 0) {
        if (bytes.size() + count > MAX_SECRET_BYTES) return null;
        bytes.write(buffer, 0, count);
      }
    }
    String value = new String(bytes.toByteArray(), StandardCharsets.UTF_8).trim();
    return value.isEmpty() ? null : value;
  }

  private boolean validFixture(String claimedName, String value) {
    if (claimedName.contains("handle")) return HANDLE.matcher(value).matches();
    if (claimedName.contains("password")) return PASSWORD.matcher(value).matches();
    if (claimedName.contains("pin")) return PIN.matcher(value).matches();
    return false;
  }

  private boolean validEditor(String claimedName, EditorInfo editor) {
    if (editor == null) return false;
    int inputClass = editor.inputType & InputType.TYPE_MASK_CLASS;
    int variation = editor.inputType & InputType.TYPE_MASK_VARIATION;
    if (claimedName.contains("password")) {
      return inputClass == InputType.TYPE_CLASS_TEXT
        && (variation == InputType.TYPE_TEXT_VARIATION_PASSWORD
          || variation == InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD
          || variation == InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD);
    }
    if (claimedName.contains("pin")) {
      return inputClass == InputType.TYPE_CLASS_NUMBER;
    }
    return claimedName.contains("handle") && inputClass == InputType.TYPE_CLASS_TEXT
      && variation != InputType.TYPE_TEXT_VARIATION_PASSWORD
      && variation != InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD
      && variation != InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD;
  }
}
`;

function mergeReceiverIntoDebugManifest(debugManifest) {
  if (debugManifest.includes(DEBUG_RECEIVER_ACTION)) return debugManifest;
  const application = /<application([^>]*)\/>/;
  if (!application.test(debugManifest)) {
    throw new Error("Stack 309 debug invite harness requires the debug network manifest");
  }
  return debugManifest.replace(application, `<application$1>\n${DEBUG_RECEIVER}\n    </application>`);
}

async function writeDebugInviteHarness(projectRoot) {
  // Reuse the established debug-only localhost policy, then augment that one
  // debug overlay rather than ever touching the production manifest.
  await writeDebugLoopbackNetworkPolicy(projectRoot);
  const debugRoot = path.join(projectRoot, "android", "app", "src", "debug");
  const manifestPath = path.join(debugRoot, "AndroidManifest.xml");
  const sourceRoot = path.join(debugRoot, "java", "ai", "nautilo", "app");
  const androidTestRoot = path.join(projectRoot, "android", "app", "src", "androidTest");
  const inputMethodRoot = path.join(androidTestRoot, "java", "ai", "nautilo", "app");
  const inputMethodResources = path.join(androidTestRoot, "res", "xml");
  const debugManifest = await fs.readFile(manifestPath, "utf8");
  await fs.mkdir(sourceRoot, { recursive: true });
  await fs.mkdir(inputMethodRoot, { recursive: true });
  await fs.mkdir(inputMethodResources, { recursive: true });
  await Promise.all([
    fs.writeFile(manifestPath, mergeReceiverIntoDebugManifest(debugManifest)),
    fs.writeFile(path.join(sourceRoot, "Stack309InviteHarnessReceiver.kt"), KOTLIN_SOURCE),
    fs.writeFile(path.join(androidTestRoot, "AndroidManifest.xml"), TEST_MANIFEST),
    fs.writeFile(
      path.join(inputMethodRoot, "Stack309SecureInputMethodService.java"),
      SECURE_INPUT_METHOD,
    ),
    fs.writeFile(path.join(inputMethodResources, "stack309_input_method.xml"), TEST_INPUT_METHOD_XML),
  ]);
}

module.exports = (config) => withDangerousMod(config, ["android", async (modConfig) => {
  await writeDebugInviteHarness(modConfig.modRequest.projectRoot);
  return modConfig;
}]);

module.exports.constants = {
  DEBUG_RECEIVER_ACTION,
  DEBUG_RECEIVER_CLASS,
  STAGED_FILENAME,
  DEBUG_RECEIVER,
  KOTLIN_SOURCE,
  TEST_APPLICATION_ID,
  TEST_INPUT_METHOD_CLASS,
  TEST_INPUT_ACTION,
  TEST_MANIFEST,
  TEST_INPUT_METHOD_XML,
  SECURE_INPUT_METHOD,
};
module.exports.writeDebugInviteHarness = writeDebugInviteHarness;
module.exports.mergeReceiverIntoDebugManifest = mergeReceiverIntoDebugManifest;
