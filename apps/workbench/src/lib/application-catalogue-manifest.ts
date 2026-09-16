/**
 * D513's canonical, route-free semantic inventory of stable Workbench
 * destinations. UI manifests bind these source tuples to real rendered
 * routes/sections; the generator emits only the metadata portion for shared
 * consumers. Do not add resource instances, actions, redirects, or disabled
 * affordances here.
 */
export type ApplicationCatalogueSourceV1 = "route" | "settings" | "connections" | "admin" | "access-control";

export type ApplicationCatalogueManifestEntryV1 = {
  readonly target: string;
  readonly source: ApplicationCatalogueSourceV1;
  /** Stable id in the canonical rendered manifest, never a route or selector. */
  readonly sourceId: string;
  readonly label: string;
  readonly menuPath: readonly string[];
  readonly description: string;
  readonly discoveryTerms: readonly string[];
};

const entry = (
  target: string, source: ApplicationCatalogueSourceV1, sourceId: string,
  label: string, menuPath: readonly string[], description: string, discoveryTerms: readonly string[],
): ApplicationCatalogueManifestEntryV1 => ({ target, source, sourceId, label, menuPath, description, discoveryTerms });

/** The finite v1 support inventory. Keep entries in product navigation order. */
export const APPLICATION_CATALOGUE_MANIFEST_V1 = [
  entry("genie.customization", "route", "customize-genie", "Customize Genie", ["Genie", "Customize"], "Adjust Genie presentation and personalization.", ["customize", "customization", "personalize", "genie settings"]),
  entry("workbench.context", "route", "info", "Context", ["Workbench", "Context"], "Inspect the current work context.", ["context", "workspace context", "info"]),
  entry("help.server", "route", "help-server", "Server guide", ["Help", "Server guide"], "Read guidance for using this Nautilo server.", ["help", "server help", "guide", "documentation"]),
  entry("settings", "route", "settings", "Settings", ["Settings"], "Adjust personal Nautilo preferences and access.", ["settings", "preferences", "configuration"]),
  entry("admin", "route", "admin", "Server admin", ["Server admin"], "Manage server-wide configuration and governance.", ["admin", "server admin", "administration"]),
  entry("admin.access_control", "route", "access-control", "Access control", ["Server admin", "Access control"], "Inspect access and permission-set administration.", ["access control", "permissions", "roles", "groups"]),
  entry("costs", "route", "costs", "Costs dashboard", ["Costs dashboard"], "Review detailed Nautilo usage costs.", ["cost dashboard", "usage dashboard", "detailed spending"]),
  entry("skills", "route", "skills", "Skills", ["Skills"], "Browse installed and available skills.", ["skills", "skill library"]),
  entry("connections", "route", "connections", "Connections", ["Connections"], "Manage services, tools, and accounts available to Genie.", ["connections", "integrations", "connect"]),
  entry("commands", "route", "commands", "Commands", ["Commands"], "Browse available commands.", ["commands", "slash commands"]),
  entry("approvals", "route", "approvals", "Approvals", ["Approvals"], "Review requests that need your approval.", ["approvals", "approval requests"]),
  entry("memory", "route", "memory", "Memory", ["Memory"], "Review managed memory.", ["memory", "remembered information"]),
  entry("scheduled_tasks", "route", "scheduled-tasks", "Scheduled tasks", ["Scheduled tasks"], "Review scheduled task automation.", ["scheduled tasks", "schedule", "automation"]),
  entry("settings.profile", "settings", "profile", "Profile", ["Settings", "Profile"], "Manage your profile details.", ["profile", "account profile"]),
  entry("settings.my_agents", "settings", "my-agents", "My Agents", ["Settings", "My Agents"], "Manage your personal Agent profile, model, and fallback behavior.", ["my agents", "agents", "agent settings"]),
  entry("settings.this_mac", "settings", "this-mac", "This Mac", ["Settings", "This Mac"], "Manage settings owned by this Nautilo Desktop.", ["this mac", "desktop settings", "local settings"]),
  entry("settings.startup", "settings", "startup", "Ready at startup", ["Settings", "This Mac", "Ready at startup"], "Choose this Desktop's startup posture and review Ready to work status.", ["startup", "ready at startup", "ready to work", "desktop startup", "work mode"]),
  entry("settings.notifications", "settings", "notifications", "Notifications", ["Settings", "Notifications"], "Adjust notification preferences.", ["notifications", "alerts"]),
  entry("settings.model", "settings", "model", "Model", ["Settings", "My Agents", "Agent details", "Model"], "Choose the current personal Agent's preferred model.", ["agent model", "model selection", "my agent model"]),
  entry("settings.fallback", "settings", "fallback", "Model fallback", ["Settings", "My Agents", "Agent details", "Model fallback"], "Configure fallback behavior for the current personal Agent.", ["agent fallback", "fallback model", "model fallback"]),
  entry("settings.current_folder", "settings", "current-folder", "Current folder", ["Settings", "This Mac", "Current folder"], "Review this Desktop's current working folder.", ["current folder", "workspace folder", "desktop folder"]),
  entry("settings.your_access", "settings", "your-access", "Your access", ["Settings", "Your access"], "Review your current access and permissions.", ["your access", "my permissions", "access"]),
  entry("settings.desktop_permissions", "settings", "desktop-permissions", "macOS permissions", ["Settings", "This Mac", "macOS permissions"], "Manage macOS permissions used by Nautilo Desktop.", ["macos permissions", "desktop permissions", "mac permissions", "screen recording", "accessibility", "microphone"]),
  entry("settings.workstation_access", "settings", "workstation-access", "Workstation access", ["Settings", "This Mac", "Workstation access"], "Manage protected local access and host commands on this Desktop.", ["workstation access", "workstation", "desktop access", "filesystem access"]),
  entry("settings.devices", "settings", "devices", "Devices", ["Settings", "Devices"], "Manage the work computers and mobile controllers paired with your account.", ["devices", "device fleet", "work computers", "paired computers", "paired devices"]),
  entry("settings.encrypted_recovery", "settings", "encrypted-recovery", "Encrypted recovery", ["Settings", "Encrypted recovery"], "Set up encrypted recovery for this device.", ["encrypted recovery", "recovery phrase", "device encryption"]),
  entry("settings.mobile_access", "settings", "mobile-access", "Mobile controllers", ["Settings", "Devices", "Mobile controllers"], "Pair, rename, and revoke the phones that can control your work computers.", ["mobile", "mobile controllers", "mobile access", "paired phones", "phone pairing"]),
  entry("settings.invite_people", "settings", "invite-people", "Invite people", ["Settings", "Invite people"], "Create and manage your own server invitations.", ["invite people", "invite members", "invitation", "guest invite"]),
  entry("settings.security", "settings", "security", "Account security", ["Settings", "Account security"], "Manage your account password, recovery codes, and approval PIN.", ["account security", "password", "recovery codes", "approval pin"]),
  entry("settings.about", "settings", "about", "About", ["Settings", "About"], "Review Nautilo application information.", ["about", "version"]),
  entry("connections.codex", "connections", "codex", "Codex", ["Connections", "Codex"], "Set up or repair the Codex connection.", ["codex", "openai codex", "coding agent"]),
  entry("connections.github_cli", "connections", "github-cli", "GitHub CLI", ["Connections", "GitHub CLI"], "Review GitHub CLI availability and sign-in.", ["github", "github cli", "gh"]),
  entry("connections.ssh", "connections", "ssh", "SSH", ["Connections", "SSH"], "Set up or repair SSH access.", ["ssh", "secure shell", "remote shell"]),
  entry("connections.local_mcp", "connections", "local-mcp", "Local MCP", ["Connections", "Local MCP"], "Set up or repair a local MCP connection.", ["mcp", "local mcp", "model context protocol", "tool connection"]),
  entry("connections.google", "connections", "google", "Google Workspace", ["Connections", "Google Workspace"], "Configure, connect, or repair Google Workspace access.", ["google", "gmail", "calendar", "workspace", "connect google", "google oauth", "workspace credentials"]),
  entry("admin.server", "admin", "server", "Server", ["Server admin", "Server"], "Configure server settings.", ["server settings", "server configuration"]),
  entry("admin.memory", "admin", "memory", "Memory processing", ["Server admin", "Memory"], "Inspect automatic Memory review health, processing progress, model selection, and safe recovery.", ["memory processing", "memory health", "memory review", "automatic memory"]),
  entry("admin.stenographer", "admin", "stenographer", "Stenographer", ["Server admin", "Stenographer"], "Review Stenographer health and Room context-window settings.", ["stenographer", "journal health", "context window"]),
  entry("admin.reflection", "admin", "reflection", "Reflection", ["Server admin", "Reflection"], "Review and control hierarchical memory processing.", ["reflection", "sleep health", "hierarchical memory"]),
  entry("admin.search", "admin", "search", "Search", ["Server admin", "Search"], "Configure server-wide web search behavior.", ["search", "web research", "search provider"]),
  entry("admin.costs", "admin", "costs", "Costs", ["Server admin", "Costs"], "Review server usage costs.", ["server costs", "usage costs", "spending"]),
  entry("admin.users", "admin", "users", "Users", ["Server admin", "Users"], "Manage server users.", ["admin users", "server users"]),
  entry("admin.invites", "admin", "invites", "Invites", ["Server admin", "Invites"], "Manage server invitations.", ["invites", "invitations"]),
  entry("admin.reports", "admin", "reports", "Reports", ["Server admin", "Reports"], "Review content and person reports submitted to this server.", ["reports", "content reports", "moderation queue", "reported messages"]),
  entry("admin.audit_log", "admin", "audit-log", "Audit log", ["Server admin", "Audit log"], "Review server audit records.", ["audit log", "audit"]),
  entry("admin.models", "admin", "models", "Models", ["Server admin", "Models"], "Manage server model settings.", ["server models", "admin models"]),
  entry("admin.provider_credentials", "admin", "provider-credentials", "API Keys", ["Server admin", "API Keys"], "Manage API keys for this self-managed server.", ["provider credentials", "api keys", "provider keys", "model keys"]),
  entry("admin.official_mcps", "admin", "official-mcps", "Server MCPs", ["Server admin", "Server MCPs"], "Manage official server MCPs.", ["server mcp", "official mcp"]),
  entry("admin.security", "admin", "security", "Security", ["Server admin", "Security"], "Manage server security settings.", ["server security", "admin security"]),
  entry("admin.encryption", "admin", "encryption", "Encryption", ["Server admin", "Encryption"], "Manage server encryption transition and verification.", ["encryption", "shadow encryption", "encryption status"]),
  entry("admin.access_control.users", "access-control", "users", "Users", ["Server admin", "Access control", "Users"], "Manage access-control users.", ["access users", "permission users"]),
  entry("admin.access_control.groups", "access-control", "groups", "Groups", ["Server admin", "Access control", "Groups"], "Manage access-control groups.", ["access groups", "permission groups"]),
  entry("admin.access_control.roles", "access-control", "roles", "Permission sets", ["Server admin", "Access control", "Permission sets"], "Manage access-control permission sets.", ["roles", "permission sets", "access roles"]),
  entry("admin.access_control.capabilities", "access-control", "capabilities", "Permissions catalog", ["Server admin", "Access control", "Permissions catalog"], "Review the permissions catalog.", ["capabilities", "permissions catalog", "permission catalog"]),
] as const satisfies readonly ApplicationCatalogueManifestEntryV1[];
