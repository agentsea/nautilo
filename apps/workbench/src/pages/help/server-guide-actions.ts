import type { CapabilitySlug } from "@nautilo/types";

export type ServerGuideActionId =
  | "configure-server"
  | "configure-providers"
  | "invite-team"
  | "get-desktop"
  | "finish-setup";

export interface ServerGuideAction {
  readonly id: ServerGuideActionId;
  readonly title: string;
  readonly description: string;
  readonly href: string;
  readonly external?: boolean;
  readonly requiresCapability?: CapabilitySlug;
  readonly unavailableDescription?: string;
}

/**
 * Code owns the finite set of administrator next steps. This is deliberately
 * not a guide plugin registry: documentation copy may evolve later, but it
 * never gains authority to choose a route, capability or external origin.
 */
export const SERVER_GUIDE_ACTIONS: readonly ServerGuideAction[] = [
  {
    id: "configure-server",
    title: "Configure server",
    description: "Set the server identity and review its configuration.",
    href: "/admin#server",
    requiresCapability: "read_server_settings",
    unavailableDescription: "You need server-settings access to open this section.",
  },
  {
    id: "configure-providers",
    title: "API Keys",
    description: "Add the API keys this server will use.",
    href: "/admin#provider-credentials",
    requiresCapability: "manage_connection_providers",
    unavailableDescription: "You need API-key management access to change API keys.",
  },
  {
    id: "invite-team",
    title: "Invite team",
    description: "Create invitations for the people who will use this server.",
    href: "/admin#invites",
    requiresCapability: "manage_members",
    unavailableDescription: "You need member-management access to invite people.",
  },
  {
    id: "get-desktop",
    title: "Get Desktop",
    description: "Download Nautilo Desktop for the richer desktop experience.",
    href: "https://nautilo.ai/download",
    external: true,
  },
  {
    id: "finish-setup",
    title: "I'm all set — take me to chat",
    description: "Finish this guide and open chat in your current Nautilo client.",
    href: "/",
  },
];
