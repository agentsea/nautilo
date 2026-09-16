import { createHash } from "node:crypto";
import {
  type ProcessorTransformRecipientAttempt,
  type ProcessorTransformRecipientRegistry,
} from "@nautilo/lattice-crypto";

import { attachBackgroundAuthorizationRecipient } from "./lifecycle";
import type {
  BackgroundAuthorizationRecord,
  BackgroundAuthorizationRepository,
} from "./repository";

const PRODUCT_RECIPIENT_TTL_MS = 5 * 60_000;

export type ProcessorRecipientDescriptorAttempt = Readonly<{
  readonly descriptorBytes: Uint8Array;
  readonly descriptorHash: Uint8Array;
}>;

export interface ProcessorRecipientDescriptorFactory {
  readonly create: (input: Readonly<{
    readonly record: BackgroundAuthorizationRecord;
    readonly attempt: ProcessorTransformRecipientAttempt;
  }>) => Promise<ProcessorRecipientDescriptorAttempt>;
}

export type PrepareProcessorRecipientResult =
  | Readonly<{ readonly status: "missing" | "stale" | "not_due" }>
  | Readonly<{
    readonly status: "terminal";
    readonly reason: "retry_limit_exhausted";
  }>
  | Readonly<{
    readonly status: "device_authorization_required";
    readonly requestId: string;
    readonly recipientGeneration: number;
    readonly descriptorBytes: Uint8Array;
    readonly descriptorHash: Uint8Array;
  }>;

export type ProcessorRecipientExpiryRetryResult =
  | Readonly<{ readonly status: "retry_scheduled" }>
  | Readonly<{ readonly status: "stale" }>
  | Readonly<{
    readonly status: "terminal";
    readonly reason: "retry_limit_exhausted";
  }>;

export interface PrepareProcessorRecipientOptions {
  readonly repository: BackgroundAuthorizationRepository;
  readonly recipients: ProcessorTransformRecipientRegistry;
  readonly descriptors: ProcessorRecipientDescriptorFactory;
  readonly now: () => number;
  readonly recipientKeyId: (record: BackgroundAuthorizationRecord) => string;
  readonly authorizationRequested?: (
    record: BackgroundAuthorizationRecord,
  ) => Promise<void>;
  readonly retryExpired: (
    record: BackgroundAuthorizationRecord,
  ) => Promise<ProcessorRecipientExpiryRetryResult>;
}

function supportedProcessorRecord(record: BackgroundAuthorizationRecord): boolean {
  const subject = record.snapshot.credentialSubject;
  if (subject.kind !== "processor") return false;
  if (record.snapshot.formatVersion === 1) {
    return subject.processorKind === "stenographer"
      && record.workKind.startsWith("stenographer.");
  }
  return (subject.processorKind === "stenographer"
      && record.workKind.startsWith("stenographer."))
    || (subject.processorKind === "reflection"
      && record.workKind.startsWith("reflection."));
}

function exactHash(bytes: Uint8Array, expected: Uint8Array): boolean {
  if (!(expected instanceof Uint8Array) || expected.length !== 32) return false;
  const actual = createHash("sha256").update(bytes).digest();
  let difference = 0;
  for (let index = 0; index < actual.length; index += 1) {
    difference |= actual[index]! ^ expected[index]!;
  }
  return difference === 0;
}

function hasProcessLocalRecipient(
  recipients: ProcessorTransformRecipientRegistry,
  record: BackgroundAuthorizationRecord,
): boolean {
  const recipient = record.snapshot.recipient;
  return recipient !== null && recipients.hasAttempt({
    requestId: record.snapshot.requestId,
    recipientGeneration: record.snapshot.recipientGeneration,
    recipientKeyId: recipient.recipientKeyId,
  });
}

export async function prepareProcessorRecipient(
  requestId: string,
  options: PrepareProcessorRecipientOptions,
): Promise<PrepareProcessorRecipientResult> {
  const current = await options.repository.get(requestId);
  if (current === null) return Object.freeze({ status: "missing" as const });
  if (!supportedProcessorRecord(current)) {
    return Object.freeze({ status: "stale" as const });
  }
  const now = options.now();
  if (
    current.snapshot.state === "awaiting_device"
    && current.descriptorBytes !== null
    && current.snapshot.descriptorDigest !== null
  ) {
    if (
      current.snapshot.recipient !== null
      && now >= current.snapshot.recipient.expiresAt
    ) {
      options.recipients.delete(
        requestId,
        current.snapshot.recipientGeneration,
      );
      const retried = await options.retryExpired(current);
      if (retried.status === "retry_scheduled") {
        return prepareProcessorRecipient(requestId, options);
      }
      if (retried.status === "terminal") return retried;
      return Object.freeze({ status: "stale" as const });
    }
    // Another live server may own this recipient. Local absence alone is not
    // evidence of a restart; expiry above is the shared takeover fence.
    if (!hasProcessLocalRecipient(options.recipients, current)) {
      return Object.freeze({ status: "not_due" as const });
    }
    return Object.freeze({
      status: "device_authorization_required" as const,
      requestId,
      recipientGeneration: current.snapshot.recipientGeneration,
      descriptorBytes: current.descriptorBytes.slice(),
      descriptorHash: Uint8Array.from(
        Buffer.from(current.snapshot.descriptorDigest, "hex"),
      ),
    });
  }
  if (current.snapshot.state !== "awaiting_recipient") {
    return Object.freeze({ status: "stale" as const });
  }
  if (
    current.snapshot.nextAttemptAt !== null
    && now < current.snapshot.nextAttemptAt
  ) {
    return Object.freeze({ status: "not_due" as const });
  }
  const created = await options.recipients.createAttempt({
    requestId,
    workId: current.snapshot.workId,
    namespaceId: current.snapshot.namespaceId,
    recipientGeneration: current.snapshot.recipientGeneration,
    recipientKeyId: options.recipientKeyId(current),
    expiresAt: now + PRODUCT_RECIPIENT_TTL_MS,
  });
  if (created.status !== "created") {
    return Object.freeze({ status: "stale" as const });
  }
  let keepRecipient = false;
  try {
    const descriptor = await options.descriptors.create({
      record: current,
      attempt: created.attempt,
    });
    if (
      !(descriptor.descriptorBytes instanceof Uint8Array)
      || descriptor.descriptorBytes.length < 1
      || !exactHash(descriptor.descriptorBytes, descriptor.descriptorHash)
    ) {
      throw new TypeError(
        "protected processor descriptor bytes/hash are inconsistent",
      );
    }
    const next: BackgroundAuthorizationRecord = {
      ...current,
      snapshot: attachBackgroundAuthorizationRecipient(current.snapshot, {
        recipientGeneration: current.snapshot.recipientGeneration,
        descriptorDigest: Buffer.from(descriptor.descriptorHash).toString("hex"),
        recipientKeyId: created.attempt.recipientKeyId,
        recipientPublicKey: Buffer.from(created.attempt.recipientPublicKey)
          .toString("base64url"),
        expiresAt: created.attempt.expiresAt,
        now,
      }),
      descriptorBytes: descriptor.descriptorBytes.slice(),
    };
    const stored = await options.repository.compareAndSwap({
      expectedRequestRevision: current.snapshot.requestRevision,
      next,
    });
    if (stored.status !== "updated") {
      return Object.freeze({ status: "stale" as const });
    }
    keepRecipient = true;
    await options.authorizationRequested?.(stored.record).catch(() => {});
    return Object.freeze({
      status: "device_authorization_required" as const,
      requestId,
      recipientGeneration: current.snapshot.recipientGeneration,
      descriptorBytes: descriptor.descriptorBytes.slice(),
      descriptorHash: descriptor.descriptorHash.slice(),
    });
  } finally {
    if (!keepRecipient) {
      options.recipients.delete(
        requestId,
        current.snapshot.recipientGeneration,
      );
    }
  }
}
