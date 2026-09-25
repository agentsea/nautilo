import type {
  NautiloApiClient,
  ProtectedTaskRunResultReadReadyEnvelopeV1,
} from "@nautilo/api-client/browser";

import {
  deriveTaskContentCryptoObjectIdV1,
} from "../../task/task-content-repository.ts";
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
  resultRevision: 1;
  cryptoAccessRevision: 0;
  namespaceId: string;
  encryptedPayloadBytes: Uint8Array;
  accessManifestBytes: Uint8Array;
  accessManifestProofBytes: readonly Uint8Array[];
  namespaceEnvelopeBytes: Uint8Array;
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
      const expectedObjectId = deriveTaskContentCryptoObjectIdV1({
        kind: "run_result",
        taskId: request.taskId,
        taskRunId: request.taskRunId,
        contentRevision: 1,
      });
      const response = await input.api.getProtectedTaskRunResultEnvelopeV1(
        request.taskId,
        request.taskRunId,
      );
      if (response.readVersion !== 1
        || response.taskId !== request.taskId
        || response.taskRunId !== request.taskRunId
        || response.objectId !== expectedObjectId
        || response.resultRevision !== 1) {
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
      if (response.cryptoAccessRevision !== 0
        || response.signerEvidence.length !== 1
        || response.signerEvidence[0]?.kind !== "agent_runtime_publication") {
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
          resultRevision: 1,
          cryptoAccessRevision: 0,
          namespaceId: response.namespaceId,
          encryptedPayloadBytes: decode(response.encryptedPayloadBytesBase64url),
          accessManifestBytes: decode(response.accessManifestBytesBase64url),
          accessManifestProofBytes: response.accessManifestProofBytesBase64url
            .map(decode),
          namespaceEnvelopeBytes: decode(response.namespaceEnvelopeBytesBase64url),
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
