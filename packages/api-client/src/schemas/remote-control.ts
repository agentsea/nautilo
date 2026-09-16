/** Browser-safe D458 remote-controller HTTP and presence contracts. */
import { z } from "zod";

const nonEmpty = z.string().trim().min(1);
const opaqueUuid = z.string().uuid();
const lowercaseHex = (bytes: number) => z.string().regex(new RegExp(`^[0-9a-f]{${bytes * 2}}$`));

/**
 * The host list is deliberately a display projection, not a relay directory.
 * `remoteHostId` is the caller-owned controller-binding UUID; clients must
 * never learn or send a relay/session/install/generation identifier to select
 * a desktop. Capability and version data are UI hints only, never authority.
 */
export const remoteHostReadinessSchema = z.enum([
  "compatible_online",
  "incompatible_online",
  "stale",
  "unknown",
  "offline",
  "identity_conflict",
]);

export const remoteHostSchema = z
  .object({
    /** Opaque, server-owned controller binding id used for this host projection. */
    remoteHostId: opaqueUuid,
    label: z.string().nullable(),
    /** Truthful current transport state, never inferred from historical data. */
    connected: z.boolean(),
    readiness: remoteHostReadinessSchema,
    lastSeenAt: z.string().nullable(),
  })
  .strict();

export const remoteControllerSchema = z
  .object({
    bindingId: opaqueUuid,
    /** The same opaque, server-owned binding id exposed by host projections. */
    remoteHostId: opaqueUuid,
    installationId: opaqueUuid,
    label: z.string().nullable(),
    createdAt: z.string(),
    lastSeenAt: z.string().nullable(),
  })
  .strict();

/** Snapshot cursor for reconnect/reconciliation. Sequence is scoped to streamId. */
export const remoteHostResumeCursorSchema = z
  .object({
    streamId: nonEmpty.max(128),
    sequence: z.number().int().nonnegative(),
    snapshotRevision: z.number().int().nonnegative(),
  })
  .strict();

/**
 * Fresh HTTP snapshot used after socket connect/reconnect. Clients replace
 * their projection when `streamId` changes and ignore events at/before cursor.
 */
export const remoteHostSnapshotResponseSchema = z
  .object({
    hosts: z.array(remoteHostSchema),
    cursor: remoteHostResumeCursorSchema,
  })
  .strict();

export const remoteHostSnapshotEventSchema = remoteHostSnapshotResponseSchema
  .extend({ type: z.literal("remote.host.snapshot") })
  .strict();

export const listRemoteHostsResponseSchema = remoteHostSnapshotResponseSchema
  .extend({ controllerLabel: z.string().nullable() })
  .strict();
export const listRemoteControllersResponseSchema = z
  .object({ controllers: z.array(remoteControllerSchema) })
  .strict();

const remoteHostPresenceEventBaseSchema = remoteHostResumeCursorSchema.extend({
  eventId: nonEmpty.max(128),
  remoteHostId: opaqueUuid,
});

/** Browser-side parser for the server-to-client remote presence stream. */
export const remoteHostPresenceEventSchema = z.discriminatedUnion("type", [
  remoteHostPresenceEventBaseSchema.extend({
    type: z.literal("remote.host.connected"),
    host: remoteHostSchema,
  }).strict(),
  remoteHostPresenceEventBaseSchema.extend({
    type: z.literal("remote.host.updated"),
    host: remoteHostSchema,
  }).strict(),
  remoteHostPresenceEventBaseSchema.extend({
    type: z.literal("remote.host.disconnected"),
    terminalReason: z.enum(["offline", "identity_conflict"]),
  }).strict(),
  remoteHostPresenceEventBaseSchema.extend({
    type: z.literal("remote.host.revoked"),
    terminalReason: z.literal("revoked"),
  }).strict(),
]);

export const createRemotePairingChallengeRequestSchema = z.object({
  relayId: nonEmpty.max(256),
}).strict();
export const createRemotePairingChallengeResponseSchema = z.object({
  /** A deep link only: it never embeds a relay or bearer credential. */
  deepLink: z.string().min(1).max(2048),
  challengeId: opaqueUuid,
  /** Server-authored HMAC context, signed by the controller but never secret. */
  ceremonyContext: lowercaseHex(32),
  qrSecret: nonEmpty,
  manualCode: nonEmpty,
  expiresAt: z.string(),
}).strict();

export const consumeRemotePairingChallengeRequestSchema = z.object({
  challengeId: opaqueUuid,
  secret: nonEmpty.max(512),
  /** Client-minted stable mobile installation UUID assertion. */
  installationId: opaqueUuid,
  proof: z
    .object({
      algorithm: z.literal("Ed25519"),
      ceremonyContext: lowercaseHex(32),
      /** Raw 32-byte Ed25519 public key, not an SPKI wrapper. */
      publicKey: lowercaseHex(32),
      signature: lowercaseHex(64),
    })
    .strict(),
  label: z.string().trim().min(1).max(200).optional(),
}).strict();
export const consumeRemotePairingChallengeResponseSchema = z.object({
  ok: z.literal(true),
  /** Client-minted installation UUID, echoed only after proof verification. */
  installationId: opaqueUuid,
  /** Server-owned controller-installation row used by later authority checks. */
  controllerInstallationId: opaqueUuid,
  bindingId: opaqueUuid,
  installationGeneration: z.number().int().positive(),
  /** Exact server authority scope retained for later ordinary-request proof. */
  serverInstanceId: opaqueUuid,
  serverBindingGeneration: z.number().int().positive(),
}).strict();

/** Resolve a manual code to non-secret signing inputs before the final consume. */
export const prepareManualRemotePairingRequestSchema = z.object({
  manualCode: nonEmpty.max(64),
}).strict();
export const prepareManualRemotePairingResponseSchema = z.object({
  challengeId: opaqueUuid,
  ceremonyContext: lowercaseHex(32),
  expiresAt: z.string(),
}).strict();

export const renameRemoteControllerRequestSchema = z.object({
  label: z.string().trim().min(1).max(200),
});
export const remoteMutationResponseSchema = z.object({ ok: z.literal(true) });

/** D458 Gate 3B — phone-bound, read-only Computer Files requests. */
export const remoteHostFileRootKindSchema = z.enum(["workspace", "current_folder", "paired_filesystem"]);
export const remoteHostFileErrorCodeSchema = z.enum([
  "offline",
  "revoked",
  "no_current_folder",
  "root_stale",
  "transport",
  "inaccessible",
  "unsupported",
  "too_large",
  "not_found",
]);
const remoteHostFileRelativePathSchema = z.string().max(1024);
const remoteHostFileRequestBaseSchema = z.object({
  remoteHostId: opaqueUuid,
  rootKind: remoteHostFileRootKindSchema,
  /** Relative to rootKind only; absolute paths are rejected server-side. */
  relativePath: remoteHostFileRelativePathSchema.default(""),
}).strict();
export const listRemoteHostFilesRequestSchema = remoteHostFileRequestBaseSchema.extend({
  cursor: z.string().max(512).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  includeHidden: z.boolean().optional(),
  query: z.string().trim().max(200).optional(),
}).strict();
export const statRemoteHostFileRequestSchema = remoteHostFileRequestBaseSchema;
export const readRemoteHostFilePreviewRequestSchema = remoteHostFileRequestBaseSchema;
export const selectRemoteHostCurrentFolderRequestSchema = z.object({
  remoteHostId: opaqueUuid,
  sourceRootKind: remoteHostFileRootKindSchema,
  /** Relative to the already-authorized source root; never a Mac path. */
  relativePath: remoteHostFileRelativePathSchema.default(""),
}).strict();
export const selectRemoteHostCurrentFolderResponseSchema = z.object({
  ok: z.literal(true),
  /** Basename only, returned by Electron after canonical local validation. */
  label: z.string().min(1).max(1024),
}).strict();

export const remoteHostFileMetadataSchema = z.object({
  path: remoteHostFileRelativePathSchema,
  size: z.number().int().nonnegative(),
  mtimeMs: z.number().nonnegative(),
  isFile: z.boolean(),
  isDirectory: z.boolean(),
  isSymbolicLink: z.boolean(),
}).strict();
export const remoteHostFileEntrySchema = z.object({
  name: z.string().min(1).max(1024),
  path: remoteHostFileRelativePathSchema,
  isDirectory: z.boolean(),
  isFile: z.boolean(),
  isSymbolicLink: z.boolean(),
}).strict();
export const listRemoteHostFilesResponseSchema = z.object({
  entries: z.array(remoteHostFileEntrySchema).max(100),
  nextCursor: z.string().max(512).nullable(),
}).strict();
export const statRemoteHostFileResponseSchema = z.object({
  entry: remoteHostFileMetadataSchema,
}).strict();
export const readRemoteHostFilePreviewResponseSchema = z.object({
  entry: remoteHostFileMetadataSchema,
  /** Bounded raw file bytes; no machine-local path or artifact is returned. */
  dataBase64: z.string().max(1_398_104),
}).strict();

export type RemoteHost = z.infer<typeof remoteHostSchema>;
export type RemoteHostReadiness = z.infer<typeof remoteHostReadinessSchema>;
export type RemoteController = z.infer<typeof remoteControllerSchema>;
export type RemoteHostResumeCursor = z.infer<typeof remoteHostResumeCursorSchema>;
export type RemoteHostSnapshotResponse = z.infer<typeof remoteHostSnapshotResponseSchema>;
export type RemoteHostSnapshotEvent = z.infer<typeof remoteHostSnapshotEventSchema>;
export type RemoteHostPresenceEvent = z.infer<typeof remoteHostPresenceEventSchema>;
export type ListRemoteHostsResponse = z.infer<typeof listRemoteHostsResponseSchema>;
export type ListRemoteControllersResponse = z.infer<typeof listRemoteControllersResponseSchema>;
export type CreateRemotePairingChallengeRequest = z.infer<
  typeof createRemotePairingChallengeRequestSchema
>;
export type CreateRemotePairingChallengeResponse = z.infer<
  typeof createRemotePairingChallengeResponseSchema
>;
export type ConsumeRemotePairingChallengeRequest = z.infer<
  typeof consumeRemotePairingChallengeRequestSchema
>;
export type ConsumeRemotePairingChallengeResponse = z.infer<
  typeof consumeRemotePairingChallengeResponseSchema
>;
export type PrepareManualRemotePairingRequest = z.infer<
  typeof prepareManualRemotePairingRequestSchema
>;
export type PrepareManualRemotePairingResponse = z.infer<
  typeof prepareManualRemotePairingResponseSchema
>;
export type RenameRemoteControllerRequest = z.infer<typeof renameRemoteControllerRequestSchema>;
export type RemoteHostFileRootKind = z.infer<typeof remoteHostFileRootKindSchema>;
export type RemoteHostFileErrorCode = z.infer<typeof remoteHostFileErrorCodeSchema>;
export type ListRemoteHostFilesRequest = z.infer<typeof listRemoteHostFilesRequestSchema>;
export type StatRemoteHostFileRequest = z.infer<typeof statRemoteHostFileRequestSchema>;
export type ReadRemoteHostFilePreviewRequest = z.infer<typeof readRemoteHostFilePreviewRequestSchema>;
export type SelectRemoteHostCurrentFolderRequest = z.infer<typeof selectRemoteHostCurrentFolderRequestSchema>;
export type SelectRemoteHostCurrentFolderResponse = z.infer<typeof selectRemoteHostCurrentFolderResponseSchema>;
export type RemoteHostFileMetadata = z.infer<typeof remoteHostFileMetadataSchema>;
export type RemoteHostFileEntry = z.infer<typeof remoteHostFileEntrySchema>;
export type ListRemoteHostFilesResponse = z.infer<typeof listRemoteHostFilesResponseSchema>;
export type StatRemoteHostFileResponse = z.infer<typeof statRemoteHostFileResponseSchema>;
export type ReadRemoteHostFilePreviewResponse = z.infer<typeof readRemoteHostFilePreviewResponseSchema>;
