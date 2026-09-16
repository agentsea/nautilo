const fs = require("node:fs/promises");
const path = require("node:path");
const {
  withDangerousMod,
  withEntitlementsPlist,
  withXcodeProject,
} = require("expo/config-plugins");

/**
 * `xcode` is a JavaScript-only dependency. Keep the generated-project
 * boundary type-checked by modelling the narrow PBX contracts this plugin
 * reads and writes instead of allowing untyped values through the modifier.
 *
 * @typedef {{ comment?: string }} NautiloPbxBuildPhase
 * @typedef {{ name: string, buildConfigurationList: string, buildPhases?: NautiloPbxBuildPhase[] }} NautiloPbxNativeTarget
 * @typedef {{ value: string }} NautiloPbxSectionEntry
 * @typedef {{ buildConfigurations: NautiloPbxSectionEntry[] }} NautiloPbxConfigurationList
 * @typedef {{ buildSettings: Record<string, string> }} NautiloPbxBuildConfiguration
 * @typedef {{ mainGroup: string }} NautiloPbxProject
 * @typedef {{ firstProject: NautiloPbxProject }} NautiloFirstProject
 * @typedef {{
 *   pbxNativeTargetSection: () => Record<string, NautiloPbxNativeTarget>,
 *   findPBXGroupKey: (options: { name: string }) => string | undefined,
 *   pbxCreateGroup: (name: string, path: string) => string,
 *   getFirstProject: () => NautiloFirstProject,
 *   addToPbxGroup: (group: string, parentGroup: string) => void,
 *   pbxXCConfigurationList: () => Record<string, NautiloPbxConfigurationList>,
 *   pbxXCBuildConfigurationSection: () => Record<string, NautiloPbxBuildConfiguration>,
 *   addBuildPhase: (files: string[], type: string, name: string, targetUuid: string) => void,
 *   hasFile: (filename: string) => boolean,
 *   addSourceFile: (filename: string, options: { target: string }, group: string) => void,
 *   addFile: (filename: string, group: string) => void,
 *   addTarget: (name: string, type: string, subfolder: string, bundleIdentifier: string) => { uuid: string },
 *   addFramework: (name: string, options: { target: string }) => void,
 * }} NautiloXcodeProject
 * @typedef {import("@expo/config-types").ExpoConfig} ExpoConfig
 * @typedef {{ "com.apple.security.application-groups"?: string[] }} AppEntitlements
 * @typedef {ExpoConfig & { modResults: AppEntitlements }} EntitlementsModConfig
 * @typedef {ExpoConfig & { modRequest: { platformProjectRoot: string } }} DangerousModConfig
 * @typedef {{ uuid: string, target: NautiloPbxNativeTarget }} NativeTargetEntry
 */

/**
 * D471 / Stack 309 bounded native Share target.
 *
 * This deliberately owns only the native iOS Share Extension target and its
 * App Group hand-off. The extension never gets a Nautilo token, opens a
 * network connection, uploads bytes, selects a server/Room, or sends work.
 * It can stage one bounded text/URL or opaque file receipt for the foreground
 * Nautilo app to validate and move into pending custody before destination
 * choice.
 */
const TARGET_NAME = "NautiloShare";
const TARGET_DIRECTORY = "NautiloShare";
// The extension is a separate Xcode target, so EAS cannot infer its signing
// team from the main app target. Keep the official app's Apple team explicit
// on every generated configuration.
const APPLE_DEVELOPMENT_TEAM = "UWBR65VS6Z";
const PAYLOAD_KEY = "ai.nautilo.share.pending-v1";
const FILE_PAYLOAD_KEY = "ai.nautilo.share.pending-file-v1";
const FILE_INBOX_DIRECTORY = "NautiloShareHandoff";
// Align with encrypted composer-draft custody. Accepting a larger native item
// would create a dead end at Review in chat.
const MAX_TEXT_OR_URL_BYTES = 1024;
const MAX_INBOUND_FILE_BYTES = 100 * 1024 * 1024;

/** @param {string | undefined} bundleIdentifier @param {string | undefined} marketingVersion */
function shareExtensionConfig(bundleIdentifier, marketingVersion) {
  if (!bundleIdentifier || typeof bundleIdentifier !== "string") {
    throw new Error("Nautilo Share Extension requires expo.ios.bundleIdentifier.");
  }
  if (!marketingVersion || typeof marketingVersion !== "string") {
    throw new Error("Nautilo Share Extension requires expo.version.");
  }
  return {
    appGroup: `group.${bundleIdentifier}.share`,
    bundleIdentifier: `${bundleIdentifier}.share`,
    marketingVersion,
    targetName: TARGET_NAME,
  };
}

/** @param {{ appGroup: string }} config */
function swiftSource({ appGroup }) {
  return `import Social
import UniformTypeIdentifiers

private enum NautiloShareStaging {
  static let appGroup = "${appGroup}"
  static let payloadKey = "${PAYLOAD_KEY}"
  static let filePayloadKey = "${FILE_PAYLOAD_KEY}"
  static let fileInboxDirectory = "${FILE_INBOX_DIRECTORY}"
  static let maxPayloadBytes = ${MAX_TEXT_OR_URL_BYTES}
  static let maxInboundFileBytes: Int64 = ${MAX_INBOUND_FILE_BYTES}
}

/**
 * A deliberately tiny Share Extension. It stages exactly one text/URL record
 * or one bounded opaque file receipt in the App Group and completes. No auth,
 * network, destination choice, upload, or submission can happen here.
 */
final class ShareViewController: SLComposeServiceViewController {
  override func isContentValid() -> Bool { true }

  override func didSelectPost() {
    let providers = extensionContext?.inputItems
      .compactMap { $0 as? NSExtensionItem }
      .flatMap { $0.attachments ?? [] } ?? []
    // A Files provider may advertise both its real content type (for example
    // com.adobe.pdf) and public.file-url/public.url. Classify the real binary
    // type first so a document cannot be mistaken for a transient file URL.
    if let candidate = providers.compactMap({ provider -> (NSItemProvider, String)? in
      let typeIdentifier = provider.registeredTypeIdentifiers.first(where: { identifier in
        guard let type = UTType(identifier), type != .url, type != .plainText else { return false }
        return type.conforms(to: .data) || type.conforms(to: .content) || type.conforms(to: .item)
      })
      return typeIdentifier.map { (provider, $0) }
    }).first {
      stageFile(provider: candidate.0, typeIdentifier: candidate.1)
      return
    }

    if let provider = providers.first(where: {
      $0.hasItemConformingToTypeIdentifier(UTType.url.identifier)
    }) {
      provider.loadItem(forTypeIdentifier: UTType.url.identifier, options: nil) { [weak self] item, _ in
        let url: URL?
        if let value = item as? URL {
          url = value
        } else if let value = item as? NSURL {
          url = value as URL
        } else if let value = item as? String {
          url = URL(string: value)
        } else {
          url = nil
        }
        guard let url, !url.isFileURL else {
          self?.stageComposedTextOrComplete()
          return
        }
        self?.stage(kind: "url", value: url.absoluteString)
      }
      return
    }

    stageComposedTextOrComplete()
  }

  private func stageComposedTextOrComplete() {
    if let text = contentText?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty {
      stage(kind: "text", value: text)
    } else {
      complete()
    }
  }

  override func configurationItems() -> [Any]! { [] }

  private func stageFile(provider: NSItemProvider, typeIdentifier: String) {
    provider.loadFileRepresentation(forTypeIdentifier: typeIdentifier) { [weak self] source, error in
      guard let self else { return }
      if let source {
        self.stageFileSource(source, typeIdentifier: typeIdentifier)
        return
      }
      NSLog(
        "NautiloShare: copied representation unavailable for %@ (%@:%ld); trying in-place",
        typeIdentifier,
        (error as NSError?)?.domain ?? "none",
        (error as NSError?)?.code ?? 0
      )
      provider.loadInPlaceFileRepresentation(forTypeIdentifier: typeIdentifier) { [weak self] source, _, inPlaceError in
        guard let self, let source else {
          let metadata = inPlaceError as NSError?
          NSLog(
            "NautiloShare: in-place representation unavailable for %@ (%@:%ld)",
            typeIdentifier,
            metadata?.domain ?? "none",
            metadata?.code ?? 0
          )
          self?.complete()
          return
        }
        self.stageFileSource(source, typeIdentifier: typeIdentifier)
      }
    }
  }

  private func stageFileSource(_ source: URL, typeIdentifier: String) {
    let accessing = source.startAccessingSecurityScopedResource()
    defer {
      if accessing { source.stopAccessingSecurityScopedResource() }
    }
    let nativeReceiptId = UUID().uuidString
    let recordId = UUID().uuidString
    let fallbackExtension = UTType(typeIdentifier)?.preferredFilenameExtension
    let sourceName = source.lastPathComponent.trimmingCharacters(in: .whitespacesAndNewlines)
    let filename = safeFilename(sourceName, fallbackExtension: fallbackExtension)
    let mimeType = UTType(typeIdentifier)?.preferredMIMEType
      ?? UTType(filenameExtension: source.pathExtension)?.preferredMIMEType
      ?? "application/octet-stream"
    let candidate = isCandidate(filename: filename, mimeType: mimeType)
    let defaults = UserDefaults(suiteName: NautiloShareStaging.appGroup)
    let pending = defaults?.object(forKey: NautiloShareStaging.filePayloadKey) != nil
    let container = FileManager.default.containerURL(
      forSecurityApplicationGroupIdentifier: NautiloShareStaging.appGroup
    )
    guard candidate, let defaults, !pending, let container else { complete(); return }

    let inbox = container.appendingPathComponent(NautiloShareStaging.fileInboxDirectory, isDirectory: true)
    let temporary = inbox.appendingPathComponent(".incoming-\\(nativeReceiptId)")
    let destination = inbox.appendingPathComponent(nativeReceiptId)
    do {
      try FileManager.default.createDirectory(
        at: inbox,
        withIntermediateDirectories: true,
        attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
      )
      let size = try copyBounded(source: source, destination: temporary)
      try FileManager.default.moveItem(at: temporary, to: destination)
      try FileManager.default.setAttributes(
        [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
        ofItemAtPath: destination.path
      )
      let record: [String: Any] = [
        "id": recordId,
        "nativeReceiptId": nativeReceiptId,
        "filename": filename,
        "mimeType": mimeType,
        "sizeBytes": size,
        "createdAt": ISO8601DateFormatter().string(from: Date()),
      ]
      defaults.set(record, forKey: NautiloShareStaging.filePayloadKey)
    } catch {
      let metadata = error as NSError
      NSLog("NautiloShare: staging failed (%@:%ld)", metadata.domain, metadata.code)
      try? FileManager.default.removeItem(at: temporary)
      try? FileManager.default.removeItem(at: destination)
    }
    complete()
  }

  private func copyBounded(source: URL, destination: URL) throws -> Int64 {
    FileManager.default.createFile(atPath: destination.path, contents: nil)
    let input = try FileHandle(forReadingFrom: source)
    let output = try FileHandle(forWritingTo: destination)
    defer { try? input.close(); try? output.close() }
    var copied: Int64 = 0
    while let chunk = try input.read(upToCount: 64 * 1024), !chunk.isEmpty {
      copied += Int64(chunk.count)
      guard copied <= NautiloShareStaging.maxInboundFileBytes else {
        throw CocoaError(.fileWriteOutOfSpace)
      }
      try output.write(contentsOf: chunk)
    }
    try output.synchronize()
    guard copied > 0 else { throw CocoaError(.fileReadCorruptFile) }
    return copied
  }

  private func safeFilename(_ candidate: String, fallbackExtension: String?) -> String {
    let sanitized = candidate
      .replacingOccurrences(of: "/", with: "-")
      .replacingOccurrences(of: ":", with: "-")
      .filter { !$0.isNewline && !$0.isASCII || ($0.asciiValue ?? 0) >= 32 }
    if !sanitized.isEmpty { return String(sanitized.prefix(255)) }
    return "Shared file" + (fallbackExtension.map { ".\\($0)" } ?? "")
  }

  private func isCandidate(filename: String, mimeType: String) -> Bool {
    let ext = (filename as NSString).pathExtension.lowercased()
    let blockedExtensions = Set(["app", "bat", "bz2", "cmd", "dmg", "dll", "exe", "gz", "pkg", "ps1", "rar", "sh", "svg", "tar", "xz", "zip", "7z"])
    if blockedExtensions.contains(ext) || mimeType == "image/svg+xml" { return false }
    if mimeType.contains("zip") || mimeType.contains("archive") || mimeType.contains("executable") { return false }
    return true
  }

  private func stage(kind: String, value: String) {
    guard value.lengthOfBytes(using: .utf8) <= NautiloShareStaging.maxPayloadBytes,
          let defaults = UserDefaults(suiteName: NautiloShareStaging.appGroup) else {
      complete()
      return
    }

    let record: [String: Any] = [
      "version": 1,
      "id": UUID().uuidString,
      "kind": kind,
      "value": value,
      "createdAt": ISO8601DateFormatter().string(from: Date()),
    ]
    // App Group storage is intentionally the only native hand-off. The main
    // app validates it and commits encrypted pending custody before acking this
    // record; destination selection, authentication, and upload stay outside
    // the extension.
    defaults.set(record, forKey: NautiloShareStaging.payloadKey)
    complete()
  }

  private func complete() {
    extensionContext?.completeRequest(returningItems: [], completionHandler: nil)
  }
}
`;
}

function infoPlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDisplayName</key>
  <string>Nautilo</string>
  <key>CFBundleExecutable</key>
  <string>$(EXECUTABLE_NAME)</string>
  <key>CFBundleIdentifier</key>
  <string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>$(PRODUCT_NAME)</string>
  <key>CFBundlePackageType</key>
  <string>$(PRODUCT_BUNDLE_PACKAGE_TYPE)</string>
  <key>CFBundleShortVersionString</key>
  <string>$(MARKETING_VERSION)</string>
  <key>CFBundleVersion</key>
  <string>$(CURRENT_PROJECT_VERSION)</string>
  <key>NSExtension</key>
  <dict>
    <key>NSExtensionAttributes</key>
    <dict>
      <key>NSExtensionActivationRule</key>
      <dict>
        <key>NSExtensionActivationSupportsText</key>
        <true/>
        <key>NSExtensionActivationSupportsWebURLWithMaxCount</key>
        <integer>1</integer>
        <key>NSExtensionActivationSupportsImageWithMaxCount</key>
        <integer>1</integer>
        <key>NSExtensionActivationSupportsFileWithMaxCount</key>
        <integer>1</integer>
      </dict>
    </dict>
    <key>NSExtensionPointIdentifier</key>
    <string>com.apple.share-services</string>
    <key>NSExtensionPrincipalClass</key>
    <string>$(PRODUCT_MODULE_NAME).ShareViewController</string>
  </dict>
</dict>
</plist>
`;
}

/** @param {{ appGroup: string }} config */
function entitlements({ appGroup }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.application-groups</key>
  <array>
    <string>${appGroup}</string>
  </array>
</dict>
</plist>
`;
}

/** @param {NautiloXcodeProject} project @returns {NativeTargetEntry | undefined} */
function findTarget(project) {
  for (const [uuid, target] of Object.entries(project.pbxNativeTargetSection())) {
    if (!uuid.endsWith("_comment") && String(target.name).replaceAll('"', "") === TARGET_NAME) {
      return { uuid, target };
    }
  }
  return undefined;
}

/** @param {NautiloXcodeProject} project */
function ensureTargetGroup(project) {
  const existing = project.findPBXGroupKey({ name: TARGET_NAME });
  if (existing) return existing;
  const group = project.pbxCreateGroup(TARGET_NAME, TARGET_DIRECTORY);
  const { firstProject } = project.getFirstProject();
  project.addToPbxGroup(group, firstProject.mainGroup);
  return group;
}

/** @param {NautiloXcodeProject} project @param {NautiloPbxNativeTarget} target @param {{ marketingVersion: string, bundleIdentifier: string }} config */
function configureTarget(project, target, config) {
  const configurationList = project.pbxXCConfigurationList()[target.buildConfigurationList];
  for (const entry of configurationList.buildConfigurations) {
    const buildConfiguration = project.pbxXCBuildConfigurationSection()[entry.value];
    buildConfiguration.buildSettings.CODE_SIGN_ENTITLEMENTS = `${TARGET_DIRECTORY}/${TARGET_NAME}.entitlements`;
    buildConfiguration.buildSettings.CURRENT_PROJECT_VERSION = "1";
    buildConfiguration.buildSettings.DEVELOPMENT_TEAM = APPLE_DEVELOPMENT_TEAM;
    // addTarget defaults app extensions to generated Info.plists. This plugin
    // deliberately owns an explicit one because the Share activation contract
    // and its bundle version must survive a clean CNG prebuild.
    buildConfiguration.buildSettings.GENERATE_INFOPLIST_FILE = "NO";
    buildConfiguration.buildSettings.INFOPLIST_FILE = `${TARGET_DIRECTORY}/${TARGET_NAME}-Info.plist`;
    buildConfiguration.buildSettings.IPHONEOS_DEPLOYMENT_TARGET = "16.4";
    buildConfiguration.buildSettings.MARKETING_VERSION = config.marketingVersion;
    buildConfiguration.buildSettings.PRODUCT_BUNDLE_IDENTIFIER = config.bundleIdentifier;
    buildConfiguration.buildSettings.PRODUCT_NAME = TARGET_NAME;
    buildConfiguration.buildSettings.SKIP_INSTALL = "YES";
    buildConfiguration.buildSettings.SWIFT_VERSION = "5.0";
    buildConfiguration.buildSettings.TARGETED_DEVICE_FAMILY = '"1,2"';
  }
}

/** @param {NautiloXcodeProject} project @param {string} targetUuid */
function ensureBuildPhases(project, targetUuid) {
  const target = project.pbxNativeTargetSection()[targetUuid];
  const phases = target.buildPhases ?? [];
  const present = new Set(phases.map((phase) => phase.comment));
  if (!present.has("Sources")) project.addBuildPhase([], "PBXSourcesBuildPhase", "Sources", targetUuid);
  if (!present.has("Frameworks")) project.addBuildPhase([], "PBXFrameworksBuildPhase", "Frameworks", targetUuid);
  if (!present.has("Resources")) project.addBuildPhase([], "PBXResourcesBuildPhase", "Resources", targetUuid);
}

/** @param {NautiloXcodeProject} project @param {string} filename @param {string} group @param {string} targetUuid @param {boolean} [source] */
function ensureFile(project, filename, group, targetUuid, source = false) {
  if (project.hasFile(filename)) return;
  if (source) {
    project.addSourceFile(filename, { target: targetUuid }, group);
  } else {
    project.addFile(filename, group);
  }
}

/** @param {ExpoConfig} config @returns {ExpoConfig} */
const withNautiloShareExtension = (config) => {
  const settings = shareExtensionConfig(config.ios?.bundleIdentifier, config.version);

  config = withEntitlementsPlist(config, (/** @param {EntitlementsModConfig} modConfig */ modConfig) => {
    const existingGroups = modConfig.modResults["com.apple.security.application-groups"];
    const groups = new Set(
      Array.isArray(existingGroups)
        ? existingGroups.filter((group) => typeof group === "string")
        : [],
    );
    groups.add(settings.appGroup);
    modConfig.modResults["com.apple.security.application-groups"] = [...groups];
    return modConfig;
  });

  config = withDangerousMod(config, ["ios", async (/** @param {DangerousModConfig} modConfig */ modConfig) => {
    const extensionRoot = path.join(modConfig.modRequest.platformProjectRoot, TARGET_DIRECTORY);
    await fs.mkdir(extensionRoot, { recursive: true });
    await Promise.all([
      fs.writeFile(path.join(extensionRoot, "ShareViewController.swift"), swiftSource(settings), "utf8"),
      fs.writeFile(path.join(extensionRoot, `${TARGET_NAME}-Info.plist`), infoPlist(), "utf8"),
      fs.writeFile(path.join(extensionRoot, `${TARGET_NAME}.entitlements`), entitlements(settings), "utf8"),
    ]);
    return modConfig;
  }]);

  return withXcodeProject(config, (rawModConfig) => {
    const rawProject = /** @type {unknown} */ (rawModConfig.modResults);
    const project = /** @type {NautiloXcodeProject} */ (rawProject);
    let targetEntry = findTarget(project);
    if (!targetEntry) {
      const created = project.addTarget(TARGET_NAME, "app_extension", TARGET_DIRECTORY, settings.bundleIdentifier);
      ensureBuildPhases(project, created.uuid);
      targetEntry = { uuid: created.uuid, target: project.pbxNativeTargetSection()[created.uuid] };
    }
    const { uuid: targetUuid, target } = targetEntry;
    const group = ensureTargetGroup(project);
    configureTarget(project, target, settings);
    ensureBuildPhases(project, targetUuid);
    ensureFile(project, "ShareViewController.swift", group, targetUuid, true);
    ensureFile(project, `${TARGET_NAME}-Info.plist`, group, targetUuid);
    ensureFile(project, `${TARGET_NAME}.entitlements`, group, targetUuid);
    if (!project.hasFile("System/Library/Frameworks/Social.framework")) {
      project.addFramework("Social.framework", { target: targetUuid });
    }
    return rawModConfig;
  });
};

module.exports = withNautiloShareExtension;
module.exports.shareExtensionConfig = shareExtensionConfig;
module.exports.constants = {
  APPLE_DEVELOPMENT_TEAM,
  MAX_TEXT_OR_URL_BYTES,
  MAX_INBOUND_FILE_BYTES,
  FILE_INBOX_DIRECTORY,
  FILE_PAYLOAD_KEY,
  PAYLOAD_KEY,
  TARGET_DIRECTORY,
  TARGET_NAME,
};
