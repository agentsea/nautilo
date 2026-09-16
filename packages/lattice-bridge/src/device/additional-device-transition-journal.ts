import {
  protectedAdditionalDeviceTransitionsRequestV2Schema,
  protectedAdditionalDevicePlanV2Schema,
  type ProtectedAdditionalDevicePlanV2,
  type ProtectedAdditionalDeviceTransitionsRequestV2,
} from "@nautilo/api-client/browser";
import { sha256 } from "@noble/hashes/sha2.js";

import {
  PREPARED_MUTATION_JOURNAL_LIMITS,
  type PreparedMutationJournalIndex,
  type PreparedMutationJournalVaultPort,
} from "../client/memory/prepared-mutation-journal.ts";
import type { PreparedMutationJournalCustodyAvailability } from
  "../client/memory/file-prepared-mutation-journal-vault.ts";

export type AdditionalDeviceTransitionCampaignIndex = Extract<
  PreparedMutationJournalIndex,
  { kind: "additional_device_transition" }
>;

export type AdditionalDeviceTargetPlanIndex = Extract<
  PreparedMutationJournalIndex,
  { kind: "additional_device_target_plan" }
>;

export interface AdditionalDeviceTransitionCampaignVault
extends PreparedMutationJournalVaultPort {
  unlock(): Promise<PreparedMutationJournalCustodyAvailability>;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function toBase64url(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function canonicalRequest(
  request: ProtectedAdditionalDeviceTransitionsRequestV2,
): Readonly<{
  request: ProtectedAdditionalDeviceTransitionsRequestV2;
  bytes: Uint8Array;
}> {
  const parsed = protectedAdditionalDeviceTransitionsRequestV2Schema.parse(request);
  return Object.freeze({
    request: parsed,
    bytes: encoder.encode(JSON.stringify(parsed)),
  });
}

function requestDigest(
  kind: AdditionalDeviceTransitionCampaignIndex["kind"]
    | AdditionalDeviceTargetPlanIndex["kind"],
  operationId: string,
  bytes: Uint8Array,
): string {
  const prefix = encoder.encode(
    `nautilo/${kind.replaceAll("_", "-")}/v1\0${operationId}\0`,
  );
  const digest = sha256.create().update(prefix).update(bytes).digest();
  try {
    return toBase64url(digest);
  } finally {
    prefix.fill(0);
    digest.fill(0);
  }
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((byte, index) => byte === right[index]);
}

export function createAdditionalDeviceTransitionCampaignJournal(input: Readonly<{
  vault: AdditionalDeviceTransitionCampaignVault;
  now(): number;
}>) {
  async function list(): Promise<readonly AdditionalDeviceTransitionCampaignIndex[]> {
    return Object.freeze((await input.vault.listIndexes())
      .filter((candidate): candidate is AdditionalDeviceTransitionCampaignIndex =>
        candidate.kind === "additional_device_transition"
      )
      .map((candidate) => Object.freeze({ ...candidate })));
  }

  return Object.freeze({
    list,
    async putBeforeSend(value: Readonly<{
      operationId: string;
      targetDeviceId: string;
      targetClientKind: "browser" | "electron";
      verificationCode: string;
      candidateProfileDigestBase64url: string;
      candidateProfileGeneration: number;
      request: ProtectedAdditionalDeviceTransitionsRequestV2;
    }>): Promise<Readonly<{
      status: "inserted" | "duplicate";
      index: AdditionalDeviceTransitionCampaignIndex;
    }>> {
      const canonical = canonicalRequest(value.request);
      try {
        if (
          canonical.bytes.length < 1
          || canonical.bytes.length
            > PREPARED_MUTATION_JOURNAL_LIMITS.maxAdditionalDeviceCampaignBytes
        ) throw new RangeError("Additional-device transition campaign exceeds its bound");
        const timestamp = input.now();
        const index: AdditionalDeviceTransitionCampaignIndex = Object.freeze({
          formatVersion: 1,
          operationId: value.operationId,
          kind: "additional_device_transition",
          targetDeviceId: value.targetDeviceId,
          targetClientKind: value.targetClientKind,
          verificationCode: value.verificationCode,
          candidateProfileDigestBase64url:
            value.candidateProfileDigestBase64url,
          candidateProfileGeneration: value.candidateProfileGeneration,
          authenticatedRequestDigestBase64url:
            requestDigest("additional_device_transition", value.operationId, canonical.bytes),
          canonicalBytes: canonical.bytes.length,
          sealedBytes: canonical.bytes.length + 16,
          createdAt: timestamp,
          updatedAt: timestamp,
          attempts: 0,
          attemptWindowStartedAt: null,
          attemptsInWindow: 0,
          nextAttemptAt: timestamp,
          lastAttemptAt: null,
          state: "pending",
        });
        const result = await input.vault.putSealed({
          index,
          canonicalBody: canonical.bytes,
        });
        if (result === "collision") {
          throw new Error("Additional-device transition campaign collided");
        }
        const persisted = (await list()).find((candidate) =>
          candidate.operationId === value.operationId
        );
        if (
          persisted === undefined
          || persisted.authenticatedRequestDigestBase64url
            !== index.authenticatedRequestDigestBase64url
          || persisted.targetDeviceId !== index.targetDeviceId
          || persisted.candidateProfileDigestBase64url
            !== index.candidateProfileDigestBase64url
          || persisted.candidateProfileGeneration
            !== index.candidateProfileGeneration
        ) throw new Error("Additional-device transition campaign custody disagrees");
        return Object.freeze({
          status: result === "inserted" ? "inserted" : "duplicate",
          index: persisted,
        });
      } finally {
        canonical.bytes.fill(0);
      }
    },
    async withRequest<Result>(
      index: AdditionalDeviceTransitionCampaignIndex,
      use: (
        request: ProtectedAdditionalDeviceTransitionsRequestV2,
      ) => Promise<Result> | Result,
    ): Promise<Result> {
      return input.vault.withOpenedBody(
        index.operationId,
        index.authenticatedRequestDigestBase64url,
        async (bytes) => {
          if (
            bytes.length !== index.canonicalBytes
            || requestDigest(index.kind, index.operationId, bytes)
              !== index.authenticatedRequestDigestBase64url
          ) throw new Error("Additional-device transition campaign is corrupt");
          const value: unknown = JSON.parse(decoder.decode(bytes));
          const canonical = canonicalRequest(
            protectedAdditionalDeviceTransitionsRequestV2Schema.parse(value),
          );
          try {
            if (!sameBytes(canonical.bytes, bytes)) {
              throw new Error("Additional-device transition campaign is not canonical");
            }
            return await use(canonical.request);
          } finally {
            canonical.bytes.fill(0);
          }
        },
      );
    },
    removeExact(index: AdditionalDeviceTransitionCampaignIndex): Promise<boolean> {
      return input.vault.removeExact(
        index.operationId,
        index.authenticatedRequestDigestBase64url,
      );
    },
  });
}

function canonicalPlanPages(
  pages: readonly ProtectedAdditionalDevicePlanV2[],
): Readonly<{ pages: readonly ProtectedAdditionalDevicePlanV2[]; bytes: Uint8Array }> {
  const parsed = Object.freeze(pages.map((page) =>
    protectedAdditionalDevicePlanV2Schema.parse(page)
  ));
  return Object.freeze({
    pages: parsed,
    bytes: encoder.encode(JSON.stringify({ formatVersion: 1, pages: parsed })),
  });
}

export function createAdditionalDeviceTargetPlanJournal(input: Readonly<{
  vault: AdditionalDeviceTransitionCampaignVault;
  now(): number;
}>) {
  async function list(): Promise<readonly AdditionalDeviceTargetPlanIndex[]> {
    return Object.freeze((await input.vault.listIndexes())
      .filter((candidate): candidate is AdditionalDeviceTargetPlanIndex =>
        candidate.kind === "additional_device_target_plan"
      )
      .map((candidate) => Object.freeze({ ...candidate })));
  }
  return Object.freeze({
    list,
    async putBeforeMutation(value: Readonly<{
      operationId: string;
      targetDeviceId: string;
      verificationCode: string;
      pages: readonly ProtectedAdditionalDevicePlanV2[];
    }>): Promise<AdditionalDeviceTargetPlanIndex> {
      const canonical = canonicalPlanPages(value.pages);
      try {
        if (
          canonical.bytes.length < 1
          || canonical.bytes.length
            > PREPARED_MUTATION_JOURNAL_LIMITS.maxAdditionalDeviceCampaignBytes
        ) throw new RangeError("Additional-device target plan exceeds its bound");
        const timestamp = input.now();
        const index: AdditionalDeviceTargetPlanIndex = Object.freeze({
          formatVersion: 1,
          operationId: value.operationId,
          kind: "additional_device_target_plan",
          targetDeviceId: value.targetDeviceId,
          verificationCode: value.verificationCode,
          deliveryHighWatermark: null,
          deliveryManifest: Object.freeze([]),
          authenticatedRequestDigestBase64url:
            requestDigest("additional_device_target_plan", value.operationId, canonical.bytes),
          canonicalBytes: canonical.bytes.length,
          sealedBytes: canonical.bytes.length + 16,
          createdAt: timestamp,
          updatedAt: timestamp,
          attempts: 0,
          attemptWindowStartedAt: null,
          attemptsInWindow: 0,
          nextAttemptAt: timestamp,
          lastAttemptAt: null,
          state: "pending",
        });
        const result = await input.vault.putSealed({
          index,
          canonicalBody: canonical.bytes,
        });
        if (result === "collision") {
          throw new Error("Additional-device target plan collided");
        }
        const persisted = (await list()).find((candidate) =>
          candidate.operationId === value.operationId
        );
        if (
          persisted === undefined
          || persisted.authenticatedRequestDigestBase64url
            !== index.authenticatedRequestDigestBase64url
          || persisted.targetDeviceId !== index.targetDeviceId
        ) throw new Error("Additional-device target plan custody disagrees");
        return persisted;
      } finally {
        canonical.bytes.fill(0);
      }
    },
    async withPages<Result>(
      index: AdditionalDeviceTargetPlanIndex,
      use: (
        pages: readonly ProtectedAdditionalDevicePlanV2[],
      ) => Promise<Result> | Result,
    ): Promise<Result> {
      return input.vault.withOpenedBody(
        index.operationId,
        index.authenticatedRequestDigestBase64url,
        async (bytes) => {
          if (
            bytes.length !== index.canonicalBytes
            || requestDigest(index.kind, index.operationId, bytes)
              !== index.authenticatedRequestDigestBase64url
          ) throw new Error("Additional-device target plan is corrupt");
          const value: unknown = JSON.parse(decoder.decode(bytes));
          if (
            typeof value !== "object"
            || value === null
            || (value as { formatVersion?: unknown }).formatVersion !== 1
            || !Array.isArray((value as { pages?: unknown }).pages)
          ) throw new Error("Additional-device target plan is malformed");
          const canonical = canonicalPlanPages(
            (value as { pages: ProtectedAdditionalDevicePlanV2[] }).pages,
          );
          try {
            if (!sameBytes(canonical.bytes, bytes)) {
              throw new Error("Additional-device target plan is not canonical");
            }
            return await use(canonical.pages);
          } finally {
            canonical.bytes.fill(0);
          }
        },
      );
    },
    async recordDeliveryManifest(
      expected: AdditionalDeviceTargetPlanIndex,
      delivery: Readonly<{
        highWatermark: number;
        messages: readonly Readonly<{
          messageId: string;
          recipientSequence: number;
          payloadHashBase64url: string;
        }>[];
      }>,
    ): Promise<AdditionalDeviceTargetPlanIndex> {
      if (
        delivery.messages.length < 1
        || delivery.messages.length > 4_096
        || !Number.isSafeInteger(delivery.highWatermark)
        || delivery.highWatermark < delivery.messages.at(-1)!.recipientSequence
        || delivery.messages.some((message, index, messages) =>
          message.messageId.length < 1
          || message.messageId.length > 128
          || message.payloadHashBase64url.length !== 43
          || !Number.isSafeInteger(message.recipientSequence)
          || message.recipientSequence < 1
          || index > 0
            && messages[index - 1]!.recipientSequence >= message.recipientSequence
        )
      ) throw new TypeError("Additional-device delivery manifest is invalid");
      const replacement: AdditionalDeviceTargetPlanIndex = Object.freeze({
        ...expected,
        deliveryHighWatermark: delivery.highWatermark,
        deliveryManifest: Object.freeze(delivery.messages.map((message) =>
          Object.freeze({ ...message })
        )),
        updatedAt: input.now(),
      });
      if (!await input.vault.updateIndex(expected, replacement)) {
        const current = (await list()).find((candidate) =>
          candidate.operationId === expected.operationId
        );
        if (
          current === undefined
          || current.deliveryHighWatermark !== replacement.deliveryHighWatermark
          || JSON.stringify(current.deliveryManifest)
            !== JSON.stringify(replacement.deliveryManifest)
        ) throw new Error("Additional-device delivery manifest conflicted");
        return current;
      }
      return replacement;
    },
    removeExact(index: AdditionalDeviceTargetPlanIndex): Promise<boolean> {
      return input.vault.removeExact(
        index.operationId,
        index.authenticatedRequestDigestBase64url,
      );
    },
  });
}
