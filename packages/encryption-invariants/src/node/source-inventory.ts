import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  COVERAGE_SURFACES,
  type CoverageSurface,
} from "../model";
import type { InventoryObservation } from "../registry";

export const SOURCE_INVENTORY_SCHEMA_VERSION = 1 as const;

export type SourceDeclarationRole =
  | "store"
  | "writer"
  | "emitter"
  | "archive"
  | "processor";

export type SourceEvidence = {
  readonly path: string;
  readonly symbols: readonly string[];
};

/**
 * A reviewed semantic declaration. These declarations are the inventory
 * authority for non-DB source surfaces; the scanner below is deliberately
 * only an omission alarm.
 */
export type SourceDeclaration = {
  readonly id: string;
  readonly surface: CoverageSurface;
  readonly locator: string;
  readonly role: SourceDeclarationRole;
  readonly evidence: readonly SourceEvidence[];
};

const declaration = <T extends SourceDeclaration>(value: T): T => value;

export const SOURCE_DECLARATIONS: readonly SourceDeclaration[] = [
  declaration({
    id: "source.file.desktop-mini-app-draft-recovery",
    surface: "file",
    locator: "apps/desktop/electron/mini-app-draft-recovery.ts#MiniAppDraftRecoveryStore",
    role: "store",
    evidence: [{
      path: "apps/desktop/electron/mini-app-draft-recovery.ts",
      symbols: ["MiniAppDraftRecoveryStore", "#requireProtection", "basic_text", "safeStorage.encryptString", "Buffer.concat([HEADER, encrypted])"],
    }, {
      path: "apps/desktop/electron/main.ts",
      symbols: ["rootDir: miniAppDraftRecoveryDirPath()", "safeStorage"],
    }],
  }),
  declaration({
    id: "source.file.runtime-paths",
    surface: "file",
    locator: "packages/config/src/runtime-paths.ts#resolveNautiloRuntimePaths",
    role: "store",
    evidence: [{
      path: "packages/config/src/runtime-paths.ts",
      symbols: ["resolveNautiloRuntimePaths", "logsDir", "transcriptsDir", "scratchDir", "vaultDir"],
    }],
  }),
  declaration({
    id: "source.file.server-storage-roots",
    surface: "file",
    locator: "packages/config/src/instance-defaults.ts#server-storage-roots",
    role: "store",
    evidence: [{
      path: "packages/config/src/instance-defaults.ts",
      symbols: ["getArtifactsRoot", "getAppsRoot", "getProfileAvatarsRoot", "getServerIconRoot"],
    }],
  }),
  declaration({
    id: "source.file.workspace-mutation-content",
    surface: "file",
    locator: "packages/server/src/lib/workspace-document-mutation-content.ts#writeWorkspaceDocumentMutationContent",
    role: "writer",
    evidence: [{
      path: "packages/server/src/lib/workspace-document-mutation-content.ts",
      symbols: ["writeWorkspaceDocumentMutationContent", "writeWorkspaceDocumentMutationLiveContent"],
    }],
  }),
  declaration({
    id: "source.file.message-attachments",
    surface: "file",
    locator: "packages/server/src/routes/message-attachments.ts#attachmentBlobPath",
    role: "writer",
    evidence: [{
      path: "packages/server/src/routes/message-attachments.ts",
      symbols: ["attachmentBlobPath", "messageAttachmentRoutes"],
    }],
  }),
  declaration({
    id: "source.file.profile-avatars",
    surface: "file",
    locator: "packages/server/src/routes/_helpers/avatar.ts#getAvatarBlobDir",
    role: "writer",
    evidence: [{
      path: "packages/server/src/routes/_helpers/avatar.ts",
      symbols: [
        "getAvatarBlobDir",
        "pickAvatarBlobFile",
        "writeFileSync(thumbPath, buf)",
      ],
    }],
  }),
  declaration({
    id: "source.file.mini-app-source",
    surface: "file",
    locator: "packages/server/src/apps/app-source-store.ts#writeAppSourceFile",
    role: "writer",
    evidence: [{
      path: "packages/server/src/apps/app-source-store.ts",
      symbols: ["writeAppSourceFile", "resolveAppSourcePath"],
    }],
  }),
  declaration({
    id: "source.file.profile-bundle-journal",
    surface: "file",
    locator: "packages/server/src/routes/profile-bundle.ts#.profile-bundle-artifact-journal",
    role: "writer",
    evidence: [{
      path: "packages/server/src/routes/profile-bundle.ts",
      symbols: ["JOURNAL_SUBDIR", "defaultArtifactJournalDir"],
    }],
  }),
  declaration({
    id: "source.file.profile-bundle-staging",
    surface: "file",
    locator: "packages/server/src/routes/profile-bundle.ts#nautilo-profile-bundle-stage",
    role: "writer",
    evidence: [{
      path: "packages/server/src/routes/profile-bundle.ts",
      symbols: ["defaultSpoolDir", "nautilo-profile-bundle-stage"],
    }],
  }),
  declaration({
    id: "source.file.desktop-path-catalog",
    surface: "file",
    locator: "apps/desktop/electron/paths.ts#desktop-persistence-paths",
    role: "store",
    evidence: [{
      path: "apps/desktop/electron/paths.ts",
      symbols: ["localFileHistoryDirPath", "desktopFilesystemGrantsFilePath", "workstationProfilesFilePath", "recentServersFilePath"],
    }],
  }),
  declaration({
    id: "source.file.desktop-local-history",
    surface: "file",
    locator: "apps/desktop/electron/local-file-history/storage.ts#createJournalStorage",
    role: "writer",
    evidence: [{
      path: "apps/desktop/electron/local-file-history/storage.ts",
      symbols: ["createJournalStorage", "PAYLOADS_DIR", "writeAtomicJson"],
    }],
  }),
  declaration({
    id: "source.file.desktop-filesystem-grants",
    surface: "file",
    locator: "apps/desktop/electron/desktop-filesystem-grants/storage.ts#createDesktopFilesystemGrantStorage",
    role: "writer",
    evidence: [{
      path: "apps/desktop/electron/desktop-filesystem-grants/storage.ts",
      symbols: ["createDesktopFilesystemGrantStorage", "temporaryPath"],
    }],
  }),
  declaration({
    id: "source.file.desktop-kdbx",
    surface: "file",
    locator: "apps/desktop/electron/passwords/kdbx-store.ts#KdbxPasswordStore",
    role: "writer",
    evidence: [{
      path: "apps/desktop/electron/passwords/kdbx-store.ts",
      symbols: ["KdbxStore", "writeFile", "rename"],
    }],
  }),
  declaration({
    id: "source.file.desktop-document-staging",
    surface: "file",
    locator: "apps/desktop/electron/local-file-dispatch/document-chunks.ts#nautilo-document-staging",
    role: "writer",
    evidence: [{
      path: "apps/desktop/electron/local-file-dispatch/document-chunks.ts",
      symbols: ["STAGING_DIR", "nautilo-document-staging"],
    }],
  }),
  declaration({
    id: "source.file.office-temporaries",
    surface: "file",
    locator: "packages/agent/src/tools/office/officecli.ts#officecli-temporary-roots",
    role: "writer",
    evidence: [{
      path: "packages/agent/src/tools/office/officecli.ts",
      symbols: ["officecli-images-", "officecli-input-", "officecli-work-"],
    }],
  }),
  declaration({
    id: "source.file.desktop-browser-capture-temporaries",
    surface: "file",
    locator: "apps/desktop/electron/relay.ts#browser-capture-temporary-roots",
    role: "writer",
    evidence: [{
      path: "apps/desktop/electron/relay.ts",
      symbols: ["nautilo-browser-shots"],
    }],
  }),
  declaration({
    id: "source.file.desktop-media-extract-temporaries",
    surface: "file",
    locator:
      "apps/desktop/electron/relay-dispatch/media.ts#media-extract-temporary-roots",
    role: "writer",
    evidence: [{
      path: "apps/desktop/electron/relay-dispatch/media.ts",
      symbols: ["nautilo-media-extract-", "mkdtemp", "writeFile"],
    }],
  }),
  declaration({
    id: "source.cache.mobile-artifacts",
    surface: "cache",
    locator: "apps/mobile/src/lib/artifact-bytes.ts#Paths.cache/nautilo-artifacts",
    role: "writer",
    evidence: [{
      path: "apps/mobile/src/lib/artifact-bytes.ts",
      symbols: ["Paths.cache", "nautilo-artifacts", "downloadFileAsync"],
    }],
  }),
  declaration({
    id: "source.cache.workbench-viewer",
    surface: "cache",
    locator: "apps/workbench/src/lib/persisted-viewer-cache.ts#nautilo.viewer.last-known.v2",
    role: "writer",
    evidence: [{
      path: "apps/workbench/src/lib/persisted-viewer-cache.ts",
      symbols: ["nautilo.viewer.last-known.v2", "writeLastKnownViewer"],
    }],
  }),
  declaration({
    id: "source.cache.workbench-ws-history",
    surface: "cache",
    locator: "apps/workbench/src/lib/persisted-ws-history.ts#nautilo.ws.has-ever-been-open.v1",
    role: "writer",
    evidence: [{
      path: "apps/workbench/src/lib/persisted-ws-history.ts",
      symbols: ["nautilo.ws.has-ever-been-open.v1", "markHasEverBeenOpen"],
    }],
  }),
  declaration({
    id: "source.cache.model-capabilities",
    surface: "cache",
    locator: "packages/model-capabilities/src/cache.ts#model-capabilities-cache.json",
    role: "writer",
    evidence: [{
      path: "packages/model-capabilities/src/cache.ts",
      symbols: ["model-capabilities-cache.json", "writeCapabilitiesCacheToDisk"],
    }],
  }),
  declaration({
    id: "source.cache.provider-catalog",
    surface: "cache",
    locator: "packages/server/src/lib/provider-catalog-cache.ts#createDbProviderCatalogCache",
    role: "writer",
    evidence: [{
      path: "packages/server/src/lib/provider-catalog-cache.ts",
      symbols: ["createDbProviderCatalogCache", "providerCatalogCache"],
    }],
  }),
  declaration({
    id: "source.cache.workspace-patches",
    surface: "cache",
    locator: "packages/server/src/lib/workspace-artifact-patch-cache.ts#cacheByArtifactId",
    role: "writer",
    evidence: [{
      path: "packages/server/src/lib/workspace-artifact-patch-cache.ts",
      symbols: ["cacheByArtifactId", "appendWorkspaceArtifactPatchEvent"],
    }],
  }),
  declaration({
    id: "source.cache.explainer-media",
    surface: "cache",
    locator: "packages/server/src/routes/explainer-media.ts#explainer-media-cache",
    role: "writer",
    evidence: [{
      path: "packages/server/src/routes/explainer-media.ts",
      symbols: ["defaultCacheDir", "explainer-media-cache"],
    }],
  }),
  declaration({
    id: "source.backup.dev-snapshot",
    surface: "backup",
    locator: "bin/nautilo-dev/src/commands/save.ts#save",
    role: "archive",
    evidence: [{
      path: "bin/nautilo-dev/src/commands/save.ts",
      symbols: ["export async function save", "database.sql.gz", "nautilo-home.tar.gz"],
    }],
  }),
  declaration({
    id: "source.backup.compose-bundle",
    surface: "backup",
    locator: "deploy/compose-driver/src/ComposeDriver.ts#backup",
    role: "archive",
    evidence: [{
      path: "deploy/compose-driver/src/ComposeDriver.ts",
      symbols: ["async backup(", "artifacts.tgz", "logto_nautilo.sql.gz", "plaintext secrets"],
    }],
  }),
  declaration({
    id: "source.backup.compose-manifest",
    surface: "backup",
    locator: "deploy/compose-driver/src/backup-manifest.ts#BUNDLE_INTEGRITY_FILES",
    role: "archive",
    evidence: [{
      path: "deploy/compose-driver/src/backup-manifest.ts",
      symbols: ["BUNDLE_INTEGRITY_FILES", "operatorFiles"],
    }],
  }),
  declaration({
    id: "source.export.profile-bundle",
    surface: "export",
    locator: "apps/cli/src/lib/profile-bundle.ts#createFileArtifactStreamIo",
    role: "archive",
    evidence: [{
      path: "apps/cli/src/lib/profile-bundle.ts",
      symbols: ["createFileArtifactStreamIo", "deriveArtifactSidecarPath"],
    }],
  }),
  declaration({
    id: "source.export.runtime-root",
    surface: "export",
    locator: "packages/config/src/runtime-paths.ts#exportsDir",
    role: "store",
    evidence: [{
      path: "packages/config/src/runtime-paths.ts",
      symbols: ["exportsDir", "nautilo_home_exports_dir"],
    }],
  }),
  declaration({
    id: "source.log.generic",
    surface: "log",
    locator: "packages/logger/src/logger.ts#emit",
    role: "emitter",
    evidence: [{
      path: "packages/logger/src/logger.ts",
      symbols: ["function emit", "JSON.stringify", "appendFileSync"],
    }],
  }),
  declaration({
    id: "source.log.security-audit",
    surface: "log",
    locator: "packages/server/src/lib/security-audit-log.ts#writeSecurityAuditEvent",
    role: "emitter",
    evidence: [{
      path: "packages/server/src/lib/security-audit-log.ts",
      symbols: ["writeSecurityAuditEvent", "writeSync", "fsyncSync"],
    }],
  }),
  declaration({
    id: "source.log.config-audit",
    surface: "log",
    locator: "packages/config-guard/src/audit-log.ts#appendAuditEntry",
    role: "emitter",
    evidence: [{
      path: "packages/config-guard/src/audit-log.ts",
      symbols: ["appendAuditEntry", "appendAuditEntrySync"],
    }],
  }),
  declaration({
    id: "source.log.mcp-stderr",
    surface: "log",
    locator: "packages/mcp-client/src/transports/stdio.ts#mcp-stderr",
    role: "emitter",
    evidence: [{
      path: "packages/mcp-client/src/transports/stdio.ts",
      symbols: ["mcp-stderr-", "createWriteStream"],
    }],
  }),
  declaration({
    id: "source.log.desktop-auth-audit",
    surface: "log",
    locator: "apps/desktop/electron/auth/local-auth-audit.ts#appendAuthBundleClearedAudit",
    role: "emitter",
    evidence: [{
      path: "apps/desktop/electron/auth/local-auth-audit.ts",
      symbols: ["appendAuthBundleClearedAudit", "audit.log"],
    }],
  }),
  declaration({
    id: "source.notification.desktop-room-label",
    surface: "notification",
    locator: "apps/desktop/electron/chat-notifications.ts#showImportantMessage",
    role: "emitter",
    evidence: [{
      path: "apps/desktop/electron/chat-notifications.ts",
      symbols: ["showImportantMessage", "New message in ${payload.roomLabel}"],
    }],
  }),
  declaration({
    id: "source.notification.session-buffer",
    surface: "notification",
    locator: "packages/db/src/schema/session-notifications.ts#sessionNotifications",
    role: "store",
    evidence: [{
      path: "packages/db/src/schema/session-notifications.ts",
      symbols: ["sessionNotifications", "session_notifications"],
    }],
  }),
  declaration({
    id: "source.notification.artifact-events",
    surface: "notification",
    locator: "packages/db/src/schema/pending-artifact-events.ts#pendingArtifactEvents",
    role: "store",
    evidence: [{
      path: "packages/db/src/schema/pending-artifact-events.ts",
      symbols: ["pendingArtifactEvents", "pending_artifact_events"],
    }],
  }),
  declaration({
    id: "source.notification.workspace-outbox",
    surface: "notification",
    locator: "packages/db/src/schema/workspace-document-mutations.ts#workspaceDocumentMutationOutbox",
    role: "store",
    evidence: [{
      path: "packages/db/src/schema/workspace-document-mutations.ts",
      symbols: ["workspaceDocumentMutationOutbox", "workspace_document_mutation_outbox"],
    }],
  }),
  declaration({
    id: "source.processor.chat-model-factory",
    surface: "processor",
    locator: "packages/agent/src/providers/factory.ts#create-provider-model",
    role: "processor",
    evidence: [{
      path: "packages/agent/src/providers/factory.ts",
      symbols: ["ChatOpenAI", "ChatAnthropic", "ChatGoogleGenerativeAI", "ChatFireworks", "ChatXAI"],
    }],
  }),
  declaration({
    id: "source.processor.chat-model-invocation",
    surface: "processor",
    locator: "packages/agent/src/utils/chat-model-invocation.ts#invokeModelWithAttemptSupervisor",
    role: "processor",
    evidence: [{
      path: "packages/agent/src/utils/chat-model-invocation.ts",
      symbols: ["invokeModelWithAttemptSupervisor", "model.invoke"],
    }],
  }),
  declaration({
    id: "source.processor.embeddings",
    surface: "processor",
    locator: "packages/agent/src/store/embeddings.ts#embedTexts",
    role: "processor",
    evidence: [{
      path: "packages/agent/src/store/embeddings.ts",
      symbols: ["embedTexts", "api.openai.com/v1/embeddings"],
    }],
  }),
  declaration({
    id: "source.processor.image-generation",
    surface: "processor",
    locator: "packages/agent/src/image-gen/#image-generation-providers",
    role: "processor",
    evidence: [
      {
        path: "packages/agent/src/image-gen/openai.ts",
        symbols: ["generateImagesOpenAi", "api.openai.com/v1/images/generations"],
      },
      {
        path: "packages/agent/src/image-gen/google.ts",
        symbols: ["generateImagesGoogle", "generativelanguage.googleapis.com"],
      },
      {
        path: "packages/agent/src/image-gen/openrouter.ts",
        symbols: ["generateImagesOpenRouter", "openrouter.ai/api/v1/images"],
      },
      {
        path: "packages/agent/src/image-gen/venice.ts",
        symbols: ["generateImagesVenice", "VENICE_IMAGE_GENERATION_URL"],
      },
    ],
  }),
  declaration({
    id: "source.processor.transcription",
    surface: "processor",
    locator: "packages/attachments/src/transcription/#remote-transcription",
    role: "processor",
    evidence: [
      {
        path: "packages/attachments/src/transcription/elevenlabs.ts",
        symbols: ["ElevenLabsTranscriptionProvider", "fetch"],
      },
      {
        path: "packages/attachments/src/transcription/groq.ts",
        symbols: ["GroqTranscriptionProvider", "fetch"],
      },
    ],
  }),
  declaration({
    id: "source.processor.tts",
    surface: "processor",
    locator: "packages/server/src/realtime/tts-service.ts#TtsService",
    role: "processor",
    evidence: [{
      path: "packages/server/src/realtime/tts-service.ts",
      symbols: ["class TtsService", "fetch"],
    }],
  }),
  declaration({
    id: "source.processor.tavily",
    surface: "processor",
    locator: "packages/agent/src/tools/utilities/#tavily",
    role: "processor",
    evidence: [
      {
        path: "packages/agent/src/tools/utilities/web-search.ts",
        symbols: ["buildTavilySearchFetcher", "api.tavily.com/search"],
      },
      {
        path: "packages/agent/src/tools/utilities/read-webpage.ts",
        symbols: ["buildReadWebpageFetcher", "api.tavily.com/extract"],
      },
    ],
  }),
  declaration({
    id: "source.processor.cloudconvert",
    surface: "processor",
    locator: "packages/cloudconvert/src/service.ts#convertWithClient",
    role: "processor",
    evidence: [{
      path: "packages/cloudconvert/src/service.ts",
      symbols: ["convertWithClient", "import/base64"],
    }],
  }),
  declaration({
    id: "source.processor.libreoffice",
    surface: "processor",
    locator: "packages/loffice/src/client.ts#LofficeClient.call",
    role: "processor",
    evidence: [{
      path: "packages/loffice/src/client.ts",
      symbols: ["class LofficeClient", "async call", "buildMethodCall"],
    }],
  }),
  declaration({
    id: "source.processor.wopi",
    surface: "processor",
    locator: "packages/server/src/routes/wopi.ts#wopiRoutes",
    role: "processor",
    evidence: [{
      path: "packages/server/src/routes/wopi.ts",
      symbols: ["wopiRoutes", "PutFile", "persistArtifactBytes"],
    }],
  }),
  declaration({
    id: "source.processor.officecli",
    surface: "processor",
    locator: "packages/agent/src/tools/office/officecli.ts#runOfficeCli",
    role: "processor",
    evidence: [{
      path: "packages/agent/src/tools/office/officecli.ts",
      symbols: ["createOfficeCliTool", "mkdtemp"],
    }],
  }),
  declaration({
    id: "source.processor.mcp",
    surface: "processor",
    locator: "packages/mcp-client/src/tool-factory.ts#mcpToolToLangChain",
    role: "processor",
    evidence: [
      {
        path: "packages/mcp-client/src/tool-factory.ts",
        symbols: ["mcpToolToLangChain", "dispatch(mcpTool.name"],
      },
      {
        path: "packages/mcp-client/src/transports/streamable-http.ts",
        symbols: ["createStreamableHttpTransport", "StreamableHTTPClientTransport"],
      },
    ],
  }),
  declaration({
    id: "source.processor.desktop-relay-dispatch",
    surface: "processor",
    locator:
      "apps/desktop/electron/relay-dispatch/router.ts#createFixedDesktopDispatchRouter",
    role: "processor",
    evidence: [
      {
        path: "apps/desktop/electron/relay-dispatch/router.ts",
        symbols: ["createFixedDesktopDispatchRouter", "FIXED_DESKTOP_DISPATCH_ORDER"],
      },
      {
        path: "apps/desktop/electron/relay-dispatch/media.ts",
        symbols: ["execFile", "dispatchMediaSession"],
      },
      {
        path: "apps/desktop/electron/relay-dispatch/google-workspace.ts",
        symbols: ["createGoogleWorkspaceDispatchHandler", "ports.execFile"],
      },
    ],
  }),
  declaration({
    id: "source.processor.google-workspace",
    surface: "processor",
    locator: "packages/agent/src/tools/google-workspace/google-workspace.ts#createGoogleWorkspaceTool",
    role: "processor",
    evidence: [{
      path: "packages/agent/src/tools/google-workspace/google-workspace.ts",
      symbols: ["createGoogleWorkspaceTool", "local `gog` Google Workspace CLI"],
    }],
  }),
].sort((a, b) =>
  `${a.surface}:${a.locator}:${a.id}`.localeCompare(
    `${b.surface}:${b.locator}:${b.id}`,
  ),
);

export type SourceInventoryInspection = {
  readonly observations: readonly InventoryObservation[];
  readonly errors: readonly string[];
};

function portablePath(value: string): string {
  return value.split(sep).join("/");
}

function isContainedRelativePath(value: string): boolean {
  if (value.trim() !== value || value.length === 0 || isAbsolute(value)) {
    return false;
  }
  const portable = portablePath(value);
  return portable !== ".."
    && !portable.startsWith("../")
    && !portable.includes("/../");
}

function stableSourceId(value: string): boolean {
  return /^source\.[a-z0-9]+(?:[._-][a-z0-9]+)+$/.test(value);
}

function duplicateValues(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const duplicate = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicate.add(value);
    else seen.add(value);
  }
  return [...duplicate].sort();
}

export async function inspectDeclaredSourceInventory(input: {
  readonly repoRoot: string;
  readonly declarations?: readonly SourceDeclaration[];
}): Promise<SourceInventoryInspection> {
  const declarations = input.declarations ?? SOURCE_DECLARATIONS;
  const repoRoot = resolve(input.repoRoot);
  const errors: string[] = [];

  for (const id of duplicateValues(declarations.map((item) => item.id))) {
    errors.push(`duplicate source declaration id: ${id}`);
  }
  for (const locator of duplicateValues(declarations.map((item) => item.locator))) {
    errors.push(`duplicate source declaration locator: ${locator}`);
  }

  for (const item of declarations) {
    if (!stableSourceId(item.id)) {
      errors.push(`${item.id}: invalid stable source declaration id`);
    }
    if (!COVERAGE_SURFACES.includes(item.surface)) {
      errors.push(`${item.id}: invalid coverage surface`);
    }
    if (!isContainedRelativePath(item.locator.split("#", 1)[0] ?? "")) {
      errors.push(`${item.id}: locator must be repository-relative`);
    }
    if (item.evidence.length === 0) {
      errors.push(`${item.id}: declaration has no evidence`);
      continue;
    }
    for (const evidence of item.evidence) {
      if (!isContainedRelativePath(evidence.path)) {
        errors.push(`${item.id}: evidence path must be repository-relative`);
        continue;
      }
      const absolute = resolve(repoRoot, evidence.path);
      const relativeToRoot = portablePath(relative(repoRoot, absolute));
      if (!isContainedRelativePath(relativeToRoot) || !existsSync(absolute)) {
        errors.push(`${item.id}: missing evidence file ${portablePath(evidence.path)}`);
        continue;
      }
      const source = await readFile(absolute, "utf8");
      for (const symbol of evidence.symbols) {
        if (!source.includes(symbol)) {
          errors.push(
            `${item.id}: ${portablePath(evidence.path)} is missing symbol ${symbol}`,
          );
        }
      }
    }
  }

  const observations = declarations
    .map(({ id, surface, locator }): InventoryObservation => ({
      id,
      surface,
      locator: portablePath(locator),
    }))
    .sort((a, b) =>
      `${a.surface}:${a.locator}:${a.id}`.localeCompare(
        `${b.surface}:${b.locator}:${b.id}`,
      ),
    );

  return { observations, errors: errors.sort() };
}

export type SourceExclusion =
  | {
      readonly kind: "path_prefix";
      readonly value: string;
      readonly reason: string;
    }
  | {
      readonly kind: "path_segment";
      readonly value: string;
      readonly reason: string;
    }
  | {
      readonly kind: "file_suffix";
      readonly value: string;
      readonly reason: string;
    };

/**
 * Exact matches only: prefixes stop at a path boundary, segments compare for
 * equality, and suffixes compare literally. No glob or substring suppression
 * is allowed.
 */
export const DEFAULT_SOURCE_SCAN_EXCLUSIONS: readonly SourceExclusion[] = [
  {
    kind: "path_prefix",
    value: "packages/encryption-invariants",
    reason: "Wave 0 inventory tooling is not a product plaintext data boundary.",
  },
  {
    kind: "path_prefix",
    value: "packages/lattice-crypto",
    reason:
      "M221 is a dormant audited crypto baseline with no product consumer; "
      + "package-local storage, logs, and build tools are not active plaintext authority.",
  },
  {
    kind: "path_prefix",
    value: "apps/desktop/scratch",
    reason: "Explicit experimental spike tree, never production runtime authority.",
  },
  {
    kind: "path_prefix",
    value: "apps/desktop/vendor/relay-host",
    reason: "Generated digest-verified Relay Host bundle output; its TypeScript source and build boundary are inventoried separately.",
  },
  {
    kind: "path_prefix",
    value: "packages/db/src/migrations/meta",
    reason: "Generated Drizzle snapshots are handled by the schema inventory.",
  },
  {
    kind: "path_segment",
    value: "tests",
    reason: "Executable tests and their temporary writers are not production authority.",
  },
  {
    kind: "path_segment",
    value: "fixtures",
    reason: "Synthetic fixtures are not production authority.",
  },
  {
    kind: "path_segment",
    value: "node_modules",
    reason: "Third-party dependencies are outside repository production source.",
  },
  {
    kind: "path_segment",
    value: "dist",
    reason: "Generated distribution output is not source authority.",
  },
  {
    kind: "path_segment",
    value: "release",
    reason: "Generated packaged output is not source authority.",
  },
  {
    kind: "file_suffix",
    value: ".test.ts",
    reason: "Co-located TypeScript unit test.",
  },
  {
    kind: "file_suffix",
    value: ".test.tsx",
    reason: "Co-located TSX unit test.",
  },
  {
    kind: "file_suffix",
    value: ".spec.ts",
    reason: "Co-located TypeScript specification test.",
  },
] as const;

export const DEFAULT_SOURCE_SCAN_ROOTS = [
  "apps",
  "bin",
  "deploy",
  "packages",
] as const;

export type SourceAlarmKind =
  | "filesystem_write"
  | "network_processor"
  | "subprocess_processor"
  | "log_emitter"
  | "notification_emitter"
  | "temporary_storage"
  | "backup_export";

export type SourceAlarm = {
  readonly kind: SourceAlarmKind;
  readonly path: string;
  readonly line: number;
  readonly locator: string;
  readonly evidence: string;
};

type AlarmPattern = {
  readonly kind: SourceAlarmKind;
  readonly expression: RegExp;
};

const ALARM_PATTERNS: readonly AlarmPattern[] = [
  {
    kind: "filesystem_write",
    expression: /\b(?:writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream|copyFileSync|copyFile|renameSync|rename|linkSync|link)\s*\(/g,
  },
  {
    kind: "network_processor",
    expression: /\b(?:fetch)\s*\(|\bnew\s+Chat(?:OpenAI|Anthropic|GoogleGenerativeAI|Fireworks|XAI|TogetherAI)\s*\(/g,
  },
  {
    kind: "subprocess_processor",
    expression: /\b(?:Bun\.spawn|spawnSync|spawn|execFileSync|execFile|execSync)\s*\(/g,
  },
  {
    kind: "log_emitter",
    expression: /\b(?:console|logger|log)\.(?:debug|info|log|warn|error)\s*\(/g,
  },
  {
    kind: "notification_emitter",
    expression: /\bnew\s+Notification\s*\(|\bshowImportantMessage\s*\(/g,
  },
  {
    kind: "temporary_storage",
    expression: /\b(?:mkdtempSync|mkdtemp|tmpdir)\s*\(/g,
  },
  {
    kind: "backup_export",
    expression: /\b(?:backup|serializeProfileBundle|serializeArtifactStream|exportProfileBundle)\s*\(/g,
  },
] as const;

const SOURCE_FILE_SUFFIXES = [".ts", ".tsx", ".js", ".mjs", ".cjs"] as const;

function isExcluded(path: string, exclusions: readonly SourceExclusion[]): boolean {
  const segments = path.split("/");
  return exclusions.some((exclusion) => {
    if (exclusion.kind === "path_prefix") {
      return path === exclusion.value || path.startsWith(`${exclusion.value}/`);
    }
    if (exclusion.kind === "path_segment") {
      return segments.includes(exclusion.value);
    }
    return path.endsWith(exclusion.value);
  });
}

function validateSourceExclusion(exclusion: SourceExclusion): string[] {
  const errors: string[] = [];
  const exactValue =
    exclusion.value.trim() === exclusion.value
    && exclusion.value.length > 0
    && !/[*?[\]{}]/.test(exclusion.value)
    && !isAbsolute(exclusion.value)
    && exclusion.value !== ".."
    && !exclusion.value.startsWith("../")
    && !exclusion.value.includes("/../");
  const shapeMatchesKind =
    exclusion.kind === "path_segment"
      ? !exclusion.value.includes("/")
      : exclusion.kind === "file_suffix"
        ? !exclusion.value.includes("/")
        : true;
  if (!exactValue || !shapeMatchesKind) {
    errors.push("value must be exact and repository-relative");
  }
  if (exclusion.reason.trim().length < 12) {
    errors.push("reason must be descriptive");
  }
  return errors;
}

function isSourceFile(path: string): boolean {
  return SOURCE_FILE_SUFFIXES.some((suffix) => path.endsWith(suffix));
}

async function filesUnder(
  repoRoot: string,
  relativeRoot: string,
  exclusions: readonly SourceExclusion[],
): Promise<string[]> {
  const absoluteRoot = resolve(repoRoot, relativeRoot);
  const normalizedRoot = portablePath(relative(repoRoot, absoluteRoot));
  if (!isContainedRelativePath(normalizedRoot) || !existsSync(absoluteRoot)) {
    return [];
  }
  if (isExcluded(normalizedRoot, exclusions)) return [];
  const metadata = await stat(absoluteRoot);
  if (metadata.isFile()) {
    return isSourceFile(normalizedRoot) ? [normalizedRoot] : [];
  }

  const files: string[] = [];
  const entries = await readdir(absoluteRoot, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const child = portablePath(`${normalizedRoot}/${entry.name}`);
    if (isExcluded(child, exclusions)) continue;
    if (entry.isDirectory()) {
      files.push(...await filesUnder(repoRoot, child, exclusions));
    } else if (entry.isFile() && isSourceFile(child)) {
      files.push(child);
    }
  }
  return files;
}

/**
 * Remove comments and string bodies while retaining newlines and token
 * positions. This prevents prose examples from becoming alarms and preserves
 * deterministic line numbers. Template interpolation is intentionally not
 * parsed: this remains an alarm scanner, not an AST completeness claim.
 */
function executableSource(source: string): string {
  let state: "code" | "line_comment" | "block_comment" | "single" | "double" | "template" = "code";
  let escaped = false;
  let output = "";

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    const next = source[index + 1];

    if (state === "line_comment") {
      if (char === "\n") {
        state = "code";
        output += "\n";
      } else {
        output += " ";
      }
      continue;
    }
    if (state === "block_comment") {
      if (char === "*" && next === "/") {
        output += "  ";
        index += 1;
        state = "code";
      } else {
        output += char === "\n" ? "\n" : " ";
      }
      continue;
    }
    if (state !== "code") {
      if (char === "\n") {
        output += "\n";
        if (state !== "template") state = "code";
        escaped = false;
        continue;
      }
      output += " ";
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (
        (state === "single" && char === "'")
        || (state === "double" && char === "\"")
        || (state === "template" && char === "`")
      ) {
        state = "code";
      }
      continue;
    }

    if (char === "/" && next === "/") {
      output += "  ";
      index += 1;
      state = "line_comment";
    } else if (char === "/" && next === "*") {
      output += "  ";
      index += 1;
      state = "block_comment";
    } else if (char === "'") {
      output += " ";
      state = "single";
    } else if (char === "\"") {
      output += " ";
      state = "double";
    } else if (char === "`") {
      output += " ";
      state = "template";
    } else {
      output += char;
    }
  }
  return output;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function loggerCallExpression(source: string): RegExp {
  const localNames = new Set<string>();
  // A named-import body cannot span another import declaration. Otherwise
  // an earlier unrelated import can swallow the first real logger binding.
  const namedImport =
    /import\s*\{([^{}]*)\}\s*from\s*["']@nautilo\/logger["']/g;
  for (const match of source.matchAll(namedImport)) {
    for (const rawPart of (match[1] ?? "").split(",")) {
      const part = rawPart.trim().replace(/^type\s+/, "");
      const parsed = part.match(
        /^(?:debug|log|warn|error)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/,
      );
      if (!parsed) continue;
      localNames.add(parsed[1] ?? part);
    }
  }

  const namespaceNames = new Set<string>();
  const namespaceImport =
    /import\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s*["']@nautilo\/logger["']/g;
  for (const match of source.matchAll(namespaceImport)) {
    if (match[1]) namespaceNames.add(match[1]);
  }

  const alternatives = [
    String.raw`\b(?:console|logger|log)\.(?:debug|info|log|warn|error)\s*\(`,
    ...[...localNames].sort().map(
      (name) => String.raw`\b${escapeRegExp(name)}\s*\(`,
    ),
    ...[...namespaceNames].sort().map(
      (name) =>
        String.raw`\b${escapeRegExp(name)}\.(?:debug|info|log|warn|error)\s*\(`,
    ),
  ];
  return new RegExp(alternatives.join("|"), "g");
}

export async function scanSourceAlarms(input: {
  readonly repoRoot: string;
  readonly scanRoots?: readonly string[];
  readonly exclusions?: readonly SourceExclusion[];
}): Promise<{ readonly alarms: readonly SourceAlarm[]; readonly errors: readonly string[] }> {
  const repoRoot = resolve(input.repoRoot);
  const scanRoots = input.scanRoots ?? DEFAULT_SOURCE_SCAN_ROOTS;
  const requestedExclusions = input.exclusions ?? DEFAULT_SOURCE_SCAN_EXCLUSIONS;
  const errors: string[] = [];
  const exclusions: SourceExclusion[] = [];
  const files = new Set<string>();

  for (const exclusion of requestedExclusions) {
    const validationErrors = validateSourceExclusion(exclusion);
    if (validationErrors.length === 0) {
      exclusions.push(exclusion);
      continue;
    }
    for (const error of validationErrors) {
      errors.push(
        `invalid source exclusion ${exclusion.kind}:${portablePath(exclusion.value)}: ${error}`,
      );
    }
  }

  for (const scanRoot of scanRoots) {
    if (!isContainedRelativePath(scanRoot)) {
      errors.push(`scan root must be repository-relative: ${portablePath(scanRoot)}`);
      continue;
    }
    const absolute = resolve(repoRoot, scanRoot);
    if (!existsSync(absolute)) {
      errors.push(`missing scan root: ${portablePath(scanRoot)}`);
      continue;
    }
    for (const file of await filesUnder(repoRoot, scanRoot, exclusions)) {
      files.add(file);
    }
  }

  const alarms: SourceAlarm[] = [];
  const locatorOccurrences = new Map<string, number>();
  for (const path of [...files].sort()) {
    const rawSource = await readFile(resolve(repoRoot, path), "utf8");
    const source = executableSource(rawSource);
    const lines = source.split("\n");
    const patterns = ALARM_PATTERNS.map((pattern) =>
      pattern.kind === "log_emitter"
        ? { ...pattern, expression: loggerCallExpression(rawSource) }
        : pattern,
    );
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      for (const pattern of patterns) {
        pattern.expression.lastIndex = 0;
        const match = pattern.expression.exec(line);
        if (!match) continue;
        const lineNumber = index + 1;
        const evidence = match[0].trim();
        const normalizedLine = line.trim().replace(/\s+/g, " ");
        const signature = createHash("sha256")
          .update(`${pattern.kind}\0${normalizedLine}\0${evidence}`)
          .digest("hex")
          .slice(0, 16);
        const locatorBase = `${path}#${pattern.kind}:${signature}`;
        const occurrence = (locatorOccurrences.get(locatorBase) ?? 0) + 1;
        locatorOccurrences.set(locatorBase, occurrence);
        alarms.push({
          kind: pattern.kind,
          path,
          line: lineNumber,
          locator: `${locatorBase}:${occurrence}`,
          evidence,
        });
      }
    }
  }

  alarms.sort((a, b) =>
    `${a.path}:${String(a.line).padStart(9, "0")}:${a.kind}`.localeCompare(
      `${b.path}:${String(b.line).padStart(9, "0")}:${b.kind}`,
    ),
  );
  return { alarms, errors: errors.sort() };
}
