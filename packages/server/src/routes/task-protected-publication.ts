import {
  dualTaskPreparedCreateRequestV1Schema,
  dualTaskPreparedUpdateRequestV1Schema,
  type DualTaskPreparedCreateRequestV1,
  type DualTaskPreparedUpdateRequestV1,
  type ProtectedTaskPreparedCreateRequestV1,
  type ProtectedTaskPreparedUpdateRequestV1,
  type ProtectedTaskPublicationPlanV1,
} from "@nautilo/api-client";
import {
  authenticatePreparedHumanTaskContentCryptoRevisionExactReplayV1,
  authenticatePreparedHumanTaskContentCryptoRevisionV1,
  decodeTaskPayloadV1,
  encodeTaskPayloadV1,
  fingerprintTaskDualPublicationFieldsV1,
  fingerprintTaskOperationalFieldsV1,
  type PreparedTaskContentCryptoRevisionV1,
  type TaskContentPayloadV1,
  type TaskContentAuthorityV1,
} from "@nautilo/lattice-bridge";
import type {
  HumanTaskPublicationRequest,
  LatticeCrypto,
} from "@nautilo/lattice-crypto";
import { decodeHumanTaskPublicationRequestV1 } from "@nautilo/lattice-crypto/wire";

function bytes(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64url"));
}

function canonicalBytes(label: string, value: string): Uint8Array {
  const decoded = bytes(value);
  if (Buffer.from(decoded).toString("base64url") !== value) {
    decoded.fill(0);
    throw new TypeError(`${label} is not canonical base64url`);
  }
  return decoded;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

type PreparedTaskPublicationRequestV1 =
  | ProtectedTaskPreparedCreateRequestV1
  | ProtectedTaskPreparedUpdateRequestV1
  | DualTaskPreparedCreateRequestV1
  | DualTaskPreparedUpdateRequestV1;

type ImportedTaskPublicationCommonV1 = Readonly<{
  authority: TaskContentAuthorityV1;
  prepared: PreparedTaskContentCryptoRevisionV1;
  requestDigest: Uint8Array;
}>;

export type ImportedProtectedTaskPublicationV1 =
  ImportedTaskPublicationCommonV1 & Readonly<{
    representation: "protected";
  }>;

export type ImportedDualTaskPublicationV1 =
  ImportedTaskPublicationCommonV1 & Readonly<{
    representation: "dual";
    ordinaryContent: TaskContentPayloadV1;
  }>;

export type ImportedPreparedTaskPublicationV1 =
  | ImportedProtectedTaskPublicationV1
  | ImportedDualTaskPublicationV1;

export type PreparedTaskPublicationReplayLookupV1 = Readonly<{
  operationId: string;
  requestDigest: Uint8Array;
  representation: "protected" | "dual";
  coordinate: Readonly<{
    kind: "definition";
    taskId: string;
    contentRevision: number;
  }>;
  requesterHumanId: string;
  namespaceId: string;
}>;

function isDualPreparedTaskPublication(
  prepared: PreparedTaskPublicationRequestV1,
): prepared is DualTaskPreparedCreateRequestV1 | DualTaskPreparedUpdateRequestV1 {
  return "representation" in prepared && prepared.representation === "dual";
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value !== "object") {
    throw new TypeError("Dual Task publication body is not canonical JSON");
  }
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function canonicalDualBody(
  prepared: DualTaskPreparedCreateRequestV1 | DualTaskPreparedUpdateRequestV1,
  canonicalOrdinaryPayloadBytes: Uint8Array,
): Readonly<Record<string, unknown>> {
  const normalize = (label: string, value: string): string => {
    const decoded = canonicalBytes(label, value);
    try {
      return Buffer.from(decoded).toString("base64url");
    } finally {
      decoded.fill(0);
    }
  };
  return Object.freeze({
    ...prepared,
    planDigestBase64url: normalize("Task publication plan digest", prepared.planDigestBase64url),
    encryptedPayloadBytesBase64url: normalize(
      "Encrypted Task payload",
      prepared.encryptedPayloadBytesBase64url,
    ),
    accessManifestBytesBase64url: normalize(
      "Task access manifest",
      prepared.accessManifestBytesBase64url,
    ),
    namespaceEnvelopes: prepared.namespaceEnvelopes.map((entry) => Object.freeze({
      ...entry,
      envelopeBytesBase64url: normalize(
        "Task Namespace envelope",
        entry.envelopeBytesBase64url,
      ),
    })),
    signedPublicationRequestBytesBase64url: normalize(
      "Signed Task publication request",
      prepared.signedPublicationRequestBytesBase64url,
    ),
    ordinaryPayloadBytesBase64url:
      Buffer.from(canonicalOrdinaryPayloadBytes).toString("base64url"),
  });
}

function digestCanonicalDualBody(
  crypto: LatticeCrypto,
  prepared: DualTaskPreparedCreateRequestV1 | DualTaskPreparedUpdateRequestV1,
  canonicalOrdinaryPayloadBytes: Uint8Array,
): Uint8Array {
  const encoded = new TextEncoder().encode(
    `nautilo/task-dual-publication-body/v1\n${canonicalJson(
      canonicalDualBody(prepared, canonicalOrdinaryPayloadBytes),
    )}`,
  );
  try {
    return crypto.hash(encoded);
  } finally {
    encoded.fill(0);
  }
}

/**
 * Authenticates a device-prepared HTTP publication against one exact
 * server-authored plan. This mints no authority and persists nothing; callers
 * pass the returned opaque revision to the PR2 durable repository.
 */
export async function importProtectedTaskPublicationV1(input: Readonly<{
  crypto: LatticeCrypto;
  now: number;
  /** Fresh admission requires the server-authored plan; exact replay does not. */
  plan: ProtectedTaskPublicationPlanV1 | null;
  prepared: PreparedTaskPublicationRequestV1;
  /** Validate every signed authority fact against current durable state. */
  resolveCurrentAuthority(
    request: HumanTaskPublicationRequest,
  ): Promise<Uint8Array | null>;
  /** Required only for a deadline-expired exact durable replay. */
  lookupPreparedReplay?(
    request: PreparedTaskPublicationReplayLookupV1,
  ): Promise<
    | Readonly<{ status: "exact"; authority: TaskContentAuthorityV1 }>
    | Readonly<{ status: "unavailable" }>
  >;
}>): Promise<ImportedPreparedTaskPublicationV1> {
  const { plan } = input;
  const prepared = isDualPreparedTaskPublication(input.prepared)
    ? input.prepared.operation === "create"
      ? dualTaskPreparedCreateRequestV1Schema.parse(input.prepared)
      : dualTaskPreparedUpdateRequestV1Schema.parse(input.prepared)
    : input.prepared;
  const dual = isDualPreparedTaskPublication(prepared);
  let authority: TaskContentAuthorityV1 | undefined;
  let signed: Uint8Array | undefined;
  let planDigest: Uint8Array | undefined;
  let bindingHash: Uint8Array | undefined;
  let canonicalOrdinaryPayloadBytes: Uint8Array | undefined;
  let ordinaryContent: TaskContentPayloadV1 | undefined;
  let operationalFieldsDigest: Uint8Array | undefined;
  let requestDigest: Uint8Array | undefined;
  let exactSignedRequestDigest: Uint8Array | undefined;
  let freshAuthorityCheck: Readonly<{
    keyGeneration: number;
    bindingHash: Uint8Array;
  }> | undefined;
  try {
    signed = dual
      ? canonicalBytes(
          "Signed Task publication request",
          prepared.signedPublicationRequestBytesBase64url,
        )
      : bytes(prepared.signedPublicationRequestBytesBase64url);
    planDigest = bytes(prepared.planDigestBase64url);
    if (dual) {
      const submitted = canonicalBytes(
        "Ordinary Task payload",
        prepared.ordinaryPayloadBytesBase64url,
      );
      try {
        const payload = decodeTaskPayloadV1(submitted);
        canonicalOrdinaryPayloadBytes = encodeTaskPayloadV1(payload);
        if (!sameBytes(submitted, canonicalOrdinaryPayloadBytes)) {
          throw new TypeError("Ordinary Task payload is not canonical");
        }
        ordinaryContent = Object.freeze({
          coordinate: Object.freeze({
            kind: "definition" as const,
            taskId: prepared.taskId,
            contentRevision: prepared.nextContentRevision,
          }),
          payload,
        });
      } finally {
        submitted.fill(0);
      }
    }
    operationalFieldsDigest = dual
      ? fingerprintTaskDualPublicationFieldsV1(
          prepared.operation,
          prepared.task,
          canonicalOrdinaryPayloadBytes!,
        )
      : fingerprintTaskOperationalFieldsV1(prepared.operation, prepared.task);
    requestDigest = dual
      ? digestCanonicalDualBody(
          input.crypto,
          prepared,
          canonicalOrdinaryPayloadBytes!,
        )
      : input.crypto.hash(signed);
    const signedRequest = decodeHumanTaskPublicationRequestV1(signed);
    const expired = input.now >= signedRequest.deadlineAt;
    const exactReplay = plan === null || expired;
    if (exactReplay) {
      if (input.lookupPreparedReplay === undefined) {
        throw new TypeError("Expired Task publication has no exact durable replay");
      }
      const replay = await input.lookupPreparedReplay(Object.freeze({
        operationId: prepared.operationId,
        requestDigest: requestDigest.slice(),
        representation: dual ? "dual" as const : "protected" as const,
        coordinate: Object.freeze({
          kind: "definition" as const,
          taskId: prepared.taskId,
          contentRevision: prepared.nextContentRevision,
        }),
        requesterHumanId: signedRequest.subjectHumanId,
        namespaceId: signedRequest.namespaceId,
      }));
      if (replay.status !== "exact") {
        throw new TypeError("Expired Task publication is not an exact durable replay");
      }
      // The exact ledger-owned full-body digest above commits to these canonical
      // embedded bytes; derive their verifier digest only after that equality.
      exactSignedRequestDigest = dual
        ? input.crypto.hash(signed)
        : requestDigest.slice();
      authority = replay.authority;
    } else {
      if (plan === null || (
        plan.operation !== prepared.operation
        || plan.operationId !== prepared.operationId
        || plan.taskId !== prepared.taskId
        || plan.planDigestBase64url !== prepared.planDigestBase64url
        || plan.expectedContentRevision !== prepared.expectedContentRevision
        || plan.nextContentRevision !== prepared.nextContentRevision
        || plan.expectedCryptoAccessRevision !== prepared.expectedCryptoAccessRevision
        || prepared.requiredNamespaceIds.length !== 1
        || prepared.requiredNamespaceIds[0] !== plan.authority.namespaceId
        || prepared.namespaceEnvelopes.length !== 1
        || prepared.namespaceEnvelopes[0]?.namespaceId
          !== plan.authority.namespaceId
      )) throw new TypeError("Prepared Task publication disagrees with its server plan");
      authority = Object.freeze({
        authorityVersion: 1,
        kind: "requester_private_namespace",
        keyClass: "ai",
        requesterHumanId: plan.authority.requesterHumanId,
        namespaceId: plan.authority.namespaceId,
        domainId: plan.authority.domainId,
        expectedAccessRevision: plan.authority.expectedAccessRevision,
        expectedPolicyRevision: plan.authority.expectedPolicyRevision,
      });
      bindingHash = bytes(plan.authority.bindingHashBase64url);
      freshAuthorityCheck = Object.freeze({
        keyGeneration: plan.authority.keyGeneration,
        bindingHash,
      });
    }
    const authentication = {
      crypto: input.crypto,
      operation: prepared.operation,
      operationId: prepared.operationId,
      coordinate: Object.freeze({
        kind: "definition" as const,
        taskId: prepared.taskId,
        contentRevision: prepared.nextContentRevision,
      }),
      expectedContentRevision: prepared.expectedContentRevision,
      expectedCryptoAccessRevision: prepared.expectedCryptoAccessRevision,
      authority,
      planDigest,
      operationalFieldsDigest,
      payloadBytes: bytes(prepared.encryptedPayloadBytesBase64url),
      manifestBytes: bytes(prepared.accessManifestBytesBase64url),
      envelopeBytes: bytes(prepared.namespaceEnvelopes[0].envelopeBytesBase64url),
      signedPublicationRequestBytes: signed,
      resolveCurrentAuthority: async (request: HumanTaskPublicationRequest) => {
        if (!exactReplay) {
          if (freshAuthorityCheck === undefined || (
            request.keyGeneration !== freshAuthorityCheck.keyGeneration
            || !sameBytes(request.bindingHash, freshAuthorityCheck.bindingHash)
          )) throw new TypeError("Signed Task publication authority disagrees with its server plan");
        }
        return input.resolveCurrentAuthority(request);
      },
    } as const;
    const revision = exactReplay
      ? await authenticatePreparedHumanTaskContentCryptoRevisionExactReplayV1({
          ...authentication,
          expectedSignedRequestDigest: exactSignedRequestDigest!,
        })
      : await authenticatePreparedHumanTaskContentCryptoRevisionV1({
          ...authentication,
          now: input.now,
        });
    if (dual) {
      return Object.freeze({
        representation: "dual" as const,
        authority,
        prepared: revision,
        ordinaryContent: ordinaryContent!,
        requestDigest: requestDigest.slice(),
      });
    }
    return Object.freeze({
      representation: "protected" as const,
      authority,
      prepared: revision,
      requestDigest: requestDigest.slice(),
    });
  } finally {
    signed?.fill(0);
    planDigest?.fill(0);
    bindingHash?.fill(0);
    operationalFieldsDigest?.fill(0);
    canonicalOrdinaryPayloadBytes?.fill(0);
    requestDigest?.fill(0);
    exactSignedRequestDigest?.fill(0);
  }
}
