import type { RelayMcpHostHandle } from "@nautilo/mcp-client";
import {
  RELAY_MEDIA_TRANSFER_TTL_MS,
  type RelayClient,
  type RelayStatus,
} from "@nautilo/relay";

import { BrowserPageSnapshotStore } from "./browser-page-snapshot-store.ts";
import type { RelayCapabilityPublisher } from "./relay-capability-publisher.ts";
import type {
  MediaSessionRecord,
  MediaSessionsPort,
} from "./relay-dispatch/media.ts";
import type { StructuredSshDispatchRuntime } from "./relay-dispatch/structured-ssh.ts";
import { RunShellOutputArtifactStore } from "./run-shell-output-continuity.ts";

export type DesktopRelayGoogleOAuthContext = Readonly<{
  serverUrl: string;
  token?: string;
  clientPath?: string;
}>;

export interface BrowserCoordinateScalePort {
  readonly get: (sessionId: string) => number | undefined;
  readonly set: (sessionId: string, scale: number) => void;
}

export interface DesktopRelayRetiredTransport {
  readonly client: RelayClient | null;
  readonly mcpHost: RelayMcpHostHandle | null;
}

export interface DesktopRelaySessionOptions {
  readonly serverUrl: string;
  readonly token?: string | undefined;
  readonly clientPath?: string | undefined;
  readonly onStatusChange?: ((status: RelayStatus) => void) | undefined;
}

/**
 * One-shot owner for resources scoped to one authenticated Desktop relay
 * session. Transport shutdown remains the caller's LIFO responsibility.
 */
export class DesktopRelaySession {
  private readonly outputArtifactStoreValue =
    new RunShellOutputArtifactStore();
  private readonly pageSnapshotStoreValue = new BrowserPageSnapshotStore();
  private readonly mediaSessionRecords = new Map<string, MediaSessionRecord>();
  private readonly coordinateScales = new Map<string, number>();
  private mediaBufferedBytes = 0;
  private closedValue = false;
  private googleOAuthContextValue: DesktopRelayGoogleOAuthContext | null;
  private statusCallbackValue: ((status: RelayStatus) => void) | null;
  private mcpHostValue: RelayMcpHostHandle | null = null;
  private clientValue: RelayClient | null = null;
  private publisherValue: RelayCapabilityPublisher | null = null;
  private structuredSshRuntimeValue: StructuredSshDispatchRuntime | null = null;
  private readonly boundWork = new Set<Promise<void>>();
  private retirementCompletion: Promise<void> | null = null;
  private mcpHostAttached = false;
  private transportAttached = false;
  private structuredSshRuntimeAttached = false;

  readonly mediaSessions: MediaSessionsPort;
  readonly browserCoordinateScales: BrowserCoordinateScalePort;

  constructor(options: DesktopRelaySessionOptions) {
    this.googleOAuthContextValue = Object.freeze({
      serverUrl: options.serverUrl,
      ...(options.token === undefined ? {} : { token: options.token }),
      ...(options.clientPath === undefined
        ? {}
        : { clientPath: options.clientPath }),
    });
    this.statusCallbackValue = options.onStatusChange ?? null;

    this.mediaSessions = Object.freeze({
      size: () => this.closedValue ? 0 : this.mediaSessionRecords.size,
      get: (sessionId: string) => this.closedValue
        ? undefined
        : this.mediaSessionRecords.get(sessionId),
      has: (sessionId: string) => !this.closedValue && this.mediaSessionRecords.has(sessionId),
      set: (sessionId: string, session: MediaSessionRecord) => {
        if (!this.closedValue) this.mediaSessionRecords.set(sessionId, session);
      },
      release: (sessionId: string) => {
        if (!this.closedValue) this.releaseMediaSession(sessionId);
      },
      expire: () => {
        if (this.closedValue) return;
        for (const [sessionId, session] of this.mediaSessionRecords) {
          if (Date.now() - session.createdAt > RELAY_MEDIA_TRANSFER_TTL_MS) {
            this.releaseMediaSession(sessionId);
          }
        }
      },
      getBufferedBytes: () => this.closedValue ? 0 : this.mediaBufferedBytes,
      adjustBufferedBytes: (delta: number) => {
        if (!this.closedValue) this.mediaBufferedBytes += delta;
      },
    });

    this.browserCoordinateScales = Object.freeze({
      get: (sessionId: string) => this.closedValue
        ? undefined
        : this.coordinateScales.get(sessionId),
      set: (sessionId: string, scale: number) => {
        if (!this.closedValue) this.coordinateScales.set(sessionId, scale);
      },
    });
  }

  get closed(): boolean {
    return this.closedValue;
  }

  get googleOAuthContext(): DesktopRelayGoogleOAuthContext | null {
    return this.googleOAuthContextValue;
  }

  get runShellOutputArtifactStore(): RunShellOutputArtifactStore {
    return this.outputArtifactStoreValue;
  }

  get browserPageSnapshotStore(): BrowserPageSnapshotStore {
    return this.pageSnapshotStoreValue;
  }

  get statusCallback(): ((status: RelayStatus) => void) | null {
    return this.statusCallbackValue;
  }

  get mcpHost(): RelayMcpHostHandle | null {
    return this.mcpHostValue;
  }

  get client(): RelayClient | null {
    return this.clientValue;
  }

  get publisher(): RelayCapabilityPublisher | null {
    return this.publisherValue;
  }

  get structuredSshRuntime(): StructuredSshDispatchRuntime | null {
    return this.structuredSshRuntimeValue;
  }

  attachMcpHost(mcpHost: RelayMcpHostHandle): void {
    this.assertAttachable(this.mcpHostAttached, "MCP host");
    this.mcpHostAttached = true;
    this.mcpHostValue = mcpHost;
  }

  attachTransport(
    client: RelayClient,
    publisher: RelayCapabilityPublisher,
  ): void {
    this.assertAttachable(this.transportAttached, "transport");
    this.transportAttached = true;
    this.clientValue = client;
    this.publisherValue = publisher;
  }

  attachStructuredSshRuntime(runtime: StructuredSshDispatchRuntime): void {
    this.assertAttachable(this.structuredSshRuntimeAttached, "structured SSH runtime");
    this.structuredSshRuntimeAttached = true;
    this.structuredSshRuntimeValue = runtime;
  }

  /**
   * Closes local resources and atomically detaches transport handles. The
   * caller stops the returned MCP host before disconnecting the client.
   */
  retire(): DesktopRelayRetiredTransport {
    if (this.closedValue) return { client: null, mcpHost: null };
    this.closedValue = true;
    const retired = {
      client: this.clientValue,
      mcpHost: this.mcpHostValue,
    };
    this.publisherValue?.close();
    this.publisherValue = null;
    this.clientValue = null;
    this.mcpHostValue = null;
    this.sweepSessionResources();
    return retired;
  }

  /**
   * Drain work already admitted by this session after transport teardown, then
   * sweep once more. Repeated callers share the same retirement completion.
   */
  finishRetirement(): Promise<void> {
    if (!this.closedValue) return Promise.resolve();
    this.retirementCompletion ??= this.drainRetiredWork();
    return this.retirementCompletion;
  }

  /** Ensure late work cannot repopulate resources after retirement. */
  settleBoundWork<T>(work: Promise<T>): Promise<T> {
    const result = work.finally(() => {
      if (this.closedValue) this.sweepSessionResources();
    });
    const tracked = result.then(
      () => {},
      () => {},
    );
    this.boundWork.add(tracked);
    void tracked.finally(() => {
      this.boundWork.delete(tracked);
    });
    return result;
  }

  private assertAttachable(alreadyAttached: boolean, resource: string): void {
    if (this.closedValue) {
      throw new Error(`Cannot attach ${resource} to a retired Desktop relay session.`);
    }
    if (alreadyAttached) {
      throw new Error(`Desktop relay session ${resource} is already attached.`);
    }
  }

  private releaseMediaSession(sessionId: string): void {
    const session = this.mediaSessionRecords.get(sessionId);
    if (session === undefined) return;
    for (const chunk of session.source) chunk.fill(0);
    session.audio?.fill(0);
    this.mediaBufferedBytes -=
      session.receivedBytes + (session.audio?.byteLength ?? 0);
    this.mediaSessionRecords.delete(sessionId);
  }

  private sweepSessionResources(): void {
    this.outputArtifactStoreValue.clear();
    this.pageSnapshotStoreValue.close();
    for (const sessionId of [...this.mediaSessionRecords.keys()]) {
      this.releaseMediaSession(sessionId);
    }
    this.mediaBufferedBytes = 0;
    this.coordinateScales.clear();
    this.googleOAuthContextValue = null;
    this.structuredSshRuntimeValue = null;
  }

  private async drainRetiredWork(): Promise<void> {
    while (this.boundWork.size > 0) {
      await Promise.allSettled([...this.boundWork]);
    }
    this.sweepSessionResources();
    this.statusCallbackValue = null;
  }
}
