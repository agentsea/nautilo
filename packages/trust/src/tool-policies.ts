export type ToolImpact = "read-only" | "low" | "high" | "destructive";
export type ToolExecutor = "cloud" | "relay";

import { CAP_USE_GOOGLE_WORKSPACE } from "./capabilities";

/** M079 — mirrors `ToolCatalogEntry.approvalMode`; omitted = static. */
export type ToolApprovalMode = "static" | "hybrid";

export type ToolPolicyEntry = {
  requiredCapability: string | null;
  impact: ToolImpact;
  executor: ToolExecutor;
  relayCapability?: string | undefined;
  requiresApproval?: boolean | undefined;
  approvalMode?: ToolApprovalMode | undefined;
};

/** Internal fail-closed marker. It is never a seeded or grantable capability. */
const UNREGISTERED_TOOL_CAPABILITY = "__unregistered_tool_forbidden__";

// Tool → Capability map. Grantable capabilities have matching slugs in
// CAPABILITY_SEEDS and default role bundles in seed-trust-personal.ts.
// The internal fail-closed marker above is never grantable.
const TOOL_POLICIES: Record<string, ToolPolicyEntry> = {
  // Memory tools — cloud (server-side, DB access)
  search_memory:      { requiredCapability: "read_memories",           impact: "read-only",   executor: "cloud" },
  session_search:     { requiredCapability: null,                      impact: "read-only",   executor: "cloud" },
  list_my_users:      { requiredCapability: null,                      impact: "read-only",   executor: "cloud" },
  get_room_members:   { requiredCapability: null,                      impact: "read-only",   executor: "cloud" },
  manage_memory:      { requiredCapability: "manage_memories",         impact: "low",         executor: "cloud" },
  share_memory:       { requiredCapability: "manage_memories",         impact: "destructive", executor: "cloud", approvalMode: "hybrid" },
  share_artifact:     { requiredCapability: "use_share_artifact",      impact: "destructive", executor: "cloud", approvalMode: "hybrid" },
  read_artifact_events: { requiredCapability: null,                    impact: "read-only",   executor: "cloud" },
  create_scope:       { requiredCapability: null,                      impact: "low",         executor: "cloud" },
  find_scope:         { requiredCapability: null,                      impact: "read-only",   executor: "cloud" },
  add_memory_to_scope: { requiredCapability: null,                     impact: "low",         executor: "cloud" },
  close_scope:        { requiredCapability: null,                      impact: "low",         executor: "cloud" },
  task:               { requiredCapability: null,                      impact: "low",         executor: "cloud" },
  // M144 — Phase 3 intent shortcuts. The two cross-context shortcuts require
  // ordinary agent-invocation authority; the other shortcuts are low.
  in_scope:           { requiredCapability: null,                      impact: "low",         executor: "cloud" },
  in_background:      { requiredCapability: null,                      impact: "low",         executor: "cloud" },
  schedule:           { requiredCapability: null,                      impact: "low",         executor: "cloud" },
  in_private_namespace: { requiredCapability: "invoke_agents",        impact: "destructive", executor: "cloud" },
  ask_peer:           { requiredCapability: "invoke_agents",          impact: "destructive", executor: "cloud", approvalMode: "hybrid" },
  // D363 (Stack-128) — `generate_repo_docs` entry tool. Thin
  // `repo_docs` task creator; a separate executor consumes the task.
  // The spawned subagent writes to a repo (potentially pushing or opening a
  // PR), so project execution retains an explicit approval gate.
  generate_repo_docs: { requiredCapability: "use_project_execution",  impact: "destructive", executor: "cloud", requiresApproval: true },
  // Web tools — cloud (outbound HTTP from server)
  browse_web: { requiredCapability: null, impact: "low", executor: "cloud" },
  run_web_search:     { requiredCapability: null,                      impact: "read-only",   executor: "cloud" },
  read_webpage:       { requiredCapability: null,                      impact: "read-only",   executor: "cloud" },
  // D079 Phase 4 — unified `file` tool dispatches on a `command` arg.
  // Per-command severity (read-only vs destructive_low/high) continues to
  // flow through `file-tool-policies.ts`; project-content authority is the
  // coherent coarse gate for calling the tool at all.
  file:               { requiredCapability: "use_project_content",    impact: "destructive", executor: "cloud" },
  // D448 Phase 2.1 — top-level, multi-file edit entry point. Execution is
  // supplied by a trusted port; policy does not imply a target or transport.
  apply_patch:        { requiredCapability: "use_project_content",    impact: "destructive", executor: "cloud", requiresApproval: true },
  convert:            { requiredCapability: "use_project_content",    impact: "high",        executor: "cloud", requiresApproval: true },
  office:             { requiredCapability: "use_project_content",    impact: "low",         executor: "cloud" },
  edit_doc:           { requiredCapability: "use_project_content",    impact: "low",         executor: "cloud" },
  officecli:          { requiredCapability: "use_project_content",    impact: "low",         executor: "cloud" },
  execute_artifact:   { requiredCapability: "use_project_execution",  impact: "destructive", executor: "cloud", requiresApproval: true },
  // D497 — exact Current Folder adoption is an Electron-owned app-state
  // transition, not Computer Use automation. Keep the actor's control_desktop
  // permission, but require only the local relay/session capability so the
  // selector remains available when Accessibility is unavailable.
  select_current_folder: { requiredCapability: "control_desktop",      impact: "high",        executor: "relay", relayCapability: "canRunShell", requiresApproval: true },
  run_shell:          { requiredCapability: "use_workstation",        impact: "destructive", executor: "relay", relayCapability: "canRunShell", requiresApproval: true },
  // D373 — interactive shared PTY. impact "high" + no requiresApproval →
  // capability-gated `allow`, with no per-command PIN.
  terminal:           { requiredCapability: "use_workstation",        impact: "high",        executor: "relay", relayCapability: "canUseTerminal" },
  structured_ssh_auth: { requiredCapability: "use_remote_hosts",      impact: "high",        executor: "relay", relayCapability: "canUseStructuredSsh" },
  structured_ssh_exec: { requiredCapability: "use_remote_hosts",      impact: "high",        executor: "relay", relayCapability: "canUseStructuredSsh" },
  structured_ssh_output: { requiredCapability: "use_remote_hosts",    impact: "read-only",   executor: "relay", relayCapability: "canReadStructuredSshOutput" },
  structured_ssh_copy_upload: { requiredCapability: "use_remote_hosts", impact: "high",      executor: "relay", relayCapability: "canUseStructuredSshCopy" },
  structured_ssh_copy_download: { requiredCapability: "use_remote_hosts", impact: "high",    executor: "relay", relayCapability: "canUseStructuredSshCopy" },
  // D516 Wave 1A — semantic Computer use is admitted by its dedicated
  // desktop-automation provenance path, not by generic ask/prove_it policy.
  // Observe and verify are read-only. `computer_do` performs only the
  // route-bounded mutations admitted by the live Cua capability contract.
  computer_observe:   { requiredCapability: "control_desktop",         impact: "read-only",   executor: "relay", relayCapability: "canUseComputer", requiresApproval: false },
  computer_do:        { requiredCapability: "control_desktop",         impact: "high",        executor: "relay", relayCapability: "canUseComputer", requiresApproval: false },
  computer_verify:    { requiredCapability: "control_desktop",         impact: "read-only",   executor: "relay", relayCapability: "canUseComputer", requiresApproval: false },
  browser_snapshot:   { requiredCapability: "control_browser",         impact: "low",         executor: "relay", relayCapability: "canControlBrowser" },
  browser_click:      { requiredCapability: "control_browser",         impact: "low",         executor: "relay", relayCapability: "canControlBrowser" },
  browser_type:       { requiredCapability: "control_browser",         impact: "low",         executor: "relay", relayCapability: "canControlBrowser" },
  browser_press:      { requiredCapability: "control_browser",         impact: "low",         executor: "relay", relayCapability: "canControlBrowser" },
  browser_read:       { requiredCapability: "control_browser",         impact: "read-only",   executor: "relay", relayCapability: "canControlBrowser" },
  browser_read_page:  { requiredCapability: "control_browser",         impact: "read-only",   executor: "relay", relayCapability: "canControlBrowser" },
  browser_screenshot: { requiredCapability: "control_browser",         impact: "read-only",   executor: "relay", relayCapability: "canControlBrowser" },
  browser_mouse:      { requiredCapability: "control_browser",         impact: "low",         executor: "relay", relayCapability: "canControlBrowser" },
  browser_get:        { requiredCapability: "control_browser",         impact: "read-only",   executor: "relay", relayCapability: "canControlBrowser" },
  browser_scroll:     { requiredCapability: "control_browser",         impact: "low",         executor: "relay", relayCapability: "canControlBrowser" },
  browser_back:       { requiredCapability: "control_browser",         impact: "low",         executor: "relay", relayCapability: "canControlBrowser" },
  browser_open:       { requiredCapability: "control_browser",         impact: "low",         executor: "relay", relayCapability: "canControlBrowser" },
  browser_forward:    { requiredCapability: "control_browser",         impact: "low",         executor: "relay", relayCapability: "canControlBrowser" },
  browser_reload:     { requiredCapability: "control_browser",         impact: "low",         executor: "relay", relayCapability: "canControlBrowser" },
  browser_hover:      { requiredCapability: "control_browser",         impact: "low",         executor: "relay", relayCapability: "canControlBrowser" },
  browser_double_click: { requiredCapability: "control_browser",       impact: "low",         executor: "relay", relayCapability: "canControlBrowser" },
  browser_drag:       { requiredCapability: "control_browser",         impact: "low",         executor: "relay", relayCapability: "canControlBrowser" },
  browser_select:     { requiredCapability: "control_browser",         impact: "low",         executor: "relay", relayCapability: "canControlBrowser" },
  browser_set_checked: { requiredCapability: "control_browser",        impact: "low",         executor: "relay", relayCapability: "canControlBrowser" },
  browser_scroll_into_view: { requiredCapability: "control_browser",   impact: "low",         executor: "relay", relayCapability: "canControlBrowser" },
  browser_wait:       { requiredCapability: "control_browser",         impact: "low",         executor: "relay", relayCapability: "canControlBrowser" },
  google_workspace:   { requiredCapability: CAP_USE_GOOGLE_WORKSPACE, impact: "low",         executor: "relay", relayCapability: "canUseGoogleWorkspace" },
  notion_search:      { requiredCapability: null,                      impact: "read-only",   executor: "cloud" },
  notion_retrieve_page: { requiredCapability: null,                    impact: "read-only",   executor: "cloud" },
  notion_create_page: { requiredCapability: null,                      impact: "high",        executor: "cloud", requiresApproval: true },
  slack_list_conversations: { requiredCapability: null,                 impact: "read-only",   executor: "cloud" },
  slack_get_channel_messages: { requiredCapability: null,               impact: "read-only",   executor: "cloud" },
  slack_search_messages: { requiredCapability: null,                    impact: "read-only",   executor: "cloud" },
  slack_post_message: { requiredCapability: null,                       impact: "high",        executor: "cloud", requiresApproval: true },
  hue_lights:         { requiredCapability: "control_home",            impact: "low",         executor: "relay", relayCapability: "canControlHue" },
  // Connections / vault — individual tools preserve their own approval modes.
  list_connections:   { requiredCapability: "use_connections",        impact: "read-only",   executor: "cloud" },
  read_connected_web_account: { requiredCapability: "use_connections", impact: "low",        executor: "cloud" },
  run_website_task: { requiredCapability: "use_connections", impact: "high", executor: "cloud", requiresApproval: false },
  use_connection:     { requiredCapability: "use_connections",        impact: "high",        executor: "cloud", requiresApproval: true },
  use_credential:     { requiredCapability: "use_connections",        impact: "high",        executor: "cloud", requiresApproval: true },
  delete_connection:  { requiredCapability: "use_connections",        impact: "destructive", executor: "cloud", requiresApproval: true },
  // Config / onboarding tools — cloud (server-side state). M128
  // splits these gates: `update_config` is owner-only via
  // `manage_server_settings`; `check_config` is gated to ≥contributor
  // via `read_server_settings`.
  update_config:      { requiredCapability: "manage_server_settings",  impact: "destructive", executor: "cloud" },
  check_config:       { requiredCapability: "read_server_settings",    impact: "read-only",   executor: "cloud" },
  // M128 D4-A (2026-05-28): self-edit by construction. The tool body
  // operates on `context.ownerId` (= the calling user's id) — there is
  // no target parameter. Per permission-model.md §5 + §7 item 9 the
  // static cap drops to `null`; if a future revision adds a `targetUserId`
  // parameter the tool body must enforce the two-gate
  // `agents.ownerId === userId || caps.includes("manage_agents")`.
  manage_profile:     { requiredCapability: null,                      impact: "low",         executor: "cloud" },
  get_current_time:   { requiredCapability: null,                      impact: "low",         executor: "cloud" },
  onboarding_status:  { requiredCapability: null,                      impact: "read-only",   executor: "cloud" },
  launch_customization: { requiredCapability: null,                    impact: "low",         executor: "cloud" },
  find_voice:         { requiredCapability: null,                      impact: "read-only",   executor: "cloud" },
  audition_voices:    { requiredCapability: null,                      impact: "read-only",   executor: "cloud" },
  manage_voices:      { requiredCapability: null,                      impact: "low",         executor: "cloud" },
  transcribe_audio:   { requiredCapability: "use_transcription",       impact: "high",        executor: "cloud", requiresApproval: true },
  ingest_local_media: { requiredCapability: "use_transcription",       impact: "high",        executor: "cloud", requiresApproval: true },
  extract_audio_from_video: { requiredCapability: "use_transcription", impact: "high",        executor: "cloud", requiresApproval: true },
  generate_image:     { requiredCapability: "use_image_generation",    impact: "low",         executor: "cloud" },
  generate_video:     { requiredCapability: "use_media_generation",    impact: "destructive", executor: "cloud", requiresApproval: true },
  generate_music:     { requiredCapability: "use_media_generation",    impact: "destructive", executor: "cloud", requiresApproval: true },
  // M128 D4-A: see `manage_profile` comment above — self-edit by construction.
  regenerate_soul:    { requiredCapability: null,                      impact: "destructive", executor: "cloud" },
  // Trust tools — cloud
  verify_identity:    { requiredCapability: null,                      impact: "low",         executor: "cloud" },
  // Research tools — cloud (web access + LLM calls)
  run_deep_research:  { requiredCapability: "use_research_tools",      impact: "high",        executor: "cloud" },
  // D560 — Desktop owns source access and managed scanner execution. The
  // project-content capability is the actor gate; this structurally read-only
  // route requires only the existing local workspace-read capability.
  security_scan:      { requiredCapability: "use_project_content",    impact: "read-only",   executor: "relay", relayCapability: "canReadWorkspace" },
  // Meta tools — cloud
  discover_tools:     { requiredCapability: null,                      impact: "read-only",   executor: "cloud" },
  activate_tools:     { requiredCapability: null,                      impact: "read-only",   executor: "cloud" },
  deactivate_tools:   { requiredCapability: null,                      impact: "read-only",   executor: "cloud" },
  // M189 + D563 — installed mini-app source authoring is an Admin operation.
  // It mutates the apps root and may register app tools, but it does not grant
  // access to owner-only runtime configuration or secrets.
  mini_app:           { requiredCapability: "manage_server_operations", impact: "destructive", executor: "cloud" },
  // D263 P2 — see `manage_profile` comment above; body enforces ownsAgent || manage_agents.
  skill_manage:       { requiredCapability: null,                      impact: "low",         executor: "cloud" },
  // D263 P3 — read-only mid-turn skill body fallback (R5); guest-tier.
  view_skill:         { requiredCapability: null,                      impact: "read-only",   executor: "cloud" },
  // D379 (Stack 145) — `command_*` family mirrors `skill_*` one-to-one.
  // `command_manage` body enforces the same ownsAgent || manage_agents
  // two-gate as `skill_manage`; low-impact cloud.
  command_manage:     { requiredCapability: null,                      impact: "low",         executor: "cloud" },
  // D379 (Stack 145) — read-only mid-turn command body fallback; guest-tier.
  view_command:       { requiredCapability: null,                      impact: "read-only",   executor: "cloud" },
  // D379 (Stack 145) — speaker-scoped command catalog search; read-only.
  discover_commands:  { requiredCapability: null,                      impact: "read-only",   executor: "cloud" },
  // D379 (Stack 145) — structural mirror of `eject` (skills); read-only no-op.
  eject_command:      { requiredCapability: null,                      impact: "read-only",   executor: "cloud" },
};

/**
 * Look up the policy for a tool by name.
 * Unknown tools are destructive and require an internal, ungrantable marker,
 * so they are never silently allowed. Every registered tool must still have an
 * explicit entry above.
 */
export function getToolPolicy(toolName: string): ToolPolicyEntry {
  return TOOL_POLICIES[toolName] ?? {
    requiredCapability: UNREGISTERED_TOOL_CAPABILITY,
    impact: "destructive",
    executor: "cloud",
    requiresApproval: true,
  };
}

/** All registered tool names (for testing/introspection). */
export function getRegisteredToolNames(): string[] {
  return Object.keys(TOOL_POLICIES);
}

/**
 * Validate that the tool factory registry and the policy registry are in sync.
 * Call once at server boot. Throws if any name exists in one but not the other.
 */
export function validateToolRegistry(factoryNames: string[]): void {
  const policyNames = new Set(getRegisteredToolNames());
  const factorySet = new Set(factoryNames);

  const missingFromPolicy = factoryNames.filter((n) => !policyNames.has(n));
  const missingFromFactory = [...policyNames].filter((n) => !factorySet.has(n));

  const errors: string[] = [];
  if (missingFromPolicy.length) {
    errors.push(`Tools in factory but missing from TOOL_POLICIES: ${missingFromPolicy.join(", ")}`);
  }
  if (missingFromFactory.length) {
    errors.push(`Tools in TOOL_POLICIES but missing from factory: ${missingFromFactory.join(", ")}`);
  }
  if (errors.length) {
    throw new Error(`[trust] Tool registry mismatch — fix before starting:\n${errors.join("\n")}`);
  }
}
