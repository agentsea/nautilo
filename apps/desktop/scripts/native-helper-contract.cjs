// Public native helper paths, identities and entitlement contracts.
const { join, resolve } = require("node:path");

const CUA_DRIVER_RELATIVE_PATH = join("Contents", "Resources", "tools-cua", "cua-driver");
const CUA_DRIVER_ENTITLEMENTS = resolve(__dirname, "..", "entitlements.cua-driver.plist");
const CUA_DRIVER_IDENTIFIER = "com.nautilo.desktop.cua-driver";
const COMPUTER_USE_HOST_RELATIVE_PATH = join("Contents", "Resources", "tools-computer-use-host", "nautilo-computer-use-host");
const COMPUTER_USE_HOST_ENTITLEMENTS = resolve(__dirname, "..", "entitlements.computer-use-host.plist");
const COMPUTER_USE_HOST_IDENTIFIER = "com.nautilo.desktop.computer-use-host";
const SCREEN_RECORDING_PERMISSION_RELATIVE_PATH = join(
  "Contents", "Resources", "tools-permissions", "nautilo-screen-recording-permission",
);
const SCREEN_RECORDING_PERMISSION_ENTITLEMENTS = resolve(
  __dirname, "..", "entitlements.screen-recording-permission.plist",
);
const SCREEN_RECORDING_PERMISSION_IDENTIFIER = "com.nautilo.desktop.screen-recording-permission";

module.exports.CUA_DRIVER_RELATIVE_PATH = CUA_DRIVER_RELATIVE_PATH;
module.exports.CUA_DRIVER_IDENTIFIER = CUA_DRIVER_IDENTIFIER;
module.exports.COMPUTER_USE_HOST_RELATIVE_PATH = COMPUTER_USE_HOST_RELATIVE_PATH;
module.exports.COMPUTER_USE_HOST_IDENTIFIER = COMPUTER_USE_HOST_IDENTIFIER;
module.exports.SCREEN_RECORDING_PERMISSION_RELATIVE_PATH = SCREEN_RECORDING_PERMISSION_RELATIVE_PATH;
module.exports.SCREEN_RECORDING_PERMISSION_IDENTIFIER = SCREEN_RECORDING_PERMISSION_IDENTIFIER;
module.exports.CUA_DRIVER_ENTITLEMENTS = CUA_DRIVER_ENTITLEMENTS;
module.exports.COMPUTER_USE_HOST_ENTITLEMENTS = COMPUTER_USE_HOST_ENTITLEMENTS;
module.exports.SCREEN_RECORDING_PERMISSION_ENTITLEMENTS = SCREEN_RECORDING_PERMISSION_ENTITLEMENTS;
module.exports.WINDOW_PRESENCE_RELATIVE_PATH = join("Contents", "Resources", "tools-window-presence", "nautilo-window-presence");
module.exports.WINDOW_PRESENCE_IDENTIFIER = "com.nautilo.desktop.window-presence";
module.exports.WINDOW_PRESENCE_ENTITLEMENTS = resolve(__dirname, "..", "entitlements.window-presence.plist");
