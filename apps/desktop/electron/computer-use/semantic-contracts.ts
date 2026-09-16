export interface ComputerUseRuntimeIdentity {
  readonly instanceId: string;
  readonly humanUserId: string;
  readonly serverBindingId: string;
  readonly relayId: string;
  readonly pairingGeneration: string;
  readonly desktopSessionId: string;
}

export function sameComputerUseRuntimeIdentity(
  left: ComputerUseRuntimeIdentity | null,
  right: ComputerUseRuntimeIdentity,
): boolean {
  return left !== null
    && left.instanceId === right.instanceId
    && left.humanUserId === right.humanUserId
    && left.serverBindingId === right.serverBindingId
    && left.relayId === right.relayId
    && left.pairingGeneration === right.pairingGeneration
    && left.desktopSessionId === right.desktopSessionId;
}

/**
 * Builds one capability projection across an asynchronous local read, then
 * proves the Relay topology is still the exact topology that began the read.
 */
export async function buildForStableComputerUseRuntime<T>(input: {
  readonly initialRuntime: ComputerUseRuntimeIdentity;
  readonly build: () => Promise<T>;
  readonly currentRuntime: () => ComputerUseRuntimeIdentity | null;
}): Promise<{ readonly stable: true; readonly value: T } | { readonly stable: false }> {
  const value = await input.build();
  return sameComputerUseRuntimeIdentity(input.currentRuntime(), input.initialRuntime)
    ? { stable: true, value }
    : { stable: false };
}
