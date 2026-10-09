/**
 * Server-installed CloudConvert lifecycle port. The Agent supplies current
 * content authority and bytes; the Server owns funding, provider credentials,
 * durable provider receipts, and restart reconciliation.
 */

export type CloudConversionSourceBinding = Readonly<{
  kind: "inline" | "artifact";
  artifactInternalId?: string;
  revision?: number;
  sha256: string;
  authorityDigest: string;
}>;

export type CloudConversionDestinationBinding = Readonly<{
  artifactInternalId?: string;
  revision?: number;
  namespaceId: string;
  pathDigest: string;
  authorityDigest: string;
}>;

export interface CloudConversionExecutionRequest {
  readonly execution: Readonly<{
    toolCallId: string;
    turnId: string;
    causalHumanUserId: string;
    roomId: string;
    agentId: string;
    taskId?: string;
    runId?: string;
    jobId?: string;
  }>;
  readonly source: CloudConversionSourceBinding;
  readonly destination: CloudConversionDestinationBinding;
  readonly inputFormat: string;
  readonly outputFormat: string;
  readonly bytes: Uint8Array;
  readonly maxOutputBytes: number;
  readonly signal?: AbortSignal;
}

export interface CloudConversionRecoveryRequest {
  readonly recoveryHandle: string;
  readonly causalHumanUserId: string;
  readonly destination: CloudConversionDestinationBinding;
  readonly maxOutputBytes: number;
  readonly signal?: AbortSignal;
}

export type CloudConversionExecutionResult =
  | Readonly<{
      status: "ready_to_publish";
      operationKey: string;
      recoveryHandle: string;
      outputFormat: string;
      bytes: Uint8Array;
      outputSha256: string;
    }>
  | Readonly<{
      status: "recover_publication";
      operationKey: string;
      recoveryHandle: string;
      outputFormat: string;
    }>
  | Readonly<{
      status: "published";
      operationKey: string;
      recoveryHandle: string;
      outputFormat: string;
      artifactId: string;
      revisionId: string;
    }>
  | Readonly<{
      status: "error";
      code: string;
      message: string;
      retryable: boolean;
      uncertainEffect: boolean;
      operationKey?: string;
      recoveryHandle?: string;
    }>;

export interface ConversionRuntime {
  execute(request: CloudConversionExecutionRequest): Promise<CloudConversionExecutionResult>;
  resume(request: CloudConversionRecoveryRequest): Promise<CloudConversionExecutionResult>;
  /** Called only after canonical Artifact recovery proves no committed receipt. */
  resumePublication(request: CloudConversionRecoveryRequest): Promise<CloudConversionExecutionResult>;
  confirmPublication(input: Readonly<{
    operationKey: string;
    artifactId: string;
    revisionId: string;
  }>): Promise<void>;
  failPublication(input: Readonly<{
    operationKey: string;
    failureCode: string;
  }>): Promise<void>;
  cancel(input: Readonly<{
    operationKey: string;
    causalHumanUserId: string;
    signal?: AbortSignal;
  }>): Promise<CloudConversionExecutionResult>;
}

let installedRuntime: ConversionRuntime | undefined;

export function installConversionRuntime(runtime: ConversionRuntime): void {
  installedRuntime = runtime;
}

export function uninstallConversionRuntime(): void {
  installedRuntime = undefined;
}

export function getConversionRuntime(): ConversionRuntime | undefined {
  return installedRuntime;
}
