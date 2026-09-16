/**
 * D419's reviewed, declarative exposure taxonomy.
 *
 * This deliberately does not change catalog registration or binding. Phase 2
 * will use it to attach exposure metadata and resolve activated families.
 */

import type { ResolvedFocusedResource } from "@nautilo/types";
import { activeComputerUseHostToolDefinitions } from "../../config/computer-use-catalogue/host-tool-admission";

export const TOOL_FAMILY_NAMES = [
  "memory",
  "orchestration",
  "filesystem",
  "shell",
  "structured_ssh",
  "browser",
  "productivity",
  "device",
  "configuration",
  "voice_media",
  "time",
  "research",
  "skill_authoring",
  "command_authoring",
] as const;

export type ToolFamilyName = (typeof TOOL_FAMILY_NAMES)[number];

/**
 * A model may request at most eight selections. Keep the canonical family
 * expansion independently bounded too, so a future large family cannot turn
 * one activation request into an unbounded schema exposure.
 */
export const MAX_ACTIVATED_FAMILY_MEMBERS = 64;

export interface ToolExposureManifest {
  readonly coreToolNames: readonly string[];
  /**
   * Canonical core names intentionally reserved before their registration
   * exists. A reserved name remains subject to the partition once registered.
   */
  readonly reservedToolNames?: readonly string[];
  readonly families: Readonly<Record<ToolFamilyName, readonly string[]>>;
}

const RESERVED_CORE_TOOL_NAMES = [
  "activate_tools",
  "deactivate_tools",
  // Conditionally registered only after the server injects paid-media
  // authority. Reservation keeps the static exposure partition truthful when
  // Venice is unavailable at boot.
  "generate_video",
  "generate_music",
] as const;

export const EMBEDDED_BROWSER_TOOL_NAMES = [
  "browser_snapshot",
  "browser_click",
  "browser_type",
  "browser_press",
  "browser_read",
  "browser_read_page",
  "browser_screenshot",
  "browser_mouse",
  "browser_get",
  "browser_scroll",
  "browser_back",
  "browser_open",
  "browser_forward",
  "browser_reload",
  "browser_hover",
  "browser_double_click",
  "browser_drag",
  "browser_select",
  "browser_set_checked",
  "browser_scroll_into_view",
  "browser_wait",
] as const;

/**
 * Tools which are eagerly exposed when existing policy authorizes them.
 * Activation controls are reserved until their registrations are supplied.
 */
export const CORE_TOOL_NAMES = [
  "apply_patch",
  "discover_tools",
  "discover_models",
  "activate_tools",
  "deactivate_tools",
  "discover_skills",
  "view_skill",
  "eject",
  "discover_commands",
  "view_command",
  "eject_command",
  "search_memory",
  "recall_records",
  "manage_memory",
  "skip",
  "react",
  "in_background",
  "schedule",
  "in_scope",
  "run_web_search",
  "read_webpage",
  "browse_web",
  "run_website_task",
  "read_connected_web_account",
  "manage_connected_web_operation",
  "control_connected_web_operation",
  "verify_identity",
  ...EMBEDDED_BROWSER_TOOL_NAMES,
] as const;

export const TOOL_EXPOSURE_MANIFEST: ToolExposureManifest = {
  coreToolNames: CORE_TOOL_NAMES,
  reservedToolNames: RESERVED_CORE_TOOL_NAMES,
  families: {
    memory: [
      "session_search",
      "list_my_users",
      "get_room_members",
      "share_memory",
      "create_scope",
      "find_scope",
      "add_memory_to_scope",
      "close_scope",
    ],
    orchestration: [
      "task",
      "in_private_namespace",
      "ask_peer",
      "generate_repo_docs",
    ],
    filesystem: [
      "share_artifact",
      "read_artifact_events",
      "file",
      "convert",
      "execute_artifact",
    ],
    // D497 — explicit Git/GitHub workstation intent may need to establish the
    // local Current Folder before shell execution. This is the narrow folder
    // selector only; the broader filesystem family stays deferred.
    shell: ["run_shell", "terminal", "select_current_folder"],
    // D500 — separate from the ordinary shell family. Generic local shell
    // work must never expose Human-granted remote SSH authority.
    structured_ssh: [
      "structured_ssh_auth",
      "structured_ssh_exec",
      "structured_ssh_copy_upload",
      "structured_ssh_copy_download",
      "structured_ssh_output",
    ],
    // Browser access is fundamental and guest-safe only through the visible,
    // Desktop-owned relay surface. The complete family is core above so an
    // eligible turn never depends on actor-persisted activation state.
    browser: [],
    productivity: [
      "google_workspace",
      "office",
      "edit_doc",
      "officecli",
      "mini_app",
    ],
    device: ["hue_lights"],
    configuration: [
      "update_config",
      "check_config",
      "use_connection",
      "list_connections",
      "use_credential",
      "delete_connection",
      "manage_profile",
      "manage_avatar",
      "onboarding_status",
      "launch_customization",
      "guide_user",
      "manage_voices",
      "regenerate_soul",
      "manage_local_mcp",
      "act_connected_web_account",
    ],
    voice_media: [
      "find_voice",
      "audition_voices",
      "transcribe_audio",
      "ingest_local_media",
      "extract_audio_from_video",
      "generate_image",
      "generate_video",
      "generate_music",
      "find_explainer",
      "play_explainer",
    ],
    time: ["get_current_time"],
    research: ["run_deep_research", "security_scan"],
    skill_authoring: ["skill_manage"],
    command_authoring: ["command_manage"],
  },
};

/**
 * Computer Use core names come from the active signed catalogue, never from a
 * second compiled operation list. Registration and exposure validation read
 * the same active snapshot.
 */
export function activeComputerUseCoreToolNames(): readonly string[] {
  return Object.freeze(activeComputerUseHostToolDefinitions().map((definition) => definition.name));
}

export type IntentPackReason =
  | "explicit_filesystem_edit"
  | "explicit_development_request"
  | "explicit_structured_ssh_request"
  | "explicit_media_transcription"
  | "explicit_media_generation"
  | "explicit_office_document_request"
  | "explicit_harness_delegation";

export interface IntentPackResolution {
  /** Reviewed tool families selected from an unmistakable request only. */
  readonly families: readonly ToolFamilyName[];
  /**
   * Aggregate, stable categories suitable for logging. Never include source
   * request text in an intent-resolution log.
   */
  readonly reasons: readonly IntentPackReason[];
}

const FILESYSTEM_EDIT =
  /\b(?:edit|modify|change|update|write|create|rename|delete|move|copy)\b[\s\S]{0,80}\b(?:file|files|workspace|folder|document)\b|\b(?:file|files|workspace|folder|document)\b[\s\S]{0,40}\b(?:edit|modify|change|update|write|create|rename|delete|move|copy)\b/i;
const DEVELOPMENT_FILESYSTEM_REQUEST =
  /\b(?:find|locate|inspect|debug|fix|implement|refactor|develop|change|update|edit)\b[\s\S]{0,100}\b(?:code|codebase|repository|repo|project|package|module|source|symbol|route|implementation|file path|failing test|client and server)\b|\b(?:code|codebase|repository|repo|project|package|module|source|symbol|route|implementation|file path|failing test|client and server)\b[\s\S]{0,70}\b(?:find|locate|inspect|debug|fix|implement|refactor|develop|change|update|edit|implemented)\b/i;
const DEVELOPMENT_SHELL_REQUEST =
  /\b(?:run|execute)\b[\s\S]{0,40}\b(?:tests?|build|compiler|linter|typecheck)\b|\b(?:build|compile|lint|typecheck)\b[\s\S]{0,50}\b(?:code|codebase|repository|repo|project|package|module|client|server)\b/i;
/**
 * D502 — naming the deferred tool together with an execution verb is an
 * unmistakable request to make the shell family callable. Keep the verb
 * coupled to the tool name so explanatory questions about run_shell do not
 * eagerly expose high-impact execution authority.
 */
const EXPLICIT_RUN_SHELL_REQUEST =
  /\b(?:use|call|invoke)\b[\s\S]{0,32}\brun_shell\b|\brun_shell\b[\s\S]{0,32}\b(?:run|execute)\b/i;
/**
 * D497 — Git/GitHub work is a concrete workstation-shell request, not a
 * reason to make the shell family eager for ordinary repository discussion.
 * Keep the action and Git/GitHub signal coupled so a vague question about
 * software, bugs, or GitHub itself retains progressive exposure.
 */
const EXPLICIT_GIT_GITHUB_SHELL_REQUEST =
  /\b(?:run|execute|check|show|list|inspect|query|fetch|review|open|create|close|comment|push|pull|status|diff|log|commit|branch|clone|checkout|merge|rebase)\b[\s\S]{0,80}\b(?:git|github|gh|pull requests?|issues?)\b|\b(?:git|github|gh)\b[\s\S]{0,80}\b(?:status|diff|log|branches?|issues?|bugs?|pull requests?|prs?|commits?|fetch|push|pull|clone|checkout|merge|rebase|list|open|create|close|comment|review)\b/i;
/**
 * D500 — remote authority is exposed only for an explicit operational SSH,
 * remote-server, or DevOps request. Ordinary shell, Git, or SSH explanation
 * turns remain outside this separate high-impact family.
 */
const EXPLICIT_STRUCTURED_SSH_REQUEST =
  /\b(?:connect|authenticate|log\s*in|access|run|execute|deploy|inspect|manage|restart|configure|operate|copy|upload|download|transfer)\b[\s\S]{0,80}\b(?:ssh|remote\s+(?:server|host|machine)|devops)\b|\b(?:ssh|remote\s+(?:server|host|machine)|devops)\b[\s\S]{0,80}\b(?:connect|authenticate|log\s*in|run|execute|deploy|inspect|manage|restart|configure|operate|copy|upload|download|transfer)\b|\b(?:use|call|invoke)\b[\s\S]{0,32}\bstructured_ssh_(?:auth|exec|copy_upload|copy_download)\b/i;
const MEDIA_TRANSCRIPTION =
  /\b(?:transcribe|transcription)\b[\s\S]{0,80}\b(?:audio|mp3|wav|m4a|aac|flac|ogg|mp4|video)\b|\b(?:audio|mp3|wav|m4a|aac|flac|ogg|mp4|video)\b[\s\S]{0,40}\b(?:transcribe|transcription)\b/i;
const MEDIA_GENERATION =
  /\b(?:generate|create|make|compose|produce)\b[\s\S]{0,80}\b(?:video|music|song|soundtrack|musical score|audio track)\b|\b(?:video|music|song|soundtrack|musical score|audio track)\b[\s\S]{0,40}\b(?:generate|create|make|compose|produce)\b/i;
const ADVANCED_VIDEO_WORKFLOW =
  /\b(?:open|start|show|use|try)\b[\s\S]{0,80}\b(?:advanced|reference(?:-to-video)?)[\s\S]{0,40}\b(?:video|workflow|mode|workcard|card)\b|\b(?:advanced|reference(?:-to-video)?)[\s\S]{0,40}\b(?:video|workflow|mode|workcard|card)\b[\s\S]{0,40}\b(?:open|start|show|use|try)\b/i;
const OFFICE_DOCUMENT_REQUEST =
  /\b(?:create|edit|modify|update|read|open|format|convert)\b[\s\S]{0,80}\b(?:office document|word document|excel spreadsheet|powerpoint presentation|spreadsheet|slide deck|\.docx\b|\.xlsx\b|\.pptx\b)\b|\b(?:office document|word document|excel spreadsheet|powerpoint presentation|spreadsheet|slide deck|\.docx\b|\.xlsx\b|\.pptx\b)[\s\S]{0,40}\b(?:create|edit|modify|update|read|open|format|convert)\b/i;
const HARNESS_DELEGATION =
  /\b(?:use|run|invoke|delegate|route|send|hand\s*off|have)\b[\s\S]{0,48}\b(?:codex|coding harness|agent harness)\b/i;

/**
 * D419 task 2.5 — deliberately narrow, deterministic intent-pack selection.
 *
 * This recognizes only an explicit, concrete request family. It does not
 * inspect policy, relays, namespaces, whitelists, or model capability itself:
 * callers must pass the returned families through `resolveProgressiveTools`,
 * which applies those shared authorization and runtime gates.
 */
export function resolveIntentPacks(request: string): IntentPackResolution {
  // An explicit external-harness delegation is itself the execution route.
  // Do not also expose Native filesystem/shell families merely because the
  // delegated prompt describes repository work.
  if (HARNESS_DELEGATION.test(request)) {
    return Object.freeze({
      families: Object.freeze(["orchestration"] as ToolFamilyName[]),
      reasons: Object.freeze(["explicit_harness_delegation"] as IntentPackReason[]),
    });
  }

  const families: ToolFamilyName[] = [];
  const reasons: IntentPackReason[] = [];
  const add = (family: ToolFamilyName, reason: IntentPackReason) => {
    if (!families.includes(family)) families.push(family);
    if (!reasons.includes(reason)) reasons.push(reason);
  };

  if (FILESYSTEM_EDIT.test(request)) add("filesystem", "explicit_filesystem_edit");
  if (DEVELOPMENT_FILESYSTEM_REQUEST.test(request)) {
    add("filesystem", "explicit_development_request");
  }
  if (
    DEVELOPMENT_SHELL_REQUEST.test(request) ||
    EXPLICIT_RUN_SHELL_REQUEST.test(request) ||
    EXPLICIT_GIT_GITHUB_SHELL_REQUEST.test(request)
  ) {
    add("shell", "explicit_development_request");
  }
  if (EXPLICIT_STRUCTURED_SSH_REQUEST.test(request)) {
    add("structured_ssh", "explicit_structured_ssh_request");
  }
  if (MEDIA_TRANSCRIPTION.test(request)) add("voice_media", "explicit_media_transcription");
  if (MEDIA_GENERATION.test(request) || ADVANCED_VIDEO_WORKFLOW.test(request)) {
    add("voice_media", "explicit_media_generation");
  }
  if (OFFICE_DOCUMENT_REQUEST.test(request)) add("productivity", "explicit_office_document_request");
  return Object.freeze({
    families: Object.freeze(families),
    reasons: Object.freeze(reasons),
  });
}

/**
 * D423 — a server-resolved focused resource can carry an already-authorized,
 * model-facing `file` target. Its presence is a deterministic reason to make
 * exactly that tool callable for the turn: the focused-resources prompt tells
 * the model to use `file`, so leaving its schema deferred makes the pointer
 * unusable. This deliberately selects the single tool, not the whole
 * filesystem family.
 *
 * `ResolvedFocusedResource` is server-authored after artifact namespace or
 * local-relay validation. This helper does not confer authority itself: its
 * result still goes through the catalog's policy, runtime, whitelist, and
 * model-capability eligibility gates before a schema is bound.
 */
export function resolveFocusedResourceToolActivations(
  resources: readonly Pick<ResolvedFocusedResource, "toolTarget">[] | null | undefined,
): string[] {
  if (!resources?.some((resource) => resource.toolTarget?.tool === "file")) {
    return [];
  }
  return ["file"];
}

/**
 * Expands reviewed family names through the canonical manifest. Names retain
 * manifest order and are deduplicated when families overlap in a custom
 * manifest supplied to tests or future callers.
 */
export function expandToolFamilies(
  families: readonly ToolFamilyName[],
  manifest: ToolExposureManifest = TOOL_EXPOSURE_MANIFEST,
): string[] {
  const names = new Set<string>();
  for (const family of families) {
    const members = manifest.families[family];
    if (!members) {
      throw new Error(`Unknown tool family "${family}".`);
    }
    for (const name of members) {
      names.add(name);
      if (names.size > MAX_ACTIVATED_FAMILY_MEMBERS) {
        throw new Error(
          `Tool family expansion exceeds ${MAX_ACTIVATED_FAMILY_MEMBERS} members.`,
        );
      }
    }
  }
  return [...names];
}

function allMemberships(manifest: ToolExposureManifest): Array<readonly [string, string]> {
  return [
    ...manifest.coreToolNames.map((name) => [name, "core"] as const),
    ...Object.entries(manifest.families).flatMap(([family, names]) =>
      names.map((name) => [name, `family:${family}`] as const),
    ),
  ];
}

/** Throws when a name is assigned to more than one core/family membership. */
export function validateNoDuplicateToolMembership(
  manifest: ToolExposureManifest,
): void {
  const memberships = new Map<string, string>();
  for (const [name, membership] of allMemberships(manifest)) {
    const existing = memberships.get(name);
    if (existing) {
      throw new Error(
        `Tool exposure manifest assigns "${name}" to both ${existing} and ${membership}.`,
      );
    }
    memberships.set(name, membership);
  }
}

/** Throws when a manifest name is neither registered nor explicitly reserved. */
export function validateNoUnknownToolNames(
  manifest: ToolExposureManifest,
  registeredToolNames: Iterable<string>,
): void {
  const registered = new Set(registeredToolNames);
  const reserved = new Set(manifest.reservedToolNames);
  const unknown = allMemberships(manifest)
    .map(([name]) => name)
    .filter((name) => !registered.has(name) && !reserved.has(name));

  if (unknown.length > 0) {
    throw new Error(
      `Tool exposure manifest references unregistered tool names: ${[...new Set(unknown)].sort().join(", ")}.`,
    );
  }
}

/**
 * Throws unless every registered built-in belongs to exactly one of core or a
 * family. Reserved-but-unregistered names do not participate in this check.
 */
export function validateCoreFamilyPartition(
  manifest: ToolExposureManifest,
  registeredToolNames: Iterable<string>,
): void {
  const registered = new Set(registeredToolNames);
  const assigned = new Set(
    allMemberships(manifest)
      .map(([name]) => name)
      .filter((name) => registered.has(name)),
  );
  if (manifest === TOOL_EXPOSURE_MANIFEST) {
    for (const name of activeComputerUseCoreToolNames()) {
      if (registered.has(name)) assigned.add(name);
    }
  }
  const unclassified = [...registered].filter((name) => !assigned.has(name)).sort();

  if (unclassified.length > 0) {
    throw new Error(
      `Tool exposure manifest does not classify registered tool names: ${unclassified.join(", ")}.`,
    );
  }
}

/** Validates the complete D419 core/family taxonomy against a catalog name set. */
export function validateToolExposureManifest(
  registeredToolNames: Iterable<string>,
  manifest: ToolExposureManifest = TOOL_EXPOSURE_MANIFEST,
): void {
  validateNoDuplicateToolMembership(manifest);
  if (manifest === TOOL_EXPOSURE_MANIFEST) {
    const staticMemberships = new Set(allMemberships(manifest).map(([name]) => name));
    const collision = activeComputerUseCoreToolNames().find((name) => staticMemberships.has(name));
    if (collision !== undefined) {
      throw new Error(`Signed Computer Use catalogue tool "${collision}" duplicates the static exposure manifest.`);
    }
  }
  validateNoUnknownToolNames(manifest, registeredToolNames);
  validateCoreFamilyPartition(manifest, registeredToolNames);
}
