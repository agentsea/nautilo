import type { UiTargetId } from "@nautilo/types";

export const CONNECTION_SECTION_IDS = [
  "agent-harnesses",
  "apps-and-accounts",
  "websites",
  "this-mac",
  "mcp-servers",
] as const;

export type ConnectionsSectionId = (typeof CONNECTION_SECTION_IDS)[number];

/** Runtime MCP rows are data, not durable navigation destinations. */
export type ConnectionCardId =
  | "codex"
  | "claude"
  | "hermes-acp"
  | "google"
  | "computer-use"
  | "github-cli"
  | "ssh"
  | "local-mcp";

type ConnectionCard = Readonly<{
  id: ConnectionCardId;
  visibility: "all" | "desktop";
  catalogueTarget?: UiTargetId;
}>;

type ConnectionSection = Readonly<{
  id: ConnectionsSectionId;
  label: string;
  description: string;
  cards: readonly ConnectionCard[];
}>;

/** One canonical source for Connections order, card ownership, and hashes. */
export const CONNECTIONS_SECTIONS: readonly ConnectionSection[] = [
  {
    id: "agent-harnesses",
    label: "Agent harnesses",
    description: "Local agent runtimes that execute delegated Tasks.",
    cards: [
      { id: "codex", visibility: "all", catalogueTarget: "connections.codex" },
      { id: "claude", visibility: "all" },
      { id: "hermes-acp", visibility: "all" },
    ],
  },
  {
    id: "apps-and-accounts",
    label: "Apps & accounts",
    description: "Accounts your Genie can use on this device.",
    cards: [
      { id: "google", visibility: "all", catalogueTarget: "connections.google" },
    ],
  },
  {
    id: "websites",
    label: "Websites",
    description: "Website accounts your Genie can use through a protected browser.",
    cards: [],
  },
  {
    id: "this-mac",
    label: "Computer Use",
    description: "Computer Use authority and local developer tools for this Mac.",
    cards: [
      { id: "computer-use", visibility: "desktop" },
      { id: "github-cli", visibility: "all", catalogueTarget: "connections.github_cli" },
      { id: "ssh", visibility: "all", catalogueTarget: "connections.ssh" },
    ],
  },
  {
    id: "mcp-servers",
    label: "MCP servers",
    description: "Personal MCP connections available through this desktop.",
    cards: [{ id: "local-mcp", visibility: "all", catalogueTarget: "connections.local_mcp" }],
  },
] as const;

/** Fixed catalogue targets derive from the same card registry as the sidebar. */
export const CONNECTIONS_CATALOGUE_TARGETS: Readonly<Partial<Record<UiTargetId, ConnectionCardId>>> = Object.fromEntries(
  CONNECTIONS_SECTIONS.flatMap((section) => section.cards)
    .flatMap((card) => card.catalogueTarget ? [[card.catalogueTarget, card.id] as const] : []),
);

const parentByCard = new Map<ConnectionCardId, ConnectionsSectionId>(
  CONNECTIONS_SECTIONS.flatMap((section) => section.cards.map((card) => [card.id, section.id] as const)),
);
const cardById = new Map<ConnectionCardId, ConnectionCard>(
  CONNECTIONS_SECTIONS.flatMap((section) => section.cards.map((card) => [card.id, card] as const)),
);

/** Visibility is structural only; capability state remains owned by each card. */
export function isConnectionCardVisible(card: ConnectionCardId, isDesktopShell: boolean): boolean {
  return cardById.get(card)?.visibility !== "desktop" || isDesktopShell;
}

/** Resolve either a category hash or a preserved fixed-card hash. */
export function connectionSectionForHash(hash: string): ConnectionsSectionId | null {
  const id = hash.replace(/^#/, "") as ConnectionsSectionId | ConnectionCardId;
  if (CONNECTION_SECTION_IDS.includes(id as ConnectionsSectionId)) return id as ConnectionsSectionId;
  return parentByCard.get(id as ConnectionCardId) ?? null;
}
