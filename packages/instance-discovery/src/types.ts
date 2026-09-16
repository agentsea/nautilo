export type InstanceListState = "running" | "idle" | "no-instance-json" | "invalid-json";

export type LocalInstanceRow = {
  root: string;
  /** `NAUTILO_INSTANCE_ID` value (empty for default). */
  instanceId: string;
  displayId: string;
  projectName: string;
  serverPort: number;
  workbenchPort: number;
  state: InstanceListState;
  detail?: string;
};

export type ListLocalInstancesDeps = {
  /** Optional override for tests (no real fetch). */
  probeHealth?: (url: string) => Promise<boolean>;
};

/** One row from `_nautilo._tcp` browse (see `browseLocalInstances`). */
export type DiscoveredNautiloService = {
  name: string;
  host: string;
  port: number;
  /** Resolved IPv4/IPv6 addresses from mDNS, when present. */
  addresses: readonly string[];
  /** HTTP base URL for the control plane (best-effort from A/AAAA). */
  serverUrl: string;
  txt: Record<string, string>;
};

export type BrowseLocalInstancesDeps = {
  timeoutMs?: number | undefined;
};
