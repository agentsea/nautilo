import type {
  AgentRuntimeAtomicStorageStateV2,
} from "../storage/v2-records.ts";
import {
  cloneOpaqueBytes,
  copyOwnedBytesV2,
  type OpaqueByteKind,
  type OpaqueBytes,
} from "../v2-types/opaque.ts";
import type {
  AgentRuntimeInitializationCasAuthorizationV2,
} from "./storage-coordinator.ts";
import {
  assertAgentRuntimeStorageOpaqueFields,
} from "./storage-opaque-fields.ts";
import {
  decodeAgentRuntimeSignerPublicationV1,
  encodeAgentRuntimeSignerPublicationV1,
  type AgentRuntimeSignerPublicationV1,
} from "./signer-publication-v1.ts";

declare const authorizedAgentRuntimeInitializationWriteBrand: unique symbol;

/** One-shot proof that a complete gen0 Runtime write passed fresh authority. */
export type AuthorizedAgentRuntimeInitializationWriteV2 = Readonly<{
  readonly state: AgentRuntimeAtomicStorageStateV2;
  readonly authorization: AgentRuntimeInitializationCasAuthorizationV2;
  readonly signerPublication: AgentRuntimeSignerPublicationV1;
  readonly [authorizedAgentRuntimeInitializationWriteBrand]: true;
}>;

interface AuthorizedAgentRuntimeInitializationSnapshotV2 {
  readonly state: AgentRuntimeAtomicStorageStateV2;
  readonly authorization: AgentRuntimeInitializationCasAuthorizationV2;
  readonly signerPublication: AgentRuntimeSignerPublicationV1;
  readonly fingerprint: string;
}

const authorizedAgentRuntimeInitializationWrites = new WeakMap<
  object,
  AuthorizedAgentRuntimeInitializationSnapshotV2
>();

function plain(value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return ["bytes", ...value];
  }
  if (Array.isArray(value)) return value.map(plain);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [
      key,
      plain((value as Record<string, unknown>)[key]),
    ]),
  );
}

function fingerprint(value: unknown): string {
  const encoded = JSON.stringify(plain(value));
  if (encoded === undefined) {
    throw new TypeError(
      "Agent Runtime initialization write cannot be fingerprinted",
    );
  }
  return encoded;
}

function cloneValue<T>(value: T): T {
  if (value instanceof Uint8Array) return copyOwnedBytesV2(value) as T;
  if (Array.isArray(value)) {
    const entries = value as readonly unknown[];
    return entries.map((entry) => cloneValue<unknown>(entry)) as T;
  }
  if (typeof value !== "object" || value === null) return value;
  const candidate = value as Record<string, unknown>;
  if (
    candidate["classification"] === "opaque-ciphertext"
    && typeof candidate["kind"] === "string"
    && candidate["ciphertext"] instanceof Uint8Array
  ) {
    return cloneOpaqueBytes(
      value as unknown as OpaqueBytes<OpaqueByteKind>,
    ) as T;
  }
  return Object.fromEntries(
    Object.entries(candidate).map(([key, child]) => [
      key,
      cloneValue(child),
    ]),
  ) as T;
}

function cloneInitializationWrite(
  input: Readonly<{
    readonly state: AgentRuntimeAtomicStorageStateV2;
    readonly authorization: AgentRuntimeInitializationCasAuthorizationV2;
    readonly signerPublication: AgentRuntimeSignerPublicationV1;
  }>,
): Readonly<{
  readonly state: AgentRuntimeAtomicStorageStateV2;
  readonly authorization: AgentRuntimeInitializationCasAuthorizationV2;
  readonly signerPublication: AgentRuntimeSignerPublicationV1;
}> {
  return Object.freeze({
    state: cloneValue(input.state),
    authorization: cloneValue(input.authorization),
    signerPublication: decodeAgentRuntimeSignerPublicationV1(
      encodeAgentRuntimeSignerPublicationV1(input.signerPublication),
    ),
  });
}

/** Internal mint; the production caller is the initializer coordinator only. */
export function authorizeAgentRuntimeInitializationWriteV2(
  input: Readonly<{
    readonly state: AgentRuntimeAtomicStorageStateV2;
    readonly authorization: AgentRuntimeInitializationCasAuthorizationV2;
    readonly signerPublication: AgentRuntimeSignerPublicationV1;
  }>,
): AuthorizedAgentRuntimeInitializationWriteV2 {
  if (typeof input.state !== "object" || input.state === null) {
    throw new TypeError("Agent Runtime atomic state must be an object");
  }
  assertAgentRuntimeStorageOpaqueFields(input.state);
  const expectedDomains = input.authorization.context.expectedDomains;
  if (
    Array.isArray(input.state.domainEnvelopes as unknown)
    && (
      fingerprint(input.state.runtime)
        !== fingerprint(input.authorization.context.expectedState)
      || fingerprint(input.authorization.currentManager)
        !== fingerprint(input.authorization.context.expectedManager)
      || fingerprint(input.authorization.currentManager)
        !== fingerprint({
          managerHumanId: input.signerPublication.managerHumanId,
          managerAuthorizationRevision:
            input.signerPublication.managerAuthorizationRevision,
          managerDeviceId: input.signerPublication.managerDeviceId,
        })
      || fingerprint(input.state.configInventory)
        !== fingerprint(input.authorization.context.configInventory)
      || expectedDomains.length !== input.state.domainEnvelopes.length
      || expectedDomains.length
        !== input.authorization.authorizedDomains.length
      || expectedDomains.some((domain, index) =>
        fingerprint(domain)
          !== fingerprint({
            domainId: input.state.domainEnvelopes[index]!.domainId,
            domainEpoch: input.state.domainEnvelopes[index]!.domainEpoch,
            agentAuthorizationRevision:
              input.state.domainEnvelopes[index]!.agentAuthorizationRevision,
            committerDeviceId:
              input.state.domainEnvelopes[index]!.committerDeviceId,
          })
        || fingerprint(domain)
          !== fingerprint({
            domainId:
              input.authorization.authorizedDomains[index]!.domainId,
            domainEpoch:
              input.authorization.authorizedDomains[index]!.domainEpoch,
            agentAuthorizationRevision:
              input.authorization.authorizedDomains[index]!
                .agentAuthorizationRevision,
            committerDeviceId:
              input.authorization.authorizedDomains[index]!.committerDeviceId,
          })
      )
    )
  ) {
    throw new TypeError(
      "Agent Runtime initialization authorization does not match its write set",
    );
  }
  const privateSnapshot = cloneInitializationWrite(input);
  const authorized = Object.freeze(
    cloneInitializationWrite(privateSnapshot),
  ) as AuthorizedAgentRuntimeInitializationWriteV2;
  authorizedAgentRuntimeInitializationWrites.set(authorized, Object.freeze({
    ...privateSnapshot,
    fingerprint: fingerprint(authorized),
  }));
  return authorized;
}

export function consumeAuthorizedAgentRuntimeInitializationWriteV2(
  value: AuthorizedAgentRuntimeInitializationWriteV2,
): Readonly<{
  readonly state: AgentRuntimeAtomicStorageStateV2;
  readonly authorization: AgentRuntimeInitializationCasAuthorizationV2;
  readonly signerPublication: AgentRuntimeSignerPublicationV1;
}> {
  const capability = typeof value === "object" && value !== null
    ? value as object
    : null;
  const snapshot =
    capability === null
      ? undefined
      : authorizedAgentRuntimeInitializationWrites.get(capability);
  if (capability !== null) {
    authorizedAgentRuntimeInitializationWrites.delete(capability);
  }
  if (
    snapshot === undefined
    || typeof value !== "object"
    || value === null
    || Object.keys(value).length !== 3
    || !Object.hasOwn(value, "state")
    || !Object.hasOwn(value, "authorization")
    || !Object.hasOwn(value, "signerPublication")
    || fingerprint(value) !== snapshot.fingerprint
  ) {
    throw new TypeError(
      "Agent Runtime initialization requires an authorized write capability",
    );
  }
  return Object.freeze(cloneInitializationWrite(snapshot));
}
