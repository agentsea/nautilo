import { createHash } from "node:crypto";

import type {
  ProtectedInitialHumanDomainPlanResponseV1,
  ProtectedInitialHumanDomainReceiptV1,
} from "@nautilo/api-client";
import {
  cryptoDomainId,
  domainEpoch,
  LatticeCrypto,
} from "@nautilo/lattice-crypto";

import type {
  BeginInitialDeviceBootstrap,
  HumanMembershipTargetDomainSubmission,
  InitialDeviceBootstrapChallenge,
  InitialDeviceBootstrapCompletion,
  InitialDeviceBootstrapReceipt,
  InitialDeviceBootstrapReceiptQuery,
} from "../../index.ts";
import { InitialDeviceBootstrapService } from "./initial-bootstrap-service.ts";
import { PostgresInitialDeviceBootstrapRepository } from "./postgres-initial-bootstrap-repository.ts";
import {
  PostgresInitialHumanDomainRepository,
  type InitialHumanDomainAuthority,
} from "./postgres-initial-human-domain-repository.ts";
import type { CryptoPostgresHandle } from "../storage/postgres-lattice-storage.ts";

const textEncoder = new TextEncoder();

function encode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function decode(value: string): Uint8Array {
  const bytes = Uint8Array.from(Buffer.from(value, "base64url"));
  if (Buffer.from(bytes).toString("base64url") !== value) {
    bytes.fill(0);
    throw new TypeError("Initial Domain bytes are not canonical base64url");
  }
  return bytes;
}

export function decodeInitialHumanDomainSubmission(value: Readonly<{
  operationId: string;
  targetDomainId: string;
  participants: readonly string[];
  participantDigestBase64url: string;
  committerDeviceId: string;
  committerHumanId: string;
  initialProviderHead: Readonly<{
    providerId: string;
    domainId: string;
    epoch: 0;
    stateHashBase64url: string;
  }>;
  initialRosterBytesBase64url: string;
  additions: readonly [];
  chainDigestBase64url: string;
  signatureBase64url: string;
}>): HumanMembershipTargetDomainSubmission {
  const detached = [
    decode(value.participantDigestBase64url),
    decode(value.initialProviderHead.stateHashBase64url),
    decode(value.initialRosterBytesBase64url),
    decode(value.chainDigestBase64url),
    decode(value.signatureBase64url),
  ];
  try {
    return Object.freeze({
      formatVersion: 1,
      operationId: value.operationId,
      targetDomainId: value.targetDomainId,
      participants: Object.freeze([...value.participants]),
      participantDigest: detached[0]!,
      committerDeviceId: value.committerDeviceId,
      committerHumanId: value.committerHumanId,
      initialProviderHead: Object.freeze({
        providerId: value.initialProviderHead.providerId,
        domainId: cryptoDomainId(value.initialProviderHead.domainId),
        epoch: domainEpoch(0),
        stateHash: detached[1]!,
      }),
      initialRosterBytes: detached[2]!,
      additions: Object.freeze([]),
      chainDigest: detached[3]!,
      signature: detached[4]!,
    });
  } catch (error) {
    for (const bytes of detached) bytes.fill(0);
    throw error;
  }
}

export interface PostgresInitialDeviceReadinessComposition {
  begin(input: Readonly<{ authority: Readonly<{ userId: string; humanActorId: string }>; request: BeginInitialDeviceBootstrap }>): Promise<InitialDeviceBootstrapChallenge>;
  complete(input: Readonly<{ authority: Readonly<{ userId: string; humanActorId: string }>; completion: InitialDeviceBootstrapCompletion }>): Promise<InitialDeviceBootstrapReceipt>;
  resolveReceipt(input: Readonly<{ authority: Readonly<{ userId: string; humanActorId: string }>; query: InitialDeviceBootstrapReceiptQuery }>): Promise<InitialDeviceBootstrapReceipt | null>;
  planDomain(input: Readonly<{ authority: InitialHumanDomainAuthority }>): Promise<ProtectedInitialHumanDomainPlanResponseV1>;
  activateDomain(input: Readonly<{ authority: InitialHumanDomainAuthority; submission: HumanMembershipTargetDomainSubmission; now: number }>): Promise<ProtectedInitialHumanDomainReceiptV1>;
}

export function createPostgresInitialDeviceReadinessComposition(input: Readonly<{
  getHandle: () => Promise<CryptoPostgresHandle>;
  crypto?: LatticeCrypto;
}>): PostgresInitialDeviceReadinessComposition {
  const crypto = input.crypto ?? new LatticeCrypto();
  let repositories: Promise<Readonly<{
    device: PostgresInitialDeviceBootstrapRepository;
    domain: PostgresInitialHumanDomainRepository;
  }>> | null = null;
  const getRepositories = async () => {
    repositories ??= input.getHandle().then((handle) => Object.freeze({
      device: new PostgresInitialDeviceBootstrapRepository(handle),
      domain: new PostgresInitialHumanDomainRepository({ handle, crypto }),
    }));
    return repositories;
  };
  const service = async (authority: Readonly<{ userId: string; humanActorId: string }>) => {
    const evidence = textEncoder.encode(
      `nautilo/initial-device-session/v1\0${authority.userId}\0${authority.humanActorId}`,
    );
    const digest = crypto.hash(evidence);
    evidence.fill(0);
    return Object.freeze({
      value: new InitialDeviceBootstrapService({
        crypto,
        repository: (await getRepositories()).device,
        authorize: (request) => {
          if (request.userId !== authority.userId || request.humanActorId !== authority.humanActorId) {
            return Object.freeze({ authorized: false as const });
          }
          return Object.freeze({
            authorized: true as const,
            authorizationDigest: digest.slice(),
            installationLineageDigest: request.installationLineageDigest.slice(),
          });
        },
        authorizeReceiptLookup: (query) => query.userId === authority.userId
          && query.humanActorId === authority.humanActorId,
      }),
      destroy: () => digest.fill(0),
    });
  };
  const domainCoordinates = (authority: InitialHumanDomainAuthority) => {
    const digest = createHash("sha256").update(
      `nautilo/initial-human-domain/v1\0${authority.humanId}\0${authority.deviceId}`,
      "utf8",
    ).digest("hex");
    return Object.freeze({
      operationId: `initial-domain:v1:${digest}`,
      domainId: `domain:v1:${digest}`,
    });
  };
  const composition: PostgresInitialDeviceReadinessComposition = {
    async begin(value) {
      const scoped = await service(value.authority);
      try { return await scoped.value.begin(value.request); } finally { scoped.destroy(); }
    },
    async complete(value) {
      const scoped = await service(value.authority);
      try { return await scoped.value.complete(value.completion); } finally { scoped.destroy(); }
    },
    async resolveReceipt(value) {
      const scoped = await service(value.authority);
      try { return await scoped.value.resolveReceipt(value.query); } finally { scoped.destroy(); }
    },
    async planDomain(value) {
      const result = await (await getRepositories()).domain.planSingleton(value.authority);
      if (result.status === "active") {
        return Object.freeze({
          formatVersion: 1 as const,
          status: "active" as const,
          humanId: result.humanId,
          deviceId: result.deviceId,
          domainId: result.domainId,
          providerId: result.providerId,
          epoch: result.epoch,
          stateHashBase64url: encode(result.stateHash),
          trustedDeviceRevision: result.trustedDeviceRevision,
          trustedHostAuthorizationRevision:
            result.trustedHostAuthorizationRevision,
          deliveryHighWatermark: result.deliveryHighWatermark,
        });
      }
      if (result.status !== "available") {
        return Object.freeze({
          formatVersion: 1 as const,
          status: "unavailable" as const,
          reason: result.status === "existing_domain"
            ? "existing_domain_requires_delivery" as const
            : result.status === "multiple_active_devices"
            ? "multiple_active_devices_require_fanout" as const
            : result.status,
          ...(result.migration === undefined
            ? {}
            : { migration: result.migration }),
        });
      }
      const [activeDeviceId] = result.activeDeviceIds;
      if (activeDeviceId === undefined || result.activeDeviceIds.length !== 1) {
        return Object.freeze({
          formatVersion: 1 as const,
          status: "unavailable" as const,
          reason: "multiple_active_devices_require_fanout" as const,
        });
      }
      const coordinates = domainCoordinates(value.authority);
      return Object.freeze({
        formatVersion: 1 as const,
        status: "planned" as const,
        operationId: coordinates.operationId,
        humanId: result.humanId,
        deviceId: result.deviceId,
        domainId: coordinates.domainId,
        currentDomainHead: null,
        activeDeviceIds: [activeDeviceId],
        trustedDeviceRevision: result.trustedDeviceRevision,
        trustedHostAuthorizationRevision: result.trustedHostAuthorizationRevision,
        deliveryHighWatermark: result.deliveryHighWatermark,
      });
    },
    async activateDomain(value) {
      const expected = domainCoordinates(value.authority);
      if (value.submission.operationId !== expected.operationId
        || value.submission.targetDomainId !== expected.domainId) {
        throw new TypeError("Initial Human Domain plan was substituted");
      }
      const result = await (await getRepositories()).domain.activate({
        authority: value.authority,
        submission: value.submission,
        committedAt: value.now,
      });
      if (result.status !== "active" && result.status !== "replayed") {
        throw new Error(`Initial Human Domain rejected: ${result.status}`);
      }
      return Object.freeze({
        formatVersion: 1 as const,
        status: "active" as const,
        operationId: result.receipt.operationId,
        humanId: result.receipt.humanId,
        deviceId: result.receipt.deviceId,
        domainId: result.receipt.domainId,
        providerId: result.receipt.providerId,
        epoch: 0 as const,
        stateHashBase64url: encode(result.receipt.stateHash),
        rosterHashBase64url: encode(result.receipt.rosterHash),
        submissionDigestBase64url: encode(result.receipt.submissionDigest),
        committedAt: result.receipt.committedAt,
      });
    },
  };
  return Object.freeze(composition);
}
