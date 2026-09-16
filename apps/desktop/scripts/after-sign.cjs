/**
 * D489 — inspect the completed macOS app after electron-builder's signing
 * phase. This records the final plist and actual signature identity/mode for
 * both ad-hoc local packages and Developer ID packages without launching the
 * app or touching TCC.
 */
const { execFileSync, spawnSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const { join } = require("node:path");
const { CUA_DRIVER_IDENTIFIER: EXPECTED_CUA_DRIVER_IDENTIFIER } = require("./native-helper-contract.cjs");
const {
  SCREEN_RECORDING_PERMISSION_IDENTIFIER: EXPECTED_SCREEN_RECORDING_PERMISSION_IDENTIFIER,
} = require("./native-helper-contract.cjs");
const { COMPUTER_USE_HOST_IDENTIFIER: EXPECTED_COMPUTER_USE_HOST_IDENTIFIER } = require("./native-helper-contract.cjs");

const EXPECTED_NAUTILO_IDENTIFIER = "com.nautilo.desktop";
const PACKAGED_HOST_VERIFIER_TIMEOUT_MS = 90_000;

/** Pure parser retained for package-contract tests. */
function parseCodesignIdentity(details) {
  const identifier = details.match(/^Identifier=(.+)$/m)?.[1]?.trim() ?? null;
  const rawTeamIdentifier = details.match(/^TeamIdentifier=(.+)$/m)?.[1]?.trim() ?? null;
  const teamIdentifier = rawTeamIdentifier === "not set" ? null : rawTeamIdentifier;
  const authorities = [...details.matchAll(/^Authority=(.+)$/gm)].map((match) => match[1].trim());
  return { identifier, teamIdentifier, authorities };
}

function inspectCodesignIdentity(path) {
  const detailsResult = spawnSync("codesign", ["-d", "--verbose=4", path], { encoding: "utf8" });
  if (detailsResult.error || detailsResult.status !== 0) {
    throw new Error(detailsResult.error?.message ?? (detailsResult.stderr.trim() || "codesign could not inspect signed path"));
  }
  return parseCodesignIdentity(`${detailsResult.stdout}\n${detailsResult.stderr}`);
}

function assertCuaDriverMatchesNautiloIdentity(
  driverIdentity,
  appIdentity,
  expectedTeam,
) {
  if (driverIdentity.identifier !== EXPECTED_CUA_DRIVER_IDENTIFIER) {
    throw new Error(`[after-sign] Cua driver must retain codesign identifier ${EXPECTED_CUA_DRIVER_IDENTIFIER}; found ${driverIdentity.identifier ?? "none"}`);
  }
  if (appIdentity.identifier !== EXPECTED_NAUTILO_IDENTIFIER) {
    throw new Error(`[after-sign] Nautilo app must retain codesign identifier ${EXPECTED_NAUTILO_IDENTIFIER}; found ${appIdentity.identifier ?? "none"}`);
  }
  if (driverIdentity.teamIdentifier !== appIdentity.teamIdentifier) {
    throw new Error(
      `[after-sign] Cua driver TeamIdentifier must match enclosing Nautilo.app; driver=${driverIdentity.teamIdentifier ?? "none"}, app=${appIdentity.teamIdentifier ?? "none"}`,
    );
  }
  if (driverIdentity.teamIdentifier === null) {
    if (driverIdentity.authorities.length !== 0 || appIdentity.authorities.length !== 0) {
      throw new Error("[after-sign] ad-hoc Nautilo and Cua signatures must not advertise certificate authorities");
    }
  } else {
    if (!driverIdentity.authorities[0]?.startsWith("Developer ID Application:")) {
      throw new Error("[after-sign] signed Cua driver must use a Developer ID Application authority");
    }
    if (JSON.stringify(driverIdentity.authorities) !== JSON.stringify(appIdentity.authorities)) {
      throw new Error("[after-sign] Cua driver certificate authority chain must match enclosing Nautilo.app");
    }
  }
  if (expectedTeam !== undefined) {
    if (!/^[A-Z0-9]{10}$/.test(expectedTeam)) {
      throw new Error("[after-sign] APPLE_TEAM_ID must be a 10-character Developer ID team identifier");
    }
    if (appIdentity.teamIdentifier !== expectedTeam) {
      throw new Error(`[after-sign] Nautilo app TeamIdentifier must be ${expectedTeam}; found ${appIdentity.teamIdentifier ?? "none"}`);
    }
  }
}

function assertScreenRecordingPermissionMatchesNautiloIdentity(
  helperIdentity,
  appIdentity,
  expectedTeam,
) {
  if (helperIdentity.identifier !== EXPECTED_SCREEN_RECORDING_PERMISSION_IDENTIFIER) {
    throw new Error(`[after-sign] Screen Recording helper must retain codesign identifier ${EXPECTED_SCREEN_RECORDING_PERMISSION_IDENTIFIER}; found ${helperIdentity.identifier ?? "none"}`);
  }
  if (appIdentity.identifier !== EXPECTED_NAUTILO_IDENTIFIER) {
    throw new Error(`[after-sign] Nautilo app must retain codesign identifier ${EXPECTED_NAUTILO_IDENTIFIER}; found ${appIdentity.identifier ?? "none"}`);
  }
  if (helperIdentity.teamIdentifier !== appIdentity.teamIdentifier) {
    throw new Error("[after-sign] Screen Recording helper TeamIdentifier must match enclosing Nautilo.app");
  }
  if (helperIdentity.teamIdentifier === null) {
    if (helperIdentity.authorities.length !== 0 || appIdentity.authorities.length !== 0) {
      throw new Error("[after-sign] ad-hoc Nautilo and Screen Recording helper signatures must not advertise certificate authorities");
    }
  } else {
    if (!helperIdentity.authorities[0]?.startsWith("Developer ID Application:")) {
      throw new Error("[after-sign] signed Screen Recording helper must use a Developer ID Application authority");
    }
    if (JSON.stringify(helperIdentity.authorities) !== JSON.stringify(appIdentity.authorities)) {
      throw new Error("[after-sign] Screen Recording helper certificate authority chain must match enclosing Nautilo.app");
    }
  }
  if (expectedTeam !== undefined) {
    if (!/^[A-Z0-9]{10}$/.test(expectedTeam)) {
      throw new Error("[after-sign] APPLE_TEAM_ID must be a 10-character Developer ID team identifier");
    }
    if (appIdentity.teamIdentifier !== expectedTeam) {
      throw new Error(`[after-sign] Nautilo app TeamIdentifier must be ${expectedTeam}; found ${appIdentity.teamIdentifier ?? "none"}`);
    }
  }
}

function assertComputerUseHostMatchesNautiloIdentity(hostIdentity, appIdentity, expectedTeam) {
  if (hostIdentity.identifier !== EXPECTED_COMPUTER_USE_HOST_IDENTIFIER) {
    throw new Error(`[after-sign] Computer Use Host must retain codesign identifier ${EXPECTED_COMPUTER_USE_HOST_IDENTIFIER}; found ${hostIdentity.identifier ?? "none"}`);
  }
  if (appIdentity.identifier !== EXPECTED_NAUTILO_IDENTIFIER || hostIdentity.teamIdentifier !== appIdentity.teamIdentifier) {
    throw new Error("[after-sign] Computer Use Host identity must match enclosing Nautilo.app");
  }
  if (hostIdentity.teamIdentifier === null) {
    if (hostIdentity.authorities.length !== 0 || appIdentity.authorities.length !== 0) throw new Error("[after-sign] ad-hoc Computer Use Host signature must not advertise certificate authorities");
  } else if (!hostIdentity.authorities[0]?.startsWith("Developer ID Application:") || JSON.stringify(hostIdentity.authorities) !== JSON.stringify(appIdentity.authorities)) {
    throw new Error("[after-sign] Computer Use Host certificate authority chain must match enclosing Nautilo.app");
  }
  if (expectedTeam !== undefined && appIdentity.teamIdentifier !== expectedTeam) throw new Error(`[after-sign] Nautilo app TeamIdentifier must be ${expectedTeam}; found ${appIdentity.teamIdentifier ?? "none"}`);
}


const EXPECTED_CUA_ENTITLEMENTS = {
  "com.apple.security.automation.apple-events": true,
  "com.apple.security.device.screen-capture": true,
};

const EXPECTED_SCREEN_RECORDING_PERMISSION_ENTITLEMENTS = {
  "com.apple.security.device.screen-capture": true,
};

function assertExactCuaDriverEntitlements(entitlements) {
  if (entitlements === null || typeof entitlements !== "object" || Array.isArray(entitlements)) {
    throw new Error("[after-sign] Cua driver entitlements must be a dictionary");
  }
  const actualKeys = Object.keys(entitlements).sort();
  const expectedKeys = Object.keys(EXPECTED_CUA_ENTITLEMENTS).sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    throw new Error(`[after-sign] Cua driver entitlements must contain exactly ${expectedKeys.join(", ")}; found ${actualKeys.join(", ") || "none"}`);
  }
  for (const key of expectedKeys) {
    if (entitlements[key] !== true) {
      throw new Error(`[after-sign] Cua driver entitlement ${key} must be true`);
    }
  }
}

function inspectCuaDriverEntitlements(cuaDriverPath) {
  inspectExactEntitlements(cuaDriverPath, EXPECTED_CUA_ENTITLEMENTS, "Cua driver");
}

function assertExactScreenRecordingPermissionEntitlements(entitlements) {
  const actualKeys = entitlements !== null && typeof entitlements === "object" && !Array.isArray(entitlements)
    ? Object.keys(entitlements).sort()
    : [];
  const expectedKeys = Object.keys(EXPECTED_SCREEN_RECORDING_PERMISSION_ENTITLEMENTS).sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    throw new Error(`[after-sign] Screen Recording helper entitlements must contain exactly ${expectedKeys.join(", ")}; found ${actualKeys.join(", ") || "none"}`);
  }
  for (const key of expectedKeys) {
    if (entitlements[key] !== true) {
      throw new Error(`[after-sign] Screen Recording helper entitlement ${key} must be true`);
    }
  }
}

function inspectExactEntitlements(path, expectedEntitlements, label, assertEntitlements) {
  const result = spawnSync("codesign", ["-d", "--entitlements", ":-", path], { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    throw new Error(result.error?.message ?? (result.stderr.trim() || `codesign could not inspect ${label} entitlements`));
  }
  const combined = `${result.stdout}\n${result.stderr}`;
  const plistStart = combined.indexOf("<plist");
  const plistEnd = combined.indexOf("</plist>", plistStart);
  if (plistStart === -1 || plistEnd === -1) {
    throw new Error(`[after-sign] codesign returned no ${label} entitlement plist`);
  }
  const plist = combined.slice(plistStart, plistEnd + "</plist>".length);
  const converted = spawnSync("plutil", ["-convert", "json", "-o", "-", "-"], {
    input: plist,
    encoding: "utf8",
  });
  if (converted.error || converted.status !== 0) {
    throw new Error(converted.error?.message ?? (converted.stderr.trim() || `plutil could not parse ${label} entitlements`));
  }
  const entitlements = JSON.parse(converted.stdout);
  if (assertEntitlements) {
    assertEntitlements(entitlements);
    return;
  }
  const actualKeys = entitlements !== null && typeof entitlements === "object" && !Array.isArray(entitlements)
    ? Object.keys(entitlements).sort()
    : [];
  const expectedKeys = Object.keys(expectedEntitlements).sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    throw new Error(`[after-sign] ${label} entitlements must contain exactly ${expectedKeys.join(", ")}; found ${actualKeys.join(", ") || "none"}`);
  }
  for (const key of expectedKeys) {
    if (entitlements[key] !== true) throw new Error(`[after-sign] ${label} entitlement ${key} must be true`);
  }
}

function assertPackagedCuaDriverSignature(bundlePath) {
  const cuaDriverPath = join(bundlePath, "Contents", "Resources", "tools-cua", "cua-driver");
  if (!existsSync(cuaDriverPath)) {
    throw new Error(`[after-sign] missing packaged Cua driver at ${cuaDriverPath}`);
  }
  execFileSync("codesign", ["--verify", "--strict", "--verbose=4", cuaDriverPath], { stdio: "inherit" });
  const driverIdentity = inspectCodesignIdentity(cuaDriverPath);
  const appIdentity = inspectCodesignIdentity(bundlePath);
  assertCuaDriverMatchesNautiloIdentity(driverIdentity, appIdentity, process.env.APPLE_TEAM_ID);
  inspectCuaDriverEntitlements(cuaDriverPath);
}

function assertPackagedScreenRecordingPermissionSignature(bundlePath) {
  const helperPath = join(bundlePath, "Contents", "Resources", "tools-permissions", "nautilo-screen-recording-permission");
  if (!existsSync(helperPath)) {
    throw new Error(`[after-sign] missing packaged Screen Recording helper at ${helperPath}`);
  }
  execFileSync("codesign", ["--verify", "--strict", "--verbose=4", helperPath], { stdio: "inherit" });
  const helperIdentity = inspectCodesignIdentity(helperPath);
  const appIdentity = inspectCodesignIdentity(bundlePath);
  assertScreenRecordingPermissionMatchesNautiloIdentity(
    helperIdentity,
    appIdentity,
    process.env.APPLE_TEAM_ID,
  );
  inspectExactEntitlements(
    helperPath,
    EXPECTED_SCREEN_RECORDING_PERMISSION_ENTITLEMENTS,
    "Screen Recording helper",
    assertExactScreenRecordingPermissionEntitlements,
  );
}

function assertPackagedComputerUseHostSignature(bundlePath) {
  const hostPath = join(bundlePath, "Contents", "Resources", "tools-computer-use-host", "nautilo-computer-use-host");
  if (!existsSync(hostPath)) throw new Error(`[after-sign] missing packaged Computer Use Host at ${hostPath}`);
  execFileSync("codesign", ["--verify", "--strict", "--verbose=4", hostPath], { stdio: "inherit" });
  assertComputerUseHostMatchesNautiloIdentity(inspectCodesignIdentity(hostPath), inspectCodesignIdentity(bundlePath), process.env.APPLE_TEAM_ID);
  inspectExactEntitlements(hostPath, {}, "Computer Use Host");
}


exports.parseCodesignIdentity = parseCodesignIdentity;
exports.assertCuaDriverMatchesNautiloIdentity = assertCuaDriverMatchesNautiloIdentity;
exports.assertExactCuaDriverEntitlements = assertExactCuaDriverEntitlements;
exports.assertScreenRecordingPermissionMatchesNautiloIdentity = assertScreenRecordingPermissionMatchesNautiloIdentity;
exports.assertComputerUseHostMatchesNautiloIdentity = assertComputerUseHostMatchesNautiloIdentity;
exports.assertExactScreenRecordingPermissionEntitlements = assertExactScreenRecordingPermissionEntitlements;
exports.assertPackagedScreenRecordingPermissionSignature = assertPackagedScreenRecordingPermissionSignature;

/**
 * @param {{ appOutDir: string, packager: { appInfo: { productFilename: string, productName: string } }, electronPlatformName: string }} context
 */
exports.default = async function afterSign(context) {
  if (context.electronPlatformName !== "darwin" && context.electronPlatformName !== "mas") return;
  const productFilename = context.packager.appInfo.productFilename || context.packager.appInfo.productName;
  const bundlePath = join(context.appOutDir, `${productFilename}.app`);
  if (!existsSync(bundlePath)) {
    throw new Error(`[after-sign] missing completed macOS bundle at ${bundlePath}`);
  }
  // This runs after electron-builder's ordinary recursive signing pass. It
  // audits the actual nested executable without executing it, and intentionally
  // rejects any package that omitted it or changed its signing identity.
  execFileSync("bun", ["run", join(__dirname, "verify-ffmpeg.ts"), join(bundlePath, "Contents", "Resources", "tools-ffmpeg"), "--signed"], { stdio: "inherit", cwd: join(__dirname, "..") });
  assertPackagedCuaDriverSignature(bundlePath);
  assertPackagedScreenRecordingPermissionSignature(bundlePath);
  assertPackagedComputerUseHostSignature(bundlePath);
  if (process.env.APPLE_TEAM_ID) {
    // Run the production loader against the final recursively signed bytes.
    // This catches any mismatch introduced after extraResources were staged.
    execFileSync(
      "bun",
      ["run", join(__dirname, "verify-packaged-computer-use-host.ts"), bundlePath],
      {
        cwd: join(__dirname, ".."),
        stdio: "inherit",
        timeout: PACKAGED_HOST_VERIFIER_TIMEOUT_MS,
        killSignal: "SIGKILL",
      },
    );
  }
  execFileSync(
    "bun",
    ["run", join(__dirname, "inspect-macos-local-network-artifact.ts"), bundlePath],
    { cwd: join(__dirname, ".."), stdio: "inherit" },
  );
};
