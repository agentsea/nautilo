// Ad-hoc contributor packaging only. No certificate-backed identity is accepted.
const { sign } = require("app-builder-lib/out/codeSign/macCodeSign");
const { resolve } = require("node:path");
const {
  CUA_DRIVER_RELATIVE_PATH, CUA_DRIVER_ENTITLEMENTS, CUA_DRIVER_IDENTIFIER,
  COMPUTER_USE_HOST_RELATIVE_PATH, COMPUTER_USE_HOST_ENTITLEMENTS, COMPUTER_USE_HOST_IDENTIFIER,
  SCREEN_RECORDING_PERMISSION_RELATIVE_PATH, SCREEN_RECORDING_PERMISSION_ENTITLEMENTS, SCREEN_RECORDING_PERMISSION_IDENTIFIER,
  WINDOW_PRESENCE_RELATIVE_PATH, WINDOW_PRESENCE_ENTITLEMENTS, WINDOW_PRESENCE_IDENTIFIER,
} = require("./native-helper-contract.cjs");

function exactOptions(original, entitlements, identifier, label) {
  const originalAdditionalArguments = original?.additionalArguments ?? [];
  if (!Array.isArray(originalAdditionalArguments)) {
    throw new Error(`${label} per-file additionalArguments must be an array`);
  }
  if (originalAdditionalArguments.some((argument) => typeof argument !== "string")) {
    throw new Error(`${label} per-file additionalArguments must contain only strings`);
  }
  if (originalAdditionalArguments.some((argument) => (
    argument === "--identifier" ||
    argument.startsWith("--identifier=") ||
    argument === "-i" ||
    /^-i(?!-).+/.test(argument)
  ))) {
    throw new Error(`${label} codesign identifier must be controlled only by Nautilo's signing contract`);
  }
  return {
    ...(original ?? {}),
    entitlements,
    additionalArguments: [...originalAdditionalArguments, "--identifier", identifier],
  };
}

function wrapOptionsForFile(appPath, originalOptionsForFile, cuaEntitlements = CUA_DRIVER_ENTITLEMENTS, screenEntitlements = SCREEN_RECORDING_PERMISSION_ENTITLEMENTS, hostEntitlements = COMPUTER_USE_HOST_ENTITLEMENTS) {
  const exactCuaDriverPath = resolve(appPath, CUA_DRIVER_RELATIVE_PATH);
  const exactScreenRecordingPermissionPath = resolve(appPath, SCREEN_RECORDING_PERMISSION_RELATIVE_PATH);
  const exactComputerUseHostPath = resolve(appPath, COMPUTER_USE_HOST_RELATIVE_PATH);
  return (filePath) => {
    const original = originalOptionsForFile?.(filePath) ?? null;
    const exactPath = resolve(filePath);
    if (exactPath === resolve(appPath, WINDOW_PRESENCE_RELATIVE_PATH)) {
      return exactOptions(original, WINDOW_PRESENCE_ENTITLEMENTS, WINDOW_PRESENCE_IDENTIFIER, "Window presence helper");
    }
    if (exactPath === exactCuaDriverPath) {
      // A bare Mach-O has no bundle plist identifier. Without this codesign
      // derives a content-dependent identifier, so preserve the stable public identity in contributor builds.
      return exactOptions(original, cuaEntitlements, CUA_DRIVER_IDENTIFIER, "Cua");
    }
    if (exactPath === exactScreenRecordingPermissionPath) {
      return exactOptions(
        original,
        screenEntitlements,
        SCREEN_RECORDING_PERMISSION_IDENTIFIER,
        "Screen Recording helper",
      );
    }
    if (exactPath === exactComputerUseHostPath) {
      return exactOptions(original, hostEntitlements, COMPUTER_USE_HOST_IDENTIFIER, "Computer Use Host");
    }
    return original;
  };
}

function withCuaDriverEntitlements(signOptions, cuaEntitlements = CUA_DRIVER_ENTITLEMENTS) {
  if (signOptions.identity !== "-") {
    throw new Error("Contributor packaging requires the explicit ad-hoc identity '-'");
  }
  return {
    ...signOptions,
    identity: "-",
    optionsForFile: wrapOptionsForFile(signOptions.app, signOptions.optionsForFile, cuaEntitlements),
  };
}

async function executeSign(signOptions, signImpl, cuaEntitlements = CUA_DRIVER_ENTITLEMENTS) {
  await signImpl(withCuaDriverEntitlements(signOptions, cuaEntitlements));
}

async function signAdHoc(signOptions) {
  await executeSign(signOptions, sign);
}

module.exports = signAdHoc;
module.exports.wrapOptionsForFile = wrapOptionsForFile;
module.exports.withCuaDriverEntitlements = withCuaDriverEntitlements;
module.exports.executeSign = executeSign;
module.exports.CUA_DRIVER_RELATIVE_PATH = CUA_DRIVER_RELATIVE_PATH;
module.exports.CUA_DRIVER_IDENTIFIER = CUA_DRIVER_IDENTIFIER;
module.exports.COMPUTER_USE_HOST_RELATIVE_PATH = COMPUTER_USE_HOST_RELATIVE_PATH;
module.exports.COMPUTER_USE_HOST_IDENTIFIER = COMPUTER_USE_HOST_IDENTIFIER;
module.exports.SCREEN_RECORDING_PERMISSION_RELATIVE_PATH = SCREEN_RECORDING_PERMISSION_RELATIVE_PATH;
module.exports.SCREEN_RECORDING_PERMISSION_IDENTIFIER = SCREEN_RECORDING_PERMISSION_IDENTIFIER;
