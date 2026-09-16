/**
 * Browser projection of native push-binding custody.
 *
 * Mobile Web v1 never creates installation identity, push bindings, or revoke
 * proofs. The settings route may still read this module while presenting the
 * unavailable capability, so its only browser operation fails closed without
 * importing Crypto or SecureStore.
 */
export interface PushBinding {
  readonly bindingId: string;
}

export function loadPushBinding(_serverId: string): Promise<PushBinding | null> {
  return Promise.resolve(null);
}
