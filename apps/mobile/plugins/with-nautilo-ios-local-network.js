const { withInfoPlist } = require("expo/config-plugins");

/** @typedef {import("@expo/config-types").ExpoConfig} ExpoConfig */

const EXPO_DEVELOPMENT_BONJOUR_SERVICE = "_expo._tcp";

/** @param {Record<string, unknown>} infoPlist */
function stripExpoDevelopmentBonjourService(infoPlist) {
  const rawServices = infoPlist.NSBonjourServices;
  if (!Array.isArray(rawServices)) return infoPlist;

  const services = /** @type {unknown[]} */ (rawServices).filter(
    (service) =>
      typeof service !== "string" ||
      service.toLowerCase().replace(/\.$/, "") !== EXPO_DEVELOPMENT_BONJOUR_SERVICE,
  );

  if (services.length === 0) {
    delete infoPlist.NSBonjourServices;
  } else {
    infoPlist.NSBonjourServices = services;
  }

  return infoPlist;
}

module.exports = (/** @type {ExpoConfig} */ config) =>
  withInfoPlist(config, (modConfig) => {
    stripExpoDevelopmentBonjourService(modConfig.modResults);
    return modConfig;
  });

module.exports.EXPO_DEVELOPMENT_BONJOUR_SERVICE = EXPO_DEVELOPMENT_BONJOUR_SERVICE;
module.exports.stripExpoDevelopmentBonjourService = stripExpoDevelopmentBonjourService;
