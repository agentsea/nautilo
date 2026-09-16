import type { LatticeCrypto } from "@nautilo/lattice-crypto";
import {
  verifyCurrentAgentBackgroundGrantResponseV1,
  verifyCurrentBackgroundAuthorizationResponseV1,
  verifyCurrentProcessorSignerAuthorizationForCredentialV1,
  decodeProcessorSignerAuthorizationV1,
  type AgentBackgroundGrantIssuerContextV1,
  type BackgroundAuthorizationResponseIssuerContextV1,
  type ProcessorCredentialIssuerAuthorityContextV1,
  type ProcessorSignerAuthorizationAuthorityContextV1,
  type VerifiedAgentBackgroundGrantResponseV1,
  type VerifiedBackgroundAuthorizationResponseV1,
  type VerifiedProcessorSignerAuthorizationForCredentialV1,
} from "@nautilo/lattice-crypto/wire";
import {
  BACKGROUND_AUTHORIZATION_DEVICE_CREDENTIAL_TTL_MS,
} from "./background-authorization-responder.ts";

export interface ExpectedBackgroundAuthorizationResponseBase {
  readonly requestId: string;
  readonly recipientGeneration: number;
  readonly descriptorHash: Uint8Array;
  readonly recipientKeyId: string;
  readonly recipientPublicKey: Uint8Array;
}

export interface ExpectedProcessorBackgroundAuthorizationResponse
  extends ExpectedBackgroundAuthorizationResponseBase {
  readonly kind: "processor";
}

export interface ExpectedAgentBackgroundAuthorizationResponse
  extends ExpectedBackgroundAuthorizationResponseBase {
  readonly kind: "agent";
}

export type ExpectedBackgroundAuthorizationResponse =
  | ExpectedProcessorBackgroundAuthorizationResponse
  | ExpectedAgentBackgroundAuthorizationResponse;

export type BackgroundAuthorizationCurrentIssuerContext =
  | Readonly<{
    kind: "processor";
    source: "response";
    context: BackgroundAuthorizationResponseIssuerContextV1;
  }>
  | Readonly<{
    kind: "processor";
    source: "credential";
    context: ProcessorCredentialIssuerAuthorityContextV1;
  }>
  | Readonly<{
    kind: "processor";
    source: "signer_authorization";
    context: ProcessorSignerAuthorizationAuthorityContextV1;
  }>
  | Readonly<{
    kind: "agent";
    source: "response";
    context: AgentBackgroundGrantIssuerContextV1;
  }>;

export type ResolveCurrentBackgroundAuthorizationIssuingDevicePublicKey = (
  context: BackgroundAuthorizationCurrentIssuerContext,
) => Uint8Array | null | Promise<Uint8Array | null>;

interface VerifyCurrentBackgroundAuthorizationDeviceResponseBase {
  readonly crypto: LatticeCrypto;
  readonly responseBytes: Uint8Array;
  readonly now: number;
  readonly resolveCurrentIssuingDevicePublicKey:
    ResolveCurrentBackgroundAuthorizationIssuingDevicePublicKey;
}

export interface VerifyCurrentProcessorBackgroundAuthorizationDeviceResponseInput
  extends VerifyCurrentBackgroundAuthorizationDeviceResponseBase {
  readonly expected: ExpectedProcessorBackgroundAuthorizationResponse;
  readonly signerAuthorizationBytes: Uint8Array;
}

export interface VerifyCurrentAgentBackgroundAuthorizationDeviceResponseInput
  extends VerifyCurrentBackgroundAuthorizationDeviceResponseBase {
  readonly expected: ExpectedAgentBackgroundAuthorizationResponse;
  readonly signerAuthorizationBytes?: never;
}

export type VerifyCurrentBackgroundAuthorizationDeviceResponseInput =
  | VerifyCurrentProcessorBackgroundAuthorizationDeviceResponseInput
  | VerifyCurrentAgentBackgroundAuthorizationDeviceResponseInput;

export interface VerifiedBackgroundAuthorizationDeviceResponseBase {
  readonly requestId: string;
  readonly recipientGeneration: number;
  readonly recipientKeyId: string;
  readonly recipientPublicKey: Uint8Array;
  readonly descriptorHash: Uint8Array;
  readonly workId: string;
  readonly workKind: string;
  readonly purpose: string;
  readonly responseHash: Uint8Array;
  readonly responseBytes: Uint8Array;
  readonly credentialId: string;
  readonly credentialHash: Uint8Array;
  readonly issuingHumanId: string;
  readonly issuingDeviceId: string;
  readonly issuingDeviceAuthorizationRevision: number;
  readonly issuerSigningPublicKeyHash: Uint8Array;
  readonly namespaceId: string;
  readonly domainId: string;
  readonly domainEpoch: number;
  readonly namespaceAccessRevision: number;
  readonly policyRevision: number;
  readonly issuedAt: number;
  readonly notBefore: number;
  readonly expiresAt: number;
}

export interface VerifiedProcessorSignerAuthorizationEvidence {
  readonly authorizationId: string;
  readonly processorKind: "stenographer";
  readonly processorVersion: 1;
  readonly workId: string;
  readonly namespaceId: string;
  readonly domainId: string;
  readonly domainEpoch: number;
  readonly namespaceAccessRevision: number;
  readonly policyRevision: number;
  readonly processorAuthorizationRevision: number;
  readonly issuingHumanId: string;
  readonly issuingDeviceId: string;
  readonly issuingDeviceAuthorizationRevision: number;
  readonly issuerSigningPublicKeyHash: Uint8Array;
  readonly signerKeyId: string;
  readonly signerPublicKey: Uint8Array;
  readonly authorizationHash: Uint8Array;
  readonly credentialHash: Uint8Array;
  readonly authorizationBytes: Uint8Array;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export interface VerifiedProcessorBackgroundAuthorizationDeviceResponse
  extends VerifiedBackgroundAuthorizationDeviceResponseBase {
  readonly kind: "processor";
  readonly subject: Readonly<{
    readonly kind: "processor";
    readonly processorKind: "stenographer";
    readonly processorVersion: 1;
    readonly authorizationRevision: number;
  }>;
  readonly signerAuthorization:
    VerifiedProcessorSignerAuthorizationEvidence;
}

export interface VerifiedAgentBackgroundAuthorizationDeviceResponse
  extends VerifiedBackgroundAuthorizationDeviceResponseBase {
  readonly kind: "agent";
  readonly subject: Readonly<{
    readonly kind: "agent";
    readonly agentId: string;
    readonly runtimeGeneration: number;
    readonly authorizationRevision: number;
  }>;
}

export type VerifiedBackgroundAuthorizationDeviceResponse =
  | VerifiedProcessorBackgroundAuthorizationDeviceResponse
  | VerifiedAgentBackgroundAuthorizationDeviceResponse;

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

function assertExactDurableRequest(
  expected: ExpectedBackgroundAuthorizationResponse,
  actual: Readonly<{
    requestId: string;
    recipientGeneration: number;
    descriptorHash: Uint8Array;
    recipientKeyId: string;
    recipientPublicKey: Uint8Array;
  }>,
): void {
  if (
    actual.requestId !== expected.requestId
    || actual.recipientGeneration !== expected.recipientGeneration
    || actual.recipientKeyId !== expected.recipientKeyId
    || !equalBytes(actual.descriptorHash, expected.descriptorHash)
    || !equalBytes(
      actual.recipientPublicKey,
      expected.recipientPublicKey,
    )
  ) {
    throw new TypeError(
      "Background authorization response does not match durable request",
    );
  }
}

function assertProductCredentialLifetime(
  issuedAt: number,
  expiresAt: number,
): void {
  if (
    expiresAt <= issuedAt
    || expiresAt - issuedAt
      > BACKGROUND_AUTHORIZATION_DEVICE_CREDENTIAL_TTL_MS
  ) {
    throw new TypeError(
      "Background authorization response exceeds product lifetime",
    );
  }
}

function destroyProcessorResponse(
  verified: VerifiedBackgroundAuthorizationResponseV1,
): void {
  verified.response.workDescriptorHash.fill(0);
  verified.response.recipientPublicKey.fill(0);
  verified.response.credentialBytes.fill(0);
  verified.response.credentialHash.fill(0);
  verified.response.issuerSigningPublicKeyHash.fill(0);
  verified.response.signature.fill(0);
  verified.responseBytes.fill(0);
  verified.responseHash.fill(0);
  verified.credential.workDescriptorBytes.fill(0);
  verified.credential.workDescriptorHash.fill(0);
  verified.credential.issuerSigningPublicKeyHash.fill(0);
  verified.credential.signer.workDescriptorHash.fill(0);
  verified.credential.signerPublicKey.fill(0);
  verified.credential.encryptedSecret.fill(0);
  verified.credential.signature.fill(0);
  verified.credentialHash.fill(0);
  verified.workDescriptor.recipientPublicKey.fill(0);
  verified.workDescriptor.source.fingerprint.fill(0);
}

function destroyProcessorSignerEvidence(
  verified: VerifiedProcessorSignerAuthorizationForCredentialV1,
): void {
  const authorization = verified.signerAuthorization;
  authorization.authorization.issuerSigningPublicKeyHash.fill(0);
  authorization.authorization.signer.workDescriptorHash.fill(0);
  authorization.authorization.signerPublicKey.fill(0);
  authorization.authorization.workDescriptorHash.fill(0);
  authorization.authorization.credentialHash.fill(0);
  authorization.authorization.signature.fill(0);
  authorization.authorizationBytes.fill(0);
  authorization.authorizationHash.fill(0);
  verified.credential.credential.workDescriptorBytes.fill(0);
  verified.credential.credential.workDescriptorHash.fill(0);
  verified.credential.credential.issuerSigningPublicKeyHash.fill(0);
  verified.credential.credential.signer.workDescriptorHash.fill(0);
  verified.credential.credential.signerPublicKey.fill(0);
  verified.credential.credential.encryptedSecret.fill(0);
  verified.credential.credential.signature.fill(0);
  verified.credential.credentialBytes.fill(0);
  verified.credential.credentialHash.fill(0);
  verified.credential.workDescriptor.recipientPublicKey.fill(0);
  verified.credential.workDescriptor.source.fingerprint.fill(0);
}

function destroyAgentResponse(
  verified: VerifiedAgentBackgroundGrantResponseV1,
): void {
  verified.response.workDescriptorBytes.fill(0);
  verified.response.workDescriptorHash.fill(0);
  verified.response.grantBytes.fill(0);
  verified.response.grantHash.fill(0);
  verified.response.issuerSigningPublicKeyHash.fill(0);
  verified.response.signature.fill(0);
  verified.responseBytes.fill(0);
  verified.responseHash.fill(0);
  verified.workDescriptor.recipientPublicKey.fill(0);
  verified.workDescriptor.source.fingerprint.fill(0);
  verified.grant.encryptedSecret.fill(0);
  verified.grant.signature.fill(0);
  verified.grantBytes.fill(0);
}

async function verifyProcessor(
  input: VerifyCurrentProcessorBackgroundAuthorizationDeviceResponseInput,
): Promise<VerifiedProcessorBackgroundAuthorizationDeviceResponse> {
  const verified = await verifyCurrentBackgroundAuthorizationResponseV1(
    input.crypto,
    {
      responseBytes: input.responseBytes,
      now: input.now,
      resolveCurrentIssuingDevicePublicKey: (context) =>
        input.resolveCurrentIssuingDevicePublicKey({
          kind: "processor",
          source: "response",
          context,
        }),
    },
  );
  let signer:
    | VerifiedProcessorSignerAuthorizationForCredentialV1
    | undefined;
  let signerIssuerPublicKey: Uint8Array | undefined;
  try {
    assertExactDurableRequest(input.expected, {
      requestId: verified.response.requestId,
      recipientGeneration: verified.response.recipientGeneration,
      descriptorHash: verified.response.workDescriptorHash,
      recipientKeyId: verified.response.recipientKeyId,
      recipientPublicKey: verified.response.recipientPublicKey,
    });
    assertProductCredentialLifetime(
      verified.response.issuedAt,
      verified.response.expiresAt,
    );
    const processorSubject = verified.workDescriptor.subject;
    if (processorSubject.kind !== "processor") {
      throw new TypeError(
        "Processor authorization response has Agent work",
      );
    }
    const decodedSigner = decodeProcessorSignerAuthorizationV1(
      input.signerAuthorizationBytes,
    );
    try {
      const {
        signature: _signature,
        ...unsignedSigner
      } = decodedSigner;
      const resolved =
        await input.resolveCurrentIssuingDevicePublicKey({
          kind: "processor",
          source: "signer_authorization",
          context: {
            ...unsignedSigner,
            purpose: "issue-processor-signer-authorization",
          },
        });
      signerIssuerPublicKey = resolved === null
        ? undefined
        : Uint8Array.from(resolved);
    } finally {
      decodedSigner.issuerSigningPublicKeyHash.fill(0);
      decodedSigner.signer.workDescriptorHash.fill(0);
      decodedSigner.signerPublicKey.fill(0);
      decodedSigner.workDescriptorHash.fill(0);
      decodedSigner.credentialHash.fill(0);
      decodedSigner.signature.fill(0);
    }
    signer =
      await verifyCurrentProcessorSignerAuthorizationForCredentialV1(
        input.crypto,
        {
          authorizationBytes: input.signerAuthorizationBytes,
          credentialBytes: verified.response.credentialBytes,
          now: input.now,
          resolveCurrentCredentialIssuerPublicKey: (context) =>
            input.resolveCurrentIssuingDevicePublicKey({
              kind: "processor",
              source: "credential",
              context,
            }),
          resolveCurrentSignerIssuingDevicePublicKey: () =>
            signerIssuerPublicKey ?? null,
        },
      );
    const descriptor = verified.workDescriptor;
    const response = verified.response;
    const credential = verified.credential;
    const authorization = signer.signerAuthorization.authorization;
    const result: VerifiedProcessorBackgroundAuthorizationDeviceResponse =
      Object.freeze({
        kind: "processor",
        requestId: response.requestId,
        recipientGeneration: response.recipientGeneration,
        recipientKeyId: response.recipientKeyId,
        recipientPublicKey: Uint8Array.from(
          response.recipientPublicKey,
        ),
        descriptorHash: Uint8Array.from(response.workDescriptorHash),
        workId: descriptor.workId,
        workKind: descriptor.workKind,
        purpose: descriptor.purpose,
        responseHash: Uint8Array.from(verified.responseHash),
        responseBytes: Uint8Array.from(verified.responseBytes),
        credentialId: credential.id,
        credentialHash: Uint8Array.from(response.credentialHash),
        issuingHumanId: response.issuingHumanId,
        issuingDeviceId: response.issuingDeviceId,
        issuingDeviceAuthorizationRevision:
          response.issuingDeviceAuthorizationRevision,
        issuerSigningPublicKeyHash: Uint8Array.from(
          response.issuerSigningPublicKeyHash,
        ),
        namespaceId: descriptor.namespaceId,
        domainId: descriptor.domainId,
        domainEpoch: response.domainEpoch,
        namespaceAccessRevision: response.namespaceAccessRevision,
        policyRevision: response.policyRevision,
        issuedAt: response.issuedAt,
        notBefore: response.notBefore,
        expiresAt: response.expiresAt,
        subject: Object.freeze({
          kind: "processor",
          processorKind: processorSubject.processorKind,
          processorVersion: processorSubject.processorVersion,
          authorizationRevision:
            processorSubject.authorizationRevision,
        }),
        signerAuthorization: Object.freeze({
          authorizationId: authorization.id,
          processorKind: authorization.processorKind,
          processorVersion: authorization.processorVersion,
          workId: authorization.workId,
          namespaceId: authorization.namespaceId,
          domainId: authorization.domainId,
          domainEpoch: authorization.domainEpoch,
          namespaceAccessRevision:
            authorization.namespaceAccessRevision,
          policyRevision: authorization.policyRevision,
          processorAuthorizationRevision:
            authorization.processorAuthorizationRevision,
          issuingHumanId: authorization.issuingHumanId,
          issuingDeviceId: authorization.issuingDeviceId,
          issuingDeviceAuthorizationRevision:
            authorization.issuingDeviceAuthorizationRevision,
          issuerSigningPublicKeyHash: Uint8Array.from(
            authorization.issuerSigningPublicKeyHash,
          ),
          signerKeyId: authorization.signer.signerKeyId,
          signerPublicKey: Uint8Array.from(
            authorization.signerPublicKey,
          ),
          authorizationHash: Uint8Array.from(
            signer.signerAuthorization.authorizationHash,
          ),
          credentialHash: Uint8Array.from(
            authorization.credentialHash,
          ),
          authorizationBytes: Uint8Array.from(
            signer.signerAuthorization.authorizationBytes,
          ),
          issuedAt: authorization.issuedAt,
          expiresAt: authorization.expiresAt,
        }),
      });
    return result;
  } finally {
    if (signer !== undefined) destroyProcessorSignerEvidence(signer);
    signerIssuerPublicKey?.fill(0);
    destroyProcessorResponse(verified);
  }
}

async function verifyAgent(
  input: VerifyCurrentAgentBackgroundAuthorizationDeviceResponseInput,
): Promise<VerifiedAgentBackgroundAuthorizationDeviceResponse> {
  const verified = await verifyCurrentAgentBackgroundGrantResponseV1(
    input.crypto,
    {
      responseBytes: input.responseBytes,
      now: input.now,
      resolveCurrentIssuingDevicePublicKey: (context) =>
        input.resolveCurrentIssuingDevicePublicKey({
          kind: "agent",
          source: "response",
          context,
        }),
    },
  );
  try {
    const descriptor = verified.workDescriptor;
    assertExactDurableRequest(input.expected, {
      requestId: descriptor.requestId,
      recipientGeneration: descriptor.recipientGeneration,
      descriptorHash: verified.response.workDescriptorHash,
      recipientKeyId: descriptor.recipientKeyId,
      recipientPublicKey: descriptor.recipientPublicKey,
    });
    assertProductCredentialLifetime(
      verified.response.issuedAt,
      verified.response.expiresAt,
    );
    if (descriptor.subject.kind !== "agent") {
      throw new TypeError(
        "Agent authorization response has processor work",
      );
    }
    return Object.freeze({
      kind: "agent",
      requestId: descriptor.requestId,
      recipientGeneration: descriptor.recipientGeneration,
      recipientKeyId: descriptor.recipientKeyId,
      recipientPublicKey: Uint8Array.from(
        descriptor.recipientPublicKey,
      ),
      descriptorHash: Uint8Array.from(
        verified.response.workDescriptorHash,
      ),
      workId: descriptor.workId,
      workKind: descriptor.workKind,
      purpose: descriptor.purpose,
      responseHash: Uint8Array.from(verified.responseHash),
      responseBytes: Uint8Array.from(verified.responseBytes),
      credentialId: verified.grant.id,
      credentialHash: Uint8Array.from(verified.response.grantHash),
      issuingHumanId: verified.response.issuingHumanId,
      issuingDeviceId: verified.grant.issuingDeviceId,
      issuingDeviceAuthorizationRevision:
        verified.response.issuingDeviceAuthorizationRevision,
      issuerSigningPublicKeyHash: Uint8Array.from(
        verified.response.issuerSigningPublicKeyHash,
      ),
      namespaceId: descriptor.namespaceId,
      domainId: descriptor.domainId,
      domainEpoch: descriptor.expectedDomainEpoch,
      namespaceAccessRevision:
        descriptor.expectedNamespaceAccessRevision,
      policyRevision: descriptor.expectedPolicyRevision,
      issuedAt: verified.response.issuedAt,
      notBefore: verified.response.notBefore,
      expiresAt: verified.response.expiresAt,
      subject: Object.freeze({
        kind: "agent",
        agentId: descriptor.subject.agentId,
        runtimeGeneration: descriptor.subject.runtimeGeneration,
        authorizationRevision:
          descriptor.subject.authorizationRevision,
      }),
    });
  } finally {
    destroyAgentResponse(verified);
  }
}

/**
 * Re-verifies a device response against current authority and binds it to the
 * exact durable request attempt before Runtime may perform its first-winner
 * compare-and-set. Only public facts and opaque recipient-encrypted bytes
 * leave this boundary.
 */
export function verifyCurrentBackgroundAuthorizationDeviceResponse(
  input: VerifyCurrentProcessorBackgroundAuthorizationDeviceResponseInput,
): Promise<VerifiedProcessorBackgroundAuthorizationDeviceResponse>;
export function verifyCurrentBackgroundAuthorizationDeviceResponse(
  input: VerifyCurrentAgentBackgroundAuthorizationDeviceResponseInput,
): Promise<VerifiedAgentBackgroundAuthorizationDeviceResponse>;
export function verifyCurrentBackgroundAuthorizationDeviceResponse(
  input: VerifyCurrentBackgroundAuthorizationDeviceResponseInput,
): Promise<VerifiedBackgroundAuthorizationDeviceResponse> {
  if (input.expected.kind === "processor") {
    return verifyProcessor(
      input as VerifyCurrentProcessorBackgroundAuthorizationDeviceResponseInput,
    );
  }
  return verifyAgent(
    input as VerifyCurrentAgentBackgroundAuthorizationDeviceResponseInput,
  );
}
