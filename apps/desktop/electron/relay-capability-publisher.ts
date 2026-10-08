/**
 * Session-bound Desktop capability publication.
 *
 * `RelayClient` remains the sole owner of transport, update serialization, and
 * server acknowledgement. This publisher only rebuilds Desktop's full local
 * capability projection after a local mutation races an in-flight publication.
 */

import type { RelayCapabilities, RelayClient, RelayStatus } from "@nautilo/relay";

type CapabilityPublisherClient = Pick<
  RelayClient,
  "getAcknowledgedCapabilityRevision" | "updateCapabilities"
> & {
  getStatus(): RelayStatus;
};

type CapabilityWarningReporter = (message: string) => void;

export interface RelayCapabilityPublisher {
  refresh(reason?: string): Promise<boolean>;
  getAcknowledgedCapabilityRevision(): number | null;
  getAcknowledgedCapabilities(): RelayCapabilities | null;
  invalidateAcknowledgement(): void;
  close(): void;
}

export interface RelayCapabilityPublisherOptions {
  client: CapabilityPublisherClient;
  capabilityBuilder: () => Promise<RelayCapabilities>;
  reportWarning?: CapabilityWarningReporter;
  onAcknowledged?: (() => void) | undefined;
}

export function createRelayCapabilityPublisher(
  options: RelayCapabilityPublisherOptions,
): RelayCapabilityPublisher {
  let closed = false;
  let acknowledgementEpoch = 0;
  let acknowledged: { revision: number; capabilities: RelayCapabilities } | null = null;
  let activeDrain: Promise<boolean> | null = null;
  let trailingRefreshPending = false;

  const reportWarning = options.reportWarning ?? console.warn;

  function warning(reason: string | undefined, detail: string): void {
    reportWarning(
      `[relay] refreshDesktopRelayCapabilities failed${
        reason ? ` (${reason})` : ""
      }: ${detail}`,
    );
  }

  async function performRefresh(reason?: string): Promise<boolean> {
    const epoch = acknowledgementEpoch;
    if (closed) {
      return false;
    }
    if (options.client.getStatus() !== "connected") {
      return false;
    }

    try {
      const capabilities = await options.capabilityBuilder();
      if (closed || epoch !== acknowledgementEpoch) {
        return false;
      }

      const snapshot = structuredClone(capabilities);
      await options.client.updateCapabilities(capabilities);
      if (closed || epoch !== acknowledgementEpoch) {
        return false;
      }

      const revision = options.client.getAcknowledgedCapabilityRevision();
      if (revision === null || options.client.getStatus() !== "connected") {
        warning(reason, "relay did not acknowledge capability update");
        return false;
      }
      acknowledged = { revision, capabilities: snapshot };
      options.onAcknowledged?.();
      return true;
    } catch (error) {
      warning(
        reason,
        error instanceof Error ? error.message : String(error),
      );
      return false;
    }
  }

  async function drain(reason?: string): Promise<boolean> {
    try {
      let result = false;
      do {
        trailingRefreshPending = false;
        result = await performRefresh(reason);
      } while (!closed && trailingRefreshPending);
      return result;
    } finally {
      activeDrain = null;
      trailingRefreshPending = false;
    }
  }

  return {
    refresh(reason?: string): Promise<boolean> {
      if (closed) {
        return Promise.resolve(false);
      }
      if (activeDrain) {
        trailingRefreshPending = true;
        return activeDrain;
      }

      const nextDrain = drain(reason);
      activeDrain = nextDrain;
      return nextDrain;
    },

    getAcknowledgedCapabilityRevision(): number | null {
      return closed ? null : options.client.getAcknowledgedCapabilityRevision();
    },

    getAcknowledgedCapabilities(): RelayCapabilities | null {
      if (closed || options.client.getStatus() !== "connected" || !acknowledged
        || options.client.getAcknowledgedCapabilityRevision() !== acknowledged.revision) return null;
      return structuredClone(acknowledged.capabilities);
    },

    invalidateAcknowledgement(): void { acknowledgementEpoch++; acknowledged = null; },

    close(): void {
      closed = true;
      acknowledged = null;
      trailingRefreshPending = false;
    },
  };
}
