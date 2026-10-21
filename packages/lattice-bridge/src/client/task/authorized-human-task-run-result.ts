import type {
  NautiloApiClient,
  ProtectedTaskRunResultReadReadyEnvelopeV1,
} from "@nautilo/api-client/browser";

import {
  deriveTaskHistoricalContentCryptoObjectIdV1,
} from "../../task/task-historical-content-identity.ts";
import {
  deriveTaskContentCryptoObjectIdV1,
} from "../../task/task-content-repository.ts";
import { parseTaskHistoricalRepairProvenanceV1 } from
  "../../task/task-historical-repair-provenance.ts";
import {
  decodeTaskRunResultPayloadV1,
  type TaskRunResultPayloadV1,
} from "../../task/task-payload-v1.ts";
import { ClassifiedDataOperationError } from
  "../../transition/encryption-data-operation-owner.ts";

export type TaskRunResultReadBytesV1 = Readonly<{
  readVersion: 1;
  taskId: string;
  taskRunId: string;
  objectId: string;
  resultRevision: 1 | 2;
  cryptoAccessRevision: number;
  namespaceId: string;
  readAuthority: ProtectedTaskRunResultReadReadyEnvelopeV1["readAuthority"];
  encryptedPayloadBytes: Uint8Array;
  accessManifestBytes: Uint8Array;
  accessManifestProofBytes: readonly Uint8Array[];
  namespaceEnvelopeBytes: Uint8Array;
  historicalRepair?: ProtectedTaskRunResultReadReadyEnvelopeV1["historicalRepair"];
  signerEvidence: ProtectedTaskRunResultReadReadyEnvelopeV1["signerEvidence"];
}>;

export type HumanTaskRunResultReadV1 =
  | Readonly<{ status: "ready"; payload: TaskRunResultPayloadV1 }>
  | Readonly<{ status: "waiting"; reason: "result_not_mapped" }>
  | Readonly<{ status: "unavailable"; reason:
      | "result_not_protected"
      | "authority_changed"
      | "unsupported_crypto_access_revision"
      | "integrity_failure" }>;

export interface HumanTaskRunResultDevicePortV1 {
  /** Authenticates the Agent signer, access manifest, and current AI keyring. */
  openExact(input: Readonly<{
    taskId: string;
    taskRunId: string;
    agentId: string;
    envelope: TaskRunResultReadBytesV1;
  }>): Promise<Uint8Array>;
}

function decodeCanonicalBase64url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.length % 4 === 1) {
    throw new ClassifiedDataOperationError(
      "integrity", "Protected Task result bytes are invalid",
    );
  }
  const bytes = Uint8Array.from(
    atob(value.replaceAll("-", "+").replaceAll("_", "/")
      + "=".repeat((4 - value.length % 4) % 4)),
    (character) => character.charCodeAt(0),
  );
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  const canonical = btoa(binary)
    .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
  if (canonical !== value) {
    bytes.fill(0);
    throw new ClassifiedDataOperationError(
      "integrity", "Protected Task result bytes are invalid",
    );
  }
  return bytes;
}

function decodeHexDigest(value: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/u.test(value)) {
    throw new ClassifiedDataOperationError(
      "integrity", "Protected Task historical result identity is invalid",
    );
  }
  return Uint8Array.from(value.match(/../gu)!, byte => Number.parseInt(byte, 16));
}

/** Protected-only TaskRun result reader shared by Browser and Desktop. */
export function createAuthorizedHumanTaskRunResultReaderV1(input: Readonly<{
  api: Pick<NautiloApiClient, "getProtectedTaskRunResultEnvelopeV1">;
  device: HumanTaskRunResultDevicePortV1;
}>) {
  return Object.freeze({
    async read(request: Readonly<{
      taskId: string;
      taskRunId: string;
      agentId: string;
    }>): Promise<HumanTaskRunResultReadV1> {
      const response = await input.api.getProtectedTaskRunResultEnvelopeV1(
        request.taskId,
        request.taskRunId,
      );
      if ((response.resultRevision !== 1 && response.resultRevision !== 2)
        || response.readVersion !== 1
        || response.taskId !== request.taskId
        || response.taskRunId !== request.taskRunId) {
        throw new ClassifiedDataOperationError(
          "integrity", "Protected Task result identity was substituted",
        );
      }
      if (response.status === "waiting") {
        return Object.freeze({ status: "waiting", reason: response.reason });
      }
      if (response.status === "unavailable") {
        return Object.freeze({ status: "unavailable", reason: response.reason });
      }
      let historicalRepair = response.status === "ready"
        ? response.historicalRepair : undefined;
      if (historicalRepair !== undefined) {
        try {
          const parsed = parseTaskHistoricalRepairProvenanceV1(historicalRepair);
          if (parsed.version !== 2) throw new TypeError("unsupported version");
          historicalRepair = parsed;
        } catch (cause) {
          throw new ClassifiedDataOperationError(
            "integrity", "Protected Task historical result identity is invalid",
            { cause },
          );
        }
      }
      let expectedObjectId = deriveTaskContentCryptoObjectIdV1({
        kind: "run_result",
        taskId: request.taskId,
        taskRunId: request.taskRunId,
        contentRevision: response.resultRevision,
      });
      if (response.status === "ready" && historicalRepair !== undefined) {
        expectedObjectId = deriveTaskHistoricalContentCryptoObjectIdV1({
            coordinate: {
              kind: "run_result",
              taskId: request.taskId,
              taskRunId: request.taskRunId,
              contentRevision: response.resultRevision,
            },
            namespaceId: response.namespaceId,
            sourceDigest: decodeHexDigest(historicalRepair.sourceDigest),
          });
      }
      if (response.objectId !== expectedObjectId) {
        throw new ClassifiedDataOperationError(
          "integrity", "Protected Task result identity was substituted",
        );
      }
      const agentEvidence = response.signerEvidence.filter(entry =>
        entry.kind === "agent_runtime_publication"
        || entry.kind === "foreground_agent_accepted_execution"
        || entry.kind === "task_runtime_signer_certificate");
      const humanEvidence = response.signerEvidence.filter(entry =>
        entry.kind === "human_device");
      if (response.accessManifestProofBytesBase64url.length
          !== response.cryptoAccessRevision
        || historicalRepair === undefined && (
          agentEvidence.length !== 1
          || agentEvidence.length + humanEvidence.length
            !== response.signerEvidence.length
        )
        || historicalRepair !== undefined && (
          response.resultRevision !== 1
          || agentEvidence.length !== 0
          || humanEvidence.length !== response.signerEvidence.length
          || !humanEvidence.some(entry =>
            entry.committerDeviceId === historicalRepair.publisherDeviceId)
        )) {
        throw new ClassifiedDataOperationError(
          "integrity", "Protected Task result access evidence is invalid",
        );
      }
      const decoded: Uint8Array[] = [];
      try {
        const decode = (value: string): Uint8Array => {
          const bytes = decodeCanonicalBase64url(value);
          decoded.push(bytes);
          return bytes;
        };
        const envelope: TaskRunResultReadBytesV1 = Object.freeze({
          readVersion: 1,
          taskId: response.taskId,
          taskRunId: response.taskRunId,
          objectId: response.objectId,
          resultRevision: response.resultRevision,
          cryptoAccessRevision: response.cryptoAccessRevision,
          namespaceId: response.namespaceId,
          readAuthority: response.readAuthority,
          encryptedPayloadBytes: decode(response.encryptedPayloadBytesBase64url),
          accessManifestBytes: decode(response.accessManifestBytesBase64url),
          accessManifestProofBytes: response.accessManifestProofBytesBase64url
            .map(decode),
          namespaceEnvelopeBytes: decode(response.namespaceEnvelopeBytesBase64url),
          ...(historicalRepair === undefined ? {} : { historicalRepair }),
          signerEvidence: response.signerEvidence,
        });
        const opened = await input.device.openExact({
          ...request,
          envelope,
        });
        try {
          return Object.freeze({
            status: "ready" as const,
            payload: decodeTaskRunResultPayloadV1(opened),
          });
        } finally {
          opened.fill(0);
        }
      } finally {
        for (const bytes of decoded) bytes.fill(0);
      }
    },
  });
}
