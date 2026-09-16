import type {
  ConnectedAppCapability,
  ConnectedAppLifecycle,
  ConnectedAppProviderId,
  ConnectionProviderCatalog,
  ConnectionProviderDescriptor,
} from "@nautilo/types";

export type ConnectedAppProviderDefinition = Readonly<{
  id: ConnectedAppProviderId;
  displayName: string;
  description: string;
  searchTerms: readonly string[];
  iconUrl: string | null;
  shortMark: string;
  sortOrder: number;
  lifecycle: ConnectedAppLifecycle;
  defaultEnabled: boolean;
  service: string;
  supportedDrivers: ConnectionProviderDescriptor["supportedDrivers"];
  setupUrl: string;
  acceptsAdminToken: boolean;
  oauthScopes: readonly string[];
  capabilities: readonly ConnectedAppCapability[];
  admittedToolNames: readonly string[];
  admittedActionIds: readonly string[];
  schemaSha256: Readonly<Record<string, string>>;
}>;

function connectedAppProviderDefinition(
  provider: ConnectionProviderDescriptor,
): ConnectedAppProviderDefinition {
  return {
    id: provider.id,
    displayName: provider.displayName,
    description: provider.description,
    searchTerms: provider.searchTerms,
    iconUrl: provider.iconUrl,
    shortMark: provider.shortMark,
    sortOrder: provider.sortOrder,
    lifecycle: provider.lifecycle,
    defaultEnabled: provider.defaultEnabled,
    service: provider.service,
    supportedDrivers: provider.supportedDrivers,
    setupUrl: provider.setup.providerSetupUrl,
    acceptsAdminToken: provider.setup.acceptsAdminToken,
    oauthScopes: provider.setup.scopes,
    capabilities: provider.operations.map((operation) => ({
      operationId: operation.sourceActionId,
      label: operation.label,
      effect: operation.effect,
      requiresApproval: operation.requiresApproval,
    })),
    admittedToolNames: provider.operations.map((operation) => operation.toolName),
    admittedActionIds: provider.operations.map((operation) => operation.sourceActionId),
    schemaSha256: Object.fromEntries(provider.operations.map((operation) => [
      operation.sourceActionId,
      operation.sourceSchemaSha256,
    ])),
  };
}

export function connectedAppProviderDefinitions(
  catalog: ConnectionProviderCatalog,
): readonly ConnectedAppProviderDefinition[] {
  return [...catalog.providers]
    .sort((left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id))
    .map(connectedAppProviderDefinition);
}
