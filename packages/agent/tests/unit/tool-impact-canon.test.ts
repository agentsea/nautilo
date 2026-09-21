import { describe, test, expect, beforeAll } from "bun:test";
import { ToolCatalog } from "@nautilo/catalog";
import { setConfigOverrides } from "@nautilo/config";
import { registerAllTools } from "../../src/tools/register-all";
import { resolveApproval, type ApprovalVerb, type ToolImpact } from "@nautilo/security";
import { activeComputerUseHostToolDefinitions } from "../../src/config/computer-use-catalogue/host-tool-admission";

/**
 * Locks built-in catalog impacts and their approval verbs at standard security.
 * Add or change the corresponding entry whenever a tool's impact changes.
 */

interface CanonEntry {
  impact: ToolImpact;
  /** Verb at `standard` level for an unscanned invocation (no scanner hit
   *  and no external-binary flag), after explicit catalog approval gates
   *  are applied. This is what the tool will see in the common-case
   *  post_model pass after Phase 2 wires things up. */
  standardVerb: ApprovalVerb;
}

const CANON: Record<string, CanonEntry> = {
  // --- Memory (read-only + low) ---
  search_memory:      { impact: "read-only",   standardVerb: "auto" },
  recall_records:     { impact: "read-only",   standardVerb: "auto" },
  session_search:     { impact: "read-only",   standardVerb: "auto" },
  manage_memory:      { impact: "low",         standardVerb: "auto" },
  list_my_users:      { impact: "read-only",   standardVerb: "auto" },
  get_room_members:   { impact: "read-only",   standardVerb: "auto" },
  // emoji reaction; trivially reversible + bounded, auto for all levels.
  react:              { impact: "low",          standardVerb: "auto" },
  // Hybrid approval reads LLM `sensitivity`; catalog impact
  // stays destructive as fallback tier routing.
  share_memory:       { impact: "destructive", standardVerb: "ask" },
  // same hybrid approval pattern as share_memory; impact stays
  // destructive at the catalog tier and the LLM-supplied `sensitivity`
  // drives the actual ask / prove_it routing.
  share_artifact:     { impact: "destructive", standardVerb: "ask" },
  read_artifact_events: { impact: "read-only",   standardVerb: "auto" },
  create_scope:       { impact: "low",         standardVerb: "auto" },
  find_scope:         { impact: "read-only",   standardVerb: "auto" },
  add_memory_to_scope: { impact: "low",        standardVerb: "auto" },
  close_scope:        { impact: "low",         standardVerb: "auto" },
  task:               { impact: "low",         standardVerb: "auto" },
  // Phase 3 intent shortcuts (thin createTask wrappers). in_scope /
  // in_background are low (auto); in_private_namespace carries the
  // destructive privacy-downgrade gate after removal of the legacy
  // do_in_private_namespace tool it used to mirror.
  in_scope:           { impact: "low",         standardVerb: "auto" },
  in_background:      { impact: "low",         standardVerb: "auto" },
  schedule:           { impact: "low",         standardVerb: "auto" },
  in_private_namespace: { impact: "destructive", standardVerb: "ask" },
  // ask_peer sends an agent to DM another human (high-impact, ask).
  ask_peer:           { impact: "destructive", standardVerb: "ask" },
  // generate_repo_docs mints a repo_docs task whose
  // executor writes to a repo (branch / push / pr). High-impact + explicit
  // confirm-level approval gate → standard verb is ask.
  generate_repo_docs: { impact: "destructive", standardVerb: "ask" },

  // --- Web (read-only; injection risk is handled by content-scanner downstream) ---
  run_web_search:     { impact: "read-only",   standardVerb: "auto" },
  read_webpage:       { impact: "read-only",   standardVerb: "auto" },
  run_website_task:   { impact: "high",        standardVerb: "auto" },

  // --- Filesystem (unified `file` tool) ---
  // unified `file` tool with command dispatch.
  // Tool-level impact is "destructive" (conservative default for
  // tier routing); per-command severity lives in
  // @nautilo/trust/file-tool-policies.ts and is the authoritative
  // source (approval dock + HIL routing read it, not this tag).
  // Phase 2's verb map runs at the tool level; "ask" is correct as
  // the catalog fallback until the composite-verb approval-dock path
  // takes over for `file.<command>` calls.
  file:               { impact: "destructive", standardVerb: "ask" },
  // contextual multi-file text mutation. The explicit prove_it
  // approval gate in register-all is authoritative for this destructive tool.
  apply_patch:        { impact: "destructive", standardVerb: "prove_it" },
  // dedicated convert tool; cloud egress gated (Phase 0: prompt-once-
  // per-session). Static tool-level requiresApproval → "ask" for now.
  convert:            { impact: "high",        standardVerb: "ask" },
  // office suite (LibreOffice). `office` + `edit_doc` both declare
  // impact:"low" + requiresApproval:false in register-all, capability-gated by
  // use_high_impact_tools (same posture as the `file` cap-gate); low → auto.
  office:             { impact: "low",         standardVerb: "auto" },
  edit_doc:           { impact: "low",         standardVerb: "auto" },
  // headless OfficeCLI generation (replaces write_xlsx / write_pptx).
  officecli:          { impact: "low",         standardVerb: "auto" },

  // --- Shell — destructive; per-invocation severity comes from the scanner.
  // The "standardVerb" here is the unscanned-allowed path (benign shell:
  // `echo hi`, `ls`). Scanner hits are asserted separately below.
  run_shell:          { impact: "destructive", standardVerb: "ask" },
  // generic HIL is auto because invocation-service owns the sole exact
  // review after Electron resolves the remote user and host-trust evidence.
  structured_ssh_auth: { impact: "high", standardVerb: "auto" },
  structured_ssh_exec: { impact: "high", standardVerb: "auto" },
  structured_ssh_output: { impact: "read-only", standardVerb: "auto" },
  structured_ssh_copy_upload: { impact: "high", standardVerb: "auto" },
  structured_ssh_copy_download: { impact: "high", standardVerb: "auto" },
  // Electron-owned Current Folder transition. The model supplies only
  // a bounded relative selector; local prepare/commit authority still requires
  // the explicit prove-it approval declared by the catalog registration.
  select_current_folder: { impact: "high", standardVerb: "prove_it" },
  // interactive shared PTY. impact "high" (not destructive) + no
  // requiresApproval → capability-gated allow (auto) for use_terminal holders;
  // operator decision: no PIN.
  terminal:           { impact: "high",        standardVerb: "auto" },

  // Computer Use entries are intentionally absent from this static map.
  // Their signed active catalogue descriptors derive impact below, so adding
  // a compatible contract never requires editing this compiled canon.
  // embedded SaaS browser tools (observe + routine control; no approval).
  browser_snapshot:   { impact: "low",         standardVerb: "auto" },
  browser_click:      { impact: "low",         standardVerb: "auto" },
  browser_type:       { impact: "low",         standardVerb: "auto" },
  browser_press:      { impact: "low",         standardVerb: "auto" },
  browser_read:       { impact: "read-only",   standardVerb: "auto" },
  browser_read_page:  { impact: "read-only",   standardVerb: "auto" },
  browser_screenshot: { impact: "read-only",   standardVerb: "auto" },
  browser_mouse:      { impact: "low",         standardVerb: "auto" },
  browser_get:        { impact: "read-only",   standardVerb: "auto" },
  browser_scroll:     { impact: "low",         standardVerb: "auto" },
  browser_back:       { impact: "low",         standardVerb: "auto" },
  browser_open:       { impact: "low",         standardVerb: "auto" },
  browser_forward:    { impact: "low",         standardVerb: "auto" },
  browser_reload:     { impact: "low",         standardVerb: "auto" },
  browser_hover:      { impact: "low",         standardVerb: "auto" },
  browser_double_click: { impact: "low",       standardVerb: "auto" },
  browser_drag:       { impact: "low",         standardVerb: "auto" },
  browser_select:     { impact: "low",         standardVerb: "auto" },
  browser_set_checked: { impact: "low",        standardVerb: "auto" },
  browser_scroll_into_view: { impact: "low",   standardVerb: "auto" },
  browser_wait:       { impact: "low",         standardVerb: "auto" },
  google_workspace:   { impact: "low",         standardVerb: "auto" },
  hue_lights:         { impact: "low",         standardVerb: "auto" },

  // --- Config ---
  // update_config / regenerate_soul: destructive. Today
  // these fire prove_it via requiresApproval+approvalLevel.
  // Phase 2 decision: keep that flow AND the verb map (belt-and-
  // suspenders), or migrate to the verb map alone. For now both exist;
  // the impact flip is preparatory.
  update_config:      { impact: "destructive", standardVerb: "ask" },
  check_config:       { impact: "read-only",   standardVerb: "auto" },
  use_connection:     { impact: "high",        standardVerb: "auto" },
  list_connections:   { impact: "read-only",   standardVerb: "auto" },
  use_credential:     { impact: "high",        standardVerb: "auto" },
  delete_connection:  { impact: "destructive", standardVerb: "ask" },
  manage_profile:     { impact: "low",         standardVerb: "auto" },
  // The Agent generates + sets her own profile avatar (preview →
  // apply gate). Same tier as manage_profile; low impact → auto verb.
  manage_avatar:      { impact: "low",         standardVerb: "auto" },
  get_current_time:   { impact: "low",         standardVerb: "auto" },
  manage_voices:      { impact: "low",         standardVerb: "auto" },
  onboarding_status:  { impact: "read-only",   standardVerb: "auto" },
  // opens the customization wizard after user consent;
  // low-impact one-way client action, auto verb.
  launch_customization: { impact: "low",       standardVerb: "auto" },
  guide_user:         { impact: "read-only", standardVerb: "auto" },
  find_voice:         { impact: "read-only",   standardVerb: "auto" },
  audition_voices:    { impact: "read-only",   standardVerb: "auto" },
  // Reads allowed-zone audio and uploads bytes to vendor STT. Keep high
  // impact but force an explicit approval gate instead of high-impact
  // standard-tier auto.
  transcribe_audio:   { impact: "high",        standardVerb: "ask" },
  // local MP4 ingest and fixed relay extraction are explicitly
  // approved high-impact media operations; extraction never calls STT.
  ingest_local_media: { impact: "high",        standardVerb: "ask" },
  extract_audio_from_video: { impact: "high",  standardVerb: "ask" },
  // image generation to artifact zone; low impact, no approval gate.
  generate_image:     { impact: "low",         standardVerb: "auto" },
  generate_video:     { impact: "destructive", standardVerb: "prove_it" },
  generate_music:     { impact: "destructive", standardVerb: "prove_it" },
  regenerate_soul:    { impact: "destructive", standardVerb: "ask" },

  // --- Trust ---
  // verify_identity keeps `impact: "high"` — prove_it is enforced by the
  // existing approval flow (`requiresApproval` is NOT set here, but the tool
  // itself handles PIN challenges internally). Verb-map auto at standard
  // is the correct outcome; the tool does not want a second prompt layer.
  verify_identity:    { impact: "high",        standardVerb: "auto" },

  // --- Meta ---
  discover_tools:     { impact: "read-only",   standardVerb: "auto" },
  evaluate_decisions: { impact: "low", standardVerb: "auto" },
  // Bounded, read-only resolved model catalog discovery.
  discover_models:    { impact: "read-only",   standardVerb: "auto" },
  activate_tools:     { impact: "read-only",   standardVerb: "auto" },
  deactivate_tools:   { impact: "read-only",   standardVerb: "auto" },
  // local explainer discovery and a user-consented direct-playback
  // resolver; both return trusted, structured local/server-computed output.
  find_explainer:     { impact: "read-only",   standardVerb: "auto" },
  play_explainer:     { impact: "read-only",   standardVerb: "auto" },
  // speaker-scoped skill search (catalog-primary v1).
  discover_skills:    { impact: "read-only",   standardVerb: "auto" },
  // drop an engaged skill from the next rebuild (graph state only).
  eject:              { impact: "read-only",   standardVerb: "auto" },

  // --- execute_artifact ---
  // Sandboxed script execution. Catalog impact is
  // destructive because it runs code (even though contained to artifact
  // zones by @nautilo/sandbox). The tool also sets requiresApproval +
  // approvalLevel=prove_it in register-all.ts; this canon pins only the
  // Catalog impact→verb-map fallback, where destructive at standard maps to ask.
  execute_artifact:   { impact: "destructive", standardVerb: "ask" },

  // --- Research ---
  run_deep_research:  { impact: "high",        standardVerb: "auto" },
  // Desktop-local scanners and the Task-owned evidence ledger are
  // read-only with respect to the selected repository. The report artifact is
  // written by the Task runtime through its existing protected artifact path.
  security_scan:      { impact: "read-only",   standardVerb: "auto" },
  // --- Agent reply policy ---
  // targetless skip remains ordinary silence, but the
  // target-bearing form can cause a visible peer turn + focus transfer after
  // server revalidation. Keep the removed redirect tool's low impact while
  // retaining the standard-tier auto verb.
  skip:               { impact: "low",         standardVerb: "auto" },
  // authoring tool for agent skills. Low-impact (writes the
  // caller's own skill rows; two-gated in the tool body); auto verb.
  skill_manage:       { impact: "low",         standardVerb: "auto" },
  // read-only mid-turn skill body fallback (R5).
  view_skill:         { impact: "read-only",   standardVerb: "auto" },
  // `command_*` family mirrors `skill_*` one-to-one.
  // `command_manage` is low-impact (writes the caller's own command rows;
  // two-gated in the tool body); auto verb.
  command_manage:     { impact: "low",         standardVerb: "auto" },
  // read-only mid-turn command body fallback.
  view_command:       { impact: "read-only",   standardVerb: "auto" },
  // speaker-scoped command catalog search.
  discover_commands:  { impact: "read-only",   standardVerb: "auto" },
  // structural mirror of `eject` (skills); read-only no-op.
  eject_command:      { impact: "read-only",   standardVerb: "auto" },

  // --- Mini-app authoring ---
  // Mutates installed app source and can refresh app-declared agent tools.
  // Static destructive impact → ask at standard security level.
  mini_app:           { impact: "destructive", standardVerb: "ask" },

  // private website-account reads remain capability-gated and the
  // server re-checks exact Human/Genie ownership before execution.
  browse_web: { impact: "low", standardVerb: "auto" },
  read_connected_web_account: { impact: "low", standardVerb: "auto" },
  // Supervision and semantic browser commands operate only within that
  // already-admitted read or task. New effects use the task/action tool;
  // basic supervision and browser control remain automatic.
  act_connected_web_account: { impact: "high", standardVerb: "auto" },
  manage_connected_web_operation: { impact: "low", standardVerb: "auto" },
  control_connected_web_operation: { impact: "low", standardVerb: "auto" },

  // --- Local (relay-tier) MCP setup ---
  // Verified-user tool (no cap gate), impact "low" → catalog fallback verb
  // is auto. The `enable` verb is approval-gated ("ask") by a NARROW branch
  // in checkToolAccess + post-model's resolveApprovalForToolCall, not by
  // this catalog-level fallback — so the canon's fallback stays auto.
  manage_local_mcp:   { impact: "low",         standardVerb: "auto" },
};

describe("tool impact canon", () => {
  let catalog: ToolCatalog;

  beforeAll(() => {
    setConfigOverrides({ nautilo_office_enabled: true });
    catalog = new ToolCatalog();
    // officecli registration is gated on a usable binary. Force it on so
    // the canon count is deterministic regardless of whether the host has a
    // vendored binary provisioned (the binary is no longer committed to git).
    registerAllTools(catalog, { officeCliAvailable: () => true, publicBrowserUseAvailable: () => true });
    setConfigOverrides({ nautilo_office_enabled: false });
  });

  test("every built-in tool is in the canon (guard against drift)", () => {
    // The catalog API exposes getStats() but not a name list — assert
    // count equality, plus spot-check that every canon key resolves.
    // Any new tool added to register-all.ts will bump the count and fail
    // this test until the canon is updated.
    const stats = catalog.getStats();
    const computerUseDefinitions = activeComputerUseHostToolDefinitions();
    expect(stats.total).toBe(Object.keys(CANON).length + computerUseDefinitions.length);
    for (const name of Object.keys(CANON)) {
      expect(catalog.get(name), `canon references missing tool: ${name}`).toBeDefined();
    }
    for (const definition of computerUseDefinitions) {
      const entry = catalog.get(definition.name);
      expect(entry, `signed catalogue tool missing: ${definition.name}`).toBeDefined();
      expect(entry!.impact).toBe(definition.impact);
      expect(resolveApproval({ toolImpact: entry!.impact }, "standard").verb)
        .toBe(resolveApproval({ toolImpact: definition.impact }, "standard").verb);
    }
  });

  test("every built-in tool declares progressive exposure", () => {
    for (const entry of catalog.query({})) {
      expect(entry.exposure, `${entry.name} is missing exposure`).toBeDefined();
    }
  });

  for (const [name, canon] of Object.entries(CANON)) {
    test(`${name}: impact = ${canon.impact}`, () => {
      const entry = catalog.get(name);
      expect(entry).toBeDefined();
      expect(entry!.impact).toBe(canon.impact);
    });

    test(`${name}: verb at standard (unscanned) = ${canon.standardVerb}`, () => {
      const entry = catalog.get(name);
      expect(entry).toBeDefined();
      const fallback = resolveApproval(
        { toolImpact: entry!.impact },
        "standard",
      ).verb;
      const effectiveVerb =
        (
          name === "transcribe_audio" ||
          name === "convert" ||
          name === "apply_patch" ||
          name === "select_current_folder" ||
          name === "structured_ssh_auth" ||
          name === "structured_ssh_exec" ||
          name === "ingest_local_media" ||
          name === "extract_audio_from_video" ||
          name === "generate_video" ||
          name === "generate_music"
        ) && entry!.requiresApproval
          ? entry!.approvalLevel === "prove_it" ? "prove_it" : "ask"
          : fallback;
      expect(effectiveVerb).toBe(canon.standardVerb);
    });
  }

  test("transcribe_audio uses explicit approval override instead of high-impact auto", () => {
    const entry = catalog.get("transcribe_audio");
    expect(entry).toBeDefined();
    expect(entry!.impact).toBe("high");
    expect(entry!.requiresApproval).toBe(true);
    expect(entry!.approvalLevel).toBe("confirm");
    expect(resolveApproval({ toolImpact: entry!.impact }, "standard").verb).toBe("auto");
  });

  // Spot-checks that lock in Phase 2's headline wins against the current
  // tag state — i.e. "when Phase 2 wires this up, here is what users
  // experience for the common cases".

  test("run_shell + scanner high → prove_it at standard (was: blocked outright)", () => {
    const entry = catalog.get("run_shell");
    const result = resolveApproval(
      {
        toolImpact: entry!.impact,
        commandScan: {
          allowed: false,
          severity: "high",
          matchedPatterns: [{ key: "sudo", description: "Privilege escalation via sudo", severity: "high" }],
          normalizedCommand: "sudo apt update",
        },
      },
      "standard",
    );
    expect(result.verb).toBe("prove_it");
  });

  test("run_shell + scanner medium → ask at standard (was: blocked outright)", () => {
    const entry = catalog.get("run_shell");
    const result = resolveApproval(
      {
        toolImpact: entry!.impact,
        commandScan: {
          allowed: false,
          severity: "medium",
          matchedPatterns: [{ key: "npm_global", description: "Global npm install", severity: "medium" }],
          normalizedCommand: "npm install -g typescript",
        },
      },
      "standard",
    );
    expect(result.verb).toBe("ask");
  });

  test("run_shell + scanner critical → block at standard (fork bomb, rm -rf /)", () => {
    const entry = catalog.get("run_shell");
    const result = resolveApproval(
      {
        toolImpact: entry!.impact,
        commandScan: {
          allowed: false,
          severity: "critical",
          matchedPatterns: [{ key: "fork_bomb", description: "Fork bomb", severity: "critical" }],
          normalizedCommand: ":() { : | :& };:",
        },
      },
      "standard",
    );
    expect(result.verb).toBe("block");
  });

  test("run_shell + ./install.sh (no scan hit, external-binary) → ask", () => {
    const entry = catalog.get("run_shell");
    const result = resolveApproval(
      {
        toolImpact: entry!.impact,
        commandScan: { allowed: true, matchedPatterns: [], normalizedCommand: "./install.sh" },
        isExternalUnknownBinary: true,
      },
      "standard",
    );
    expect(result.verb).toBe("ask");
  });
});
