/**
 * Core runtime interfaces. Each has two implementations controlled by env flags:
 * a simple in-process version (OSS) and a Postgres-backed scalable version (SaaS).
 *
 * See architecture-overall-v4.md Section 4 for the full rationale.
 *
 * M042A: RuntimePolicyContext used to live here as a forward-looking stub;
 * deleted because it was unused and diverged from the canonical type in
 * @nautilo/trust. The `relationshipRole` field it hinted at will reappear
 * as proper schema in M042D (relationship model). For the canonical type,
 * import from @nautilo/trust.
 */

export interface JobQueue {
  enqueue(job: unknown): Promise<string>;
  process(handler: (job: unknown) => Promise<void>): void;
  cancel(jobId: string): Promise<void>;
}

export type ReleaseFn = () => Promise<void>;

export type TryAcquireResult =
  | { acquired: true; release: ReleaseFn }
  | { acquired: false; busyKey: string };

export interface LaneLock {
  acquire(laneKey: string): Promise<ReleaseFn>;
  tryAcquire(laneKey: string): Promise<TryAcquireResult>;
}

export interface RealtimePublisher {
  publish(channel: string, event: string, data: unknown): Promise<void>;
}

export interface Observer {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface RelayRegistry {
  register(relayId: string, capabilities: unknown): Promise<void>;
  unregister(relayId: string): Promise<void>;
  dispatch(relayId: string, request: unknown): Promise<unknown>;
  listConnected(): Promise<string[]>;
}
