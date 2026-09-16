const { withAndroidManifest } = require("expo/config-plugins");

/**
 * Android 10+ inserts app-owned media without any library permission.
 * @param {import('@expo/config-plugins').AndroidConfig.Manifest.AndroidManifest['manifest']} manifest
 */
function addLegacyMediaWritePermission(manifest) {
  manifest.$ = { ...manifest.$, "xmlns:tools": "http://schemas.android.com/tools" };
  const permissions = manifest["uses-permission"] ?? [];
  manifest["uses-permission"] = permissions.filter(
    (permission) => permission.$?.["android:name"] !== "android.permission.WRITE_EXTERNAL_STORAGE",
  );
  const legacyWritePermission = {
    $: { "android:name": "android.permission.WRITE_EXTERNAL_STORAGE", "android:maxSdkVersion": "28", "tools:replace": "android:maxSdkVersion" },
  };
  manifest["uses-permission"].push(legacyWritePermission);
  return manifest;
}

module.exports = (/** @type {import('@expo/config-types').ExpoConfig} */ config) => withAndroidManifest(config, (modConfig) => {
  addLegacyMediaWritePermission(modConfig.modResults.manifest);
  return modConfig;
});
module.exports.addLegacyMediaWritePermission = addLegacyMediaWritePermission;
