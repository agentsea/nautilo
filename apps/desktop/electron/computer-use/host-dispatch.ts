import type { ComputerUseHostContract, ComputerUseHostResult } from "@nautilo/computer-use-host-protocol";
import type { ComputerUseHostDispatchRequest, DesktopAutomationInvocationBinding } from "@nautilo/relay";
import { randomUUID } from "node:crypto";

/** Relay-to-Host forwarding shape. Desktop never interprets tool names/args. */
export interface ComputerUseHostInvocation {
  readonly binding: DesktopAutomationInvocationBinding;
  readonly computerUseRequest?: ComputerUseHostDispatchRequest;
  readonly toolName: string;
  readonly args: unknown;
  readonly signal?: AbortSignal;
}

export type ComputerUseHostDispatchResult =
  | Readonly<{
    readonly ok: true;
    readonly hostResult: ComputerUseHostResult;
    readonly contract: ComputerUseHostContract;
    readonly visionImage?: Readonly<{ mime: "image/png"; base64: string }>;
  }>
  | Readonly<{
    readonly ok: false;
    readonly hostFailure: "host_unavailable" | "host_protocol_rejected" | "host_cancelled" | "authority_mismatch";
  }>;

/** Capability publication only; execution is descriptor-driven Host IPC. */
export interface ComputerUseHostAvailability {
  readonly cua: boolean;
}
export interface ComputerUseHostRoute {
  readonly version: 1;
  readonly provider: "cua";
  readonly providerGeneration: string;
}
export class ComputerUseHostRouteAttestation {
  private current: Readonly<{ fingerprint: string; availability: ComputerUseHostAvailability | null; selection: ComputerUseHostRoute | null }> | null = null;
  constructor(private readonly observe: () => ComputerUseHostAvailability | Promise<ComputerUseHostAvailability>, private readonly changed?: () => void) {}
  clear(): void { this.current = null; }
  lastObservation(): Readonly<{ availability: ComputerUseHostAvailability | null; selection: ComputerUseHostRoute | null }> | null {
    return this.current === null ? null : { availability: this.current.availability, selection: this.current.selection };
  }
  async resolve(): Promise<ComputerUseHostRoute | null> {
    let observed: ComputerUseHostAvailability | null;
    try { observed = await this.observe(); } catch { observed = null; }
    return this.resolveWithAvailability(observed, true);
  }
  resolveWithAvailability(availability: ComputerUseHostAvailability | null, notify = false): ComputerUseHostRoute | null {
    const selection = availability?.cua !== true ? null : {
      version: 1 as const, provider: "cua" as const, providerGeneration: randomUUID(),
    };
    const fingerprint = JSON.stringify({ availability, selection: selection === null ? null : { ...selection, providerGeneration: undefined } });
    if (this.current?.fingerprint === fingerprint) return this.current.selection;
    const changed = this.current !== null;
    this.current = { fingerprint, availability, selection };
    if (changed && notify) this.changed?.();
    return selection;
  }
}
