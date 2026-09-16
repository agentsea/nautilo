import {
  authorizationRevision,
  type AccessRevision,
  type AuthorizationRevision,
  type CryptoDeviceId,
  type CryptoDomainId,
  type DomainEpoch,
  type HumanId,
  type LatticeCrypto,
  type NamespaceId,
  BACKGROUND_WORK_DESCRIPTOR_FORMAT_VERSION_V1,
  MAX_BACKGROUND_WORK_DESCRIPTOR_WIRE_BYTES_V1,
  PROCESSOR_SIGNER_AUTHORIZATION_FORMAT_VERSION_V1,
  STENOGRAPHER_BACKGROUND_MAX_OUTPUTS_V2,
  STENOGRAPHER_BACKGROUND_MAX_PLAINTEXT_BYTES_V2,
  STENOGRAPHER_BACKGROUND_MAX_TTL_MS_V2,
  backgroundWorkDescriptorDigestV1,
  createBackgroundAuthorizationResponseV1,
  createProcessorCredentialV1,
  createProcessorObjectSignerPublicV1,
  createProcessorSignerAuthorizationV1,
  decodeBackgroundWorkDescriptorV1,
  type BackgroundWorkDescriptorV1,
  type CreatedBackgroundAuthorizationResponseV1,
  type CreatedProcessorCredentialV1,
  type CreatedProcessorSignerAuthorizationV1,
  type ProcessorObjectSignerPublicV1,
} from "@nautilo/lattice-crypto/background";

/**
 * Product policy is deliberately stricter than the protocol's ten-minute
 * compatibility ceiling. A claimed transform may have less time remaining,
 * but a device never mints a credential whose original window is longer.
 */
export const BACKGROUND_AUTHORIZATION_DEVICE_CREDENTIAL_TTL_MS =
  STENOGRAPHER_BACKGROUND_MAX_TTL_MS_V2;

/**
 * One extraction emits at most five event operations; compaction emits one
 * rollup. The descriptor remains exact, so this is a ceiling rather than a
 * server-selected output allowance.
 */
export const BACKGROUND_AUTHORIZATION_DEVICE_MAX_OUTPUT_OBJECTS =
  STENOGRAPHER_BACKGROUND_MAX_OUTPUTS_V2;
export const BACKGROUND_AUTHORIZATION_DEVICE_MAX_INPUT_OBJECTS = 256;
export const BACKGROUND_AUTHORIZATION_DEVICE_MAX_PLAINTEXT_BYTES =
  STENOGRAPHER_BACKGROUND_MAX_PLAINTEXT_BYTES_V2;
export const BACKGROUND_AUTHORIZATION_DEVICE_MAX_CIPHERTEXT_BYTES =
  1_024 * 1_024 + 40;

export const BACKGROUND_AUTHORIZATION_DEVICE_REQUEST_FORMAT_VERSION =
  1 as const;
export const BACKGROUND_AUTHORIZATION_DEVICE_FULFILLMENT_FORMAT_VERSION =
  1 as const;

const HASH_BYTES = 32;

export interface BackgroundAuthorizationDeviceRequest {
  readonly formatVersion:
    typeof BACKGROUND_AUTHORIZATION_DEVICE_REQUEST_FORMAT_VERSION;
  readonly descriptorBytes: Uint8Array;
  readonly descriptorHash: Uint8Array;
}

export interface BackgroundAuthorizationDeviceAuthority {
  readonly humanId: HumanId;
  readonly humanState: "active" | "removed";
  readonly deviceId: CryptoDeviceId;
  readonly deviceHumanId: HumanId;
  readonly deviceState: "active" | "revoked";
  readonly deviceAuthorizationRevision: AuthorizationRevision;
  readonly deviceSigningPublicKey: Uint8Array;
  readonly deviceSigningPrivateKey: Uint8Array;
  readonly namespaceId: NamespaceId;
  readonly namespaceState: "active" | "deleted";
  readonly membershipHumanId: HumanId;
  readonly membershipState: "active" | "removed";
  readonly namespaceAccessRevision: AccessRevision;
  readonly policyRevision: AuthorizationRevision;
  readonly domainId: CryptoDomainId;
  readonly domainState: "active" | "retired";
  readonly domainEpoch: DomainEpoch;
  readonly processorKind: "stenographer";
  readonly processorVersion: 1;
  readonly processorState: "active" | "disabled";
  readonly processorAuthorizationRevision: AuthorizationRevision;
  readonly aiRoot: Uint8Array;
}

export interface BackgroundAuthorizationDeviceAuthorityContext {
  readonly purpose: "fulfill-current-processor-background-authorization";
  readonly requestId: string;
  readonly recipientGeneration: number;
  readonly descriptorHash: Uint8Array;
  readonly workKind: BackgroundWorkDescriptorV1["workKind"];
  readonly workId: string;
  readonly processorKind: "stenographer";
  readonly processorVersion: 1;
  readonly processorAuthorizationRevision: AuthorizationRevision;
  readonly namespaceId: NamespaceId;
  readonly domainId: CryptoDomainId;
  readonly expectedDomainEpoch: DomainEpoch;
  readonly expectedNamespaceAccessRevision: AccessRevision;
  readonly expectedPolicyRevision: AuthorizationRevision;
  readonly issuedAt: number;
  readonly notBefore: number;
  readonly expiresAt: number;
}

export type ResolveCurrentBackgroundAuthorizationDeviceAuthority = (
  context: BackgroundAuthorizationDeviceAuthorityContext,
) =>
  | BackgroundAuthorizationDeviceAuthority
  | null
  | Promise<BackgroundAuthorizationDeviceAuthority | null>;

export interface BackgroundAuthorizationDeviceFulfillment {
  readonly formatVersion:
    typeof BACKGROUND_AUTHORIZATION_DEVICE_FULFILLMENT_FORMAT_VERSION;
  readonly requestId: string;
  readonly recipientGeneration: number;
  readonly expiresAt: number;
  readonly responseBytes: Uint8Array;
  readonly responseHash: Uint8Array;
  readonly credentialHash: Uint8Array;
  readonly signerAuthorizationBytes: Uint8Array;
  readonly signerAuthorizationHash: Uint8Array;
}

export type BackgroundAuthorizationDeviceResponderErrorCode =
  | "malformed_request"
  | "unsupported_request"
  | "excessive_scope"
  | "not_yet_valid"
  | "expired"
  | "authority_unavailable"
  | "human_removed"
  | "device_revoked"
  | "namespace_unavailable"
  | "membership_removed"
  | "domain_unavailable"
  | "processor_unavailable"
  | "agent_unavailable"
  | "stale_authority";

export class BackgroundAuthorizationDeviceResponderError extends Error {
  override readonly name = "BackgroundAuthorizationDeviceResponderError";

  constructor(
    readonly code: BackgroundAuthorizationDeviceResponderErrorCode,
  ) {
    super(`Background authorization device response failed (${code})`);
  }
}

interface ParsedDeviceRequest {
  readonly descriptor: BackgroundWorkDescriptorV1;
  readonly descriptorBytes: Uint8Array;
  readonly descriptorHash: Uint8Array;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

function exactBytes(
  value: unknown,
  length: number,
): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== length) {
    throw new BackgroundAuthorizationDeviceResponderError(
      "malformed_request",
    );
  }
  return Uint8Array.from(value);
}

function exactAuthorityBytes(
  value: unknown,
  length: number,
): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== length) {
    throw new BackgroundAuthorizationDeviceResponderError(
      "authority_unavailable",
    );
  }
  return Uint8Array.from(value);
}

function assertExactObjectFields(
  value: unknown,
  fields: readonly string[],
): asserts value is Record<string, unknown> {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
  ) {
    throw new BackgroundAuthorizationDeviceResponderError(
      "malformed_request",
    );
  }
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (
    actual.length !== expected.length
    || actual.some((field, index) => field !== expected[index])
  ) {
    throw new BackgroundAuthorizationDeviceResponderError(
      "malformed_request",
    );
  }
}

function destroyDescriptor(descriptor: BackgroundWorkDescriptorV1): void {
  descriptor.recipientPublicKey.fill(0);
  descriptor.source.fingerprint.fill(0);
}

function parseRequest(
  crypto: LatticeCrypto,
  value: unknown,
): ParsedDeviceRequest {
  assertExactObjectFields(value, [
    "formatVersion",
    "descriptorBytes",
    "descriptorHash",
  ]);
  if (
    value["formatVersion"]
      !== BACKGROUND_AUTHORIZATION_DEVICE_REQUEST_FORMAT_VERSION
    || !(value["descriptorBytes"] instanceof Uint8Array)
    || value["descriptorBytes"].length < 1
    || value["descriptorBytes"].length
      > MAX_BACKGROUND_WORK_DESCRIPTOR_WIRE_BYTES_V1
  ) {
    throw new BackgroundAuthorizationDeviceResponderError(
      "malformed_request",
    );
  }
  const descriptorBytes = Uint8Array.from(value["descriptorBytes"]);
  let descriptorHash: Uint8Array | undefined;
  let descriptor: BackgroundWorkDescriptorV1 | undefined;
  try {
    descriptorHash = exactBytes(value["descriptorHash"], HASH_BYTES);
    descriptor = decodeBackgroundWorkDescriptorV1(descriptorBytes);
    const canonicalHash =
      backgroundWorkDescriptorDigestV1(crypto, descriptor);
    try {
      if (!equalBytes(descriptorHash, canonicalHash)) {
        throw new BackgroundAuthorizationDeviceResponderError(
          "malformed_request",
        );
      }
    } finally {
      canonicalHash.fill(0);
    }
    const parsed = {
      descriptor,
      descriptorBytes,
      descriptorHash,
    };
    descriptor = undefined;
    descriptorHash = undefined;
    return parsed;
  } catch (error) {
    if (error instanceof BackgroundAuthorizationDeviceResponderError) {
      throw error;
    }
    throw new BackgroundAuthorizationDeviceResponderError(
      "malformed_request",
    );
  } finally {
    if (descriptor !== undefined) destroyDescriptor(descriptor);
    descriptorHash?.fill(0);
    if (descriptor !== undefined || descriptorHash !== undefined) {
      descriptorBytes.fill(0);
    }
  }
}

function assertSupportedAndBounded(
  descriptor: BackgroundWorkDescriptorV1,
  now: number,
): void {
  if (
    descriptor.formatVersion
      !== BACKGROUND_WORK_DESCRIPTOR_FORMAT_VERSION_V1
    || descriptor.subject.kind !== "processor"
    || descriptor.subject.processorKind !== "stenographer"
    || descriptor.subject.processorVersion !== 1
    || !descriptor.workKind.startsWith("stenographer.")
  ) {
    throw new BackgroundAuthorizationDeviceResponderError(
      "unsupported_request",
    );
  }
  if (
    descriptor.maximumInputObjectCount
      > BACKGROUND_AUTHORIZATION_DEVICE_MAX_INPUT_OBJECTS
    || descriptor.maximumOutputObjectCount
      > BACKGROUND_AUTHORIZATION_DEVICE_MAX_OUTPUT_OBJECTS
    || descriptor.maximumPlaintextBytes
      > BACKGROUND_AUTHORIZATION_DEVICE_MAX_PLAINTEXT_BYTES
    || descriptor.maximumCiphertextBytes
      > BACKGROUND_AUTHORIZATION_DEVICE_MAX_CIPHERTEXT_BYTES
    || descriptor.expiresAt - descriptor.issuedAt
      > BACKGROUND_AUTHORIZATION_DEVICE_CREDENTIAL_TTL_MS
  ) {
    throw new BackgroundAuthorizationDeviceResponderError(
      "excessive_scope",
    );
  }
  if (now < descriptor.notBefore) {
    throw new BackgroundAuthorizationDeviceResponderError(
      "not_yet_valid",
    );
  }
  if (now >= descriptor.expiresAt) {
    throw new BackgroundAuthorizationDeviceResponderError("expired");
  }
}

function assertCurrentAuthority(
  descriptor: BackgroundWorkDescriptorV1,
  authority: BackgroundAuthorizationDeviceAuthority,
): void {
  if (descriptor.subject.kind !== "processor") {
    throw new BackgroundAuthorizationDeviceResponderError(
      "unsupported_request",
    );
  }
  if (authority.humanState !== "active") {
    throw new BackgroundAuthorizationDeviceResponderError("human_removed");
  }
  if (authority.deviceState !== "active") {
    throw new BackgroundAuthorizationDeviceResponderError("device_revoked");
  }
  if (authority.namespaceState !== "active") {
    throw new BackgroundAuthorizationDeviceResponderError(
      "namespace_unavailable",
    );
  }
  if (authority.membershipState !== "active") {
    throw new BackgroundAuthorizationDeviceResponderError(
      "membership_removed",
    );
  }
  if (authority.domainState !== "active") {
    throw new BackgroundAuthorizationDeviceResponderError(
      "domain_unavailable",
    );
  }
  if (authority.processorState !== "active") {
    throw new BackgroundAuthorizationDeviceResponderError(
      "processor_unavailable",
    );
  }
  if (
    authority.deviceHumanId !== authority.humanId
    || authority.membershipHumanId !== authority.humanId
    || authority.namespaceId !== descriptor.namespaceId
    || authority.domainId !== descriptor.domainId
    || authority.domainEpoch !== descriptor.expectedDomainEpoch
    || authority.namespaceAccessRevision
      !== descriptor.expectedNamespaceAccessRevision
    || authority.policyRevision !== descriptor.expectedPolicyRevision
    || authority.processorKind !== descriptor.subject.processorKind
    || authority.processorVersion !== descriptor.subject.processorVersion
    || authority.processorAuthorizationRevision
      !== descriptor.subject.authorizationRevision
  ) {
    throw new BackgroundAuthorizationDeviceResponderError(
      "stale_authority",
    );
  }
}

function hex(bytes: Uint8Array): string {
  return Array.from(
    bytes,
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

function destroyCredential(
  created: CreatedProcessorCredentialV1 | undefined,
): void {
  if (created === undefined) return;
  created.credential.workDescriptorBytes.fill(0);
  created.credential.workDescriptorHash.fill(0);
  created.credential.issuerSigningPublicKeyHash.fill(0);
  created.credential.signer.workDescriptorHash.fill(0);
  created.credential.signerPublicKey.fill(0);
  created.credential.encryptedSecret.fill(0);
  created.credential.signature.fill(0);
  created.bytes.fill(0);
  created.hash.fill(0);
}

function destroySignerAuthorization(
  created: CreatedProcessorSignerAuthorizationV1 | undefined,
): void {
  if (created === undefined) return;
  created.authorization.issuerSigningPublicKeyHash.fill(0);
  created.authorization.signer.workDescriptorHash.fill(0);
  created.authorization.signerPublicKey.fill(0);
  created.authorization.workDescriptorHash.fill(0);
  created.authorization.credentialHash.fill(0);
  created.authorization.signature.fill(0);
  created.bytes.fill(0);
  created.hash.fill(0);
}

function destroyResponse(
  created: CreatedBackgroundAuthorizationResponseV1 | undefined,
): void {
  if (created === undefined) return;
  created.response.recipientPublicKey.fill(0);
  created.response.credentialBytes.fill(0);
  created.response.credentialHash.fill(0);
  created.response.issuerSigningPublicKeyHash.fill(0);
  created.response.workDescriptorHash.fill(0);
  created.response.signature.fill(0);
  created.bytes.fill(0);
  created.hash.fill(0);
}

function destroySignerIdentity(
  identity: ProcessorObjectSignerPublicV1 | undefined,
): void {
  if (identity === undefined) return;
  identity.principal.workDescriptorHash.fill(0);
  identity.publicKey.fill(0);
}

/**
 * Pure, browser-safe device fulfillment. Transport, persistence, response
 * races, and request state transitions are injected or handled by callers.
 * The return value contains only public evidence and a recipient-encrypted
 * credential; the AI root and both private signing keys never leave this call.
 */
export async function fulfillProcessorBackgroundAuthorizationRequest(
  input: Readonly<{
    readonly crypto: LatticeCrypto;
    readonly request: unknown;
    readonly resolveCurrentAuthority:
      ResolveCurrentBackgroundAuthorizationDeviceAuthority;
  }>,
): Promise<BackgroundAuthorizationDeviceFulfillment> {
  if (
    typeof input.crypto !== "object"
    || input.crypto === null
    || typeof input.resolveCurrentAuthority !== "function"
  ) {
    throw new BackgroundAuthorizationDeviceResponderError(
      "malformed_request",
    );
  }
  const parsed = parseRequest(input.crypto, input.request);
  const { descriptor } = parsed;
  let contextHash: Uint8Array | undefined;
  let signerPrivateKey: Uint8Array | undefined;
  let signerPublicKey: Uint8Array | undefined;
  let issuerPublicKey: Uint8Array | undefined;
  let issuerPrivateKey: Uint8Array | undefined;
  let aiRoot: Uint8Array | undefined;
  let signerIdentity: ProcessorObjectSignerPublicV1 | undefined;
  let credential: CreatedProcessorCredentialV1 | undefined;
  let signerAuthorization:
    | CreatedProcessorSignerAuthorizationV1
    | undefined;
  let response: CreatedBackgroundAuthorizationResponseV1 | undefined;
  try {
    const now = input.crypto.clock.now();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new BackgroundAuthorizationDeviceResponderError(
        "malformed_request",
      );
    }
    assertSupportedAndBounded(descriptor, now);
    if (descriptor.subject.kind !== "processor") {
      throw new BackgroundAuthorizationDeviceResponderError(
        "unsupported_request",
      );
    }
    contextHash = Uint8Array.from(parsed.descriptorHash);
    let authority: BackgroundAuthorizationDeviceAuthority | null;
    try {
      authority = await input.resolveCurrentAuthority(Object.freeze({
        purpose: "fulfill-current-processor-background-authorization",
        requestId: descriptor.requestId,
        recipientGeneration: descriptor.recipientGeneration,
        descriptorHash: contextHash,
        workKind: descriptor.workKind,
        workId: descriptor.workId,
        processorKind: descriptor.subject.processorKind,
        processorVersion: descriptor.subject.processorVersion,
        processorAuthorizationRevision:
          descriptor.subject.authorizationRevision,
        namespaceId: descriptor.namespaceId,
        domainId: descriptor.domainId,
        expectedDomainEpoch: descriptor.expectedDomainEpoch,
        expectedNamespaceAccessRevision:
          descriptor.expectedNamespaceAccessRevision,
        expectedPolicyRevision: descriptor.expectedPolicyRevision,
        issuedAt: descriptor.issuedAt,
        notBefore: descriptor.notBefore,
        expiresAt: descriptor.expiresAt,
      }));
    } catch {
      throw new BackgroundAuthorizationDeviceResponderError(
        "authority_unavailable",
      );
    }
    if (authority === null) {
      throw new BackgroundAuthorizationDeviceResponderError(
        "authority_unavailable",
      );
    }
    assertCurrentAuthority(descriptor, authority);

    issuerPublicKey = exactAuthorityBytes(
      authority.deviceSigningPublicKey,
      32,
    );
    issuerPrivateKey = exactAuthorityBytes(
      authority.deviceSigningPrivateKey,
      32,
    );
    aiRoot = exactAuthorityBytes(authority.aiRoot, 32);
    const signer = input.crypto.generateSigningKeyPair();
    signerPrivateKey = signer.privateKey;
    signerPublicKey = signer.publicKey;
    const digestId = hex(parsed.descriptorHash);
    const signerAuthorizationId =
      `processor-signer-authorization-${digestId}`;
    signerIdentity = createProcessorObjectSignerPublicV1(input.crypto, {
      processorKind: "stenographer",
      processorVersion: 1,
      signerAuthorizationId,
      workDescriptorHash: parsed.descriptorHash,
      signerPrivateKey,
    });
    credential = await createProcessorCredentialV1(input.crypto, {
      id: `processor-credential-${digestId}`,
      workDescriptor: descriptor,
      issuingHumanId: authority.humanId,
      issuingDeviceId: authority.deviceId,
      issuingDeviceAuthorizationRevision: authorizationRevision(
        authority.deviceAuthorizationRevision,
      ),
      issuingDeviceSigningPublicKey: issuerPublicKey,
      issuingDeviceSigningPrivateKey: issuerPrivateKey,
      signer: signerIdentity.principal,
      signerPublicKey: signerIdentity.publicKey,
      signerPrivateKey,
      aiRoot,
    });
    signerAuthorization = createProcessorSignerAuthorizationV1(
      input.crypto,
      {
        formatVersion:
          PROCESSOR_SIGNER_AUTHORIZATION_FORMAT_VERSION_V1,
        id: signerAuthorizationId,
        processorKind: "stenographer",
        processorVersion: 1,
        workId: descriptor.workId,
        namespaceId: descriptor.namespaceId,
        domainId: descriptor.domainId,
        domainEpoch: descriptor.expectedDomainEpoch,
        namespaceAccessRevision:
          descriptor.expectedNamespaceAccessRevision,
        policyRevision: descriptor.expectedPolicyRevision,
        processorAuthorizationRevision: authorizationRevision(
          authority.processorAuthorizationRevision,
        ),
        issuingHumanId: authority.humanId,
        issuingDeviceId: authority.deviceId,
        issuingDeviceAuthorizationRevision: authorizationRevision(
          authority.deviceAuthorizationRevision,
        ),
        issuerSigningPublicKeyHash: input.crypto.hash(issuerPublicKey),
        signer: signerIdentity.principal,
        signerPublicKey: signerIdentity.publicKey,
        workDescriptorHash: parsed.descriptorHash,
        credentialHash: credential.hash,
        outputObjectIds: descriptor.outputObjectIds,
        maxOutputObjects: descriptor.maximumOutputObjectCount,
        maxOutputPlaintextBytes: descriptor.maximumPlaintextBytes,
        maxOutputCiphertextBytes: descriptor.maximumCiphertextBytes,
        issuedAt: descriptor.issuedAt,
        expiresAt: descriptor.expiresAt,
      },
      issuerPrivateKey,
    );
    response = createBackgroundAuthorizationResponseV1(input.crypto, {
      credentialBytes: credential.bytes,
      issuingDeviceSigningPublicKey: issuerPublicKey,
      issuingDeviceSigningPrivateKey: issuerPrivateKey,
    });
    return Object.freeze({
      formatVersion:
        BACKGROUND_AUTHORIZATION_DEVICE_FULFILLMENT_FORMAT_VERSION,
      requestId: descriptor.requestId,
      recipientGeneration: descriptor.recipientGeneration,
      expiresAt: descriptor.expiresAt,
      responseBytes: Uint8Array.from(response.bytes),
      responseHash: Uint8Array.from(response.hash),
      credentialHash: Uint8Array.from(credential.hash),
      signerAuthorizationBytes:
        Uint8Array.from(signerAuthorization.bytes),
      signerAuthorizationHash:
        Uint8Array.from(signerAuthorization.hash),
    });
  } catch (error) {
    if (error instanceof BackgroundAuthorizationDeviceResponderError) {
      throw error;
    }
    throw new BackgroundAuthorizationDeviceResponderError(
      "authority_unavailable",
    );
  } finally {
    destroyResponse(response);
    destroySignerAuthorization(signerAuthorization);
    destroyCredential(credential);
    destroySignerIdentity(signerIdentity);
    signerPrivateKey?.fill(0);
    signerPublicKey?.fill(0);
    issuerPublicKey?.fill(0);
    issuerPrivateKey?.fill(0);
    aiRoot?.fill(0);
    contextHash?.fill(0);
    destroyDescriptor(descriptor);
    parsed.descriptorBytes.fill(0);
    parsed.descriptorHash.fill(0);
  }
}
