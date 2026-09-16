import type { VerifiedOrdinaryOrigin } from "@nautilo/types";

export interface ResolvedOrdinaryHost {
  readonly relayId: string;
  /** Present only when authority came through a durable mobile binding. */
  readonly bindingId?: string;
  readonly pairingGeneration: string;
  readonly desktopSessionId: string;
  readonly capabilityRevision: number;
  /** Server-private Relay roots; never serialized to the mobile caller. */
  readonly workspaceRoot?: string;
  readonly currentFolderRoot?: string;
}

export type OrdinaryHostResolution =
  | { readonly status: "unavailable" }
  | { readonly status: "selected"; readonly host: ResolvedOrdinaryHost }
  | {
      readonly status: "choice_required";
      readonly choiceId: string;
      readonly options: ReadonlyArray<{ readonly selector: string; readonly label: string }>;
    };

/** Server-owned port. The agent package never reads pairing persistence. */
export interface OrdinaryHostResolver {
  resolve(input: {
    readonly origin: VerifiedOrdinaryOrigin;
    readonly toolCallId: string;
    readonly toolName: string;
    readonly relayCapability: string;
    readonly hostedBy?: string | null;
    readonly choice?: { readonly choiceId: string; readonly selector: string };
  }): Promise<OrdinaryHostResolution>;
}

let resolver: OrdinaryHostResolver | null = null;

export function setOrdinaryHostResolver(next: OrdinaryHostResolver | null): void {
  resolver = next;
}

export function getOrdinaryHostResolver(): OrdinaryHostResolver | null {
  return resolver;
}
