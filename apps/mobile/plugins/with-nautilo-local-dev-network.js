const { withDangerousMod } = require("expo/config-plugins");
const fs = require("node:fs/promises");
const path = require("node:path");

const DEBUG_MANIFEST = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    xmlns:tools="http://schemas.android.com/tools">
    <uses-permission android:name="android.permission.SYSTEM_ALERT_WINDOW" />
    <application
        android:networkSecurityConfig="@xml/nautilo_local_dev_network_security_config"
        tools:replace="android:networkSecurityConfig" />
</manifest>
`;

const NETWORK_SECURITY_CONFIG = `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <base-config cleartextTrafficPermitted="false" />
    <domain-config cleartextTrafficPermitted="true">
        <domain includeSubdomains="false">localhost</domain>
        <domain includeSubdomains="false">127.0.0.1</domain>
        <domain includeSubdomains="false">10.0.2.2</domain>
    </domain-config>
</network-security-config>
`;

async function writeDebugLoopbackNetworkPolicy(projectRoot) {
  const debugSourceRoot = path.join(projectRoot, "android", "app", "src", "debug");
  const xmlRoot = path.join(debugSourceRoot, "res", "xml");
  await fs.mkdir(xmlRoot, { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(debugSourceRoot, "AndroidManifest.xml"), DEBUG_MANIFEST),
    fs.writeFile(
      path.join(xmlRoot, "nautilo_local_dev_network_security_config.xml"),
      NETWORK_SECURITY_CONFIG,
    ),
  ]);
}

module.exports = (config) => withDangerousMod(config, ["android", async (modConfig) => {
  await writeDebugLoopbackNetworkPolicy(modConfig.modRequest.projectRoot);
  return modConfig;
}]);

module.exports.constants = { DEBUG_MANIFEST, NETWORK_SECURITY_CONFIG };
module.exports.writeDebugLoopbackNetworkPolicy = writeDebugLoopbackNetworkPolicy;
