/**
 * Browser-neutral v1 `.nautilo-profile.json` envelope.
 *
 * This is deliberately only the finite JSON profile envelope: semantic record
 * frames, recovery slot, and optional avatar bytes. It has no filesystem,
 * Node Buffer, terminal, or artifact-sidecar concerns. Callers provide the
 * Argon2id implementation; that keeps the exact same encrypted format usable
 * by the native CLI and a browser Worker.
 */
import { xchacha20poly1305 } from "@noble/ciphers/chacha";
import { canonicalJsonBytes } from "./canonical";
import { CONTAINER_VERSION, PAYLOAD_CODEC, PROTECTION_SUITE_ID, SEMANTIC_VERSION } from "./versions";
import { sha256, sha256Hex } from "./sha256";
import * as container from "./container";
import * as keySlots from "./key-slots";
import * as protection from "./protection";
import * as semantic from "./semantic";

export type Argon2idDeriveFn = protection.Argon2idDeriveFn;
export type Argon2idParams = protection.Argon2idParams;
export type SemanticRecord = semantic.SemanticRecord;

type ContainerHeaderV1 = container.ContainerHeaderV1;
type EncryptedFrameV1 = container.EncryptedFrameV1;
type RecoverySlot = keySlots.RecoverySlot;
type GenieLiveV1 = semantic.GenieLiveV1;
type PortableScope = semantic.PortableScope;

export const DEFAULT_PROFILE_BUNDLE_KDF_PARAMS: Argon2idParams = {
  memoryCostKiB: 19456,
  timeCost: 2,
  parallelism: 1,
  outputLength: 32,
};

const NONCE_BYTES = 24;
const TAG_BYTES = 16;
const TEXT_ENCODER = new TextEncoder();

export class WrongPassphraseError extends Error {
  public constructor(message = "wrong passphrase (recovery-slot DEK unwrap failed)") {
    super(message);
    this.name = "WrongPassphraseError";
  }
}

export class ProfileBundleFileError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ProfileBundleFileError";
  }
}

export interface AvatarMedia {
  readonly mediaEntry: string;
  readonly sha256: string;
  readonly mimeType: string;
  readonly size?: number | undefined;
}

export interface SlotJson {
  readonly kind: "recovery";
  readonly slotId: number;
  readonly kdf: "argon2id";
  readonly kdfParams: Argon2idParams;
  readonly salt: string;
  readonly wrappedDek: string;
  readonly aad: string;
}

export interface HeaderJson {
  readonly containerVersion: 1;
  readonly semanticVersion: { readonly major: number; readonly minor: number };
  readonly bundleId: string;
  readonly payloadCodec: typeof PAYLOAD_CODEC;
  readonly protectionSuite: typeof PROTECTION_SUITE_ID;
  readonly chunkSize: number;
  readonly keySlots: readonly SlotJson[];
  readonly frameCount: number;
  readonly totalPayloadBytes: number;
}

export interface FrameJson {
  readonly ordinal: number;
  readonly kind: "record" | "terminal-manifest";
  readonly ciphertext: string;
  readonly aad: string;
}

export interface MediaJson {
  readonly ciphertext: string;
  readonly nonce: string;
  readonly aad: string;
}

/** A reference is retained for backwards-compatible parsing; this core never reads a sidecar. */
export interface ProfileBundleArtifactStreamRef {
  readonly mediaVersion: 2;
  readonly size: number;
  readonly sha256: string;
}

export interface ProfileBundleFile {
  readonly format: "nautilo-profile-bundle";
  readonly formatVersion: 1;
  readonly header: HeaderJson;
  readonly frames: readonly FrameJson[];
  readonly media: MediaJson | null;
  readonly artifactStream?: ProfileBundleArtifactStreamRef | undefined;
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

function fromHex(value: string): Uint8Array {
  if (value.length % 2 !== 0) throw new ProfileBundleFileError(`odd-length hex: ${value.slice(0, 16)}`);
  if (!/^(?:[0-9a-fA-F]{2})*$/.test(value)) throw new ProfileBundleFileError("invalid hex byte");
  const out = new Uint8Array(value.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function slotToJson(slot: RecoverySlot): SlotJson {
  return { kind: "recovery", slotId: slot.slotId, kdf: "argon2id", kdfParams: slot.kdfParams, salt: toHex(slot.salt), wrappedDek: toHex(slot.wrappedDek), aad: toHex(slot.aad) };
}

function slotFromJson(slot: SlotJson): RecoverySlot {
  return { kind: "recovery", slotId: slot.slotId, kdf: "argon2id", kdfParams: slot.kdfParams, salt: fromHex(slot.salt), wrappedDek: fromHex(slot.wrappedDek), aad: fromHex(slot.aad) };
}

function frameToJson(frame: EncryptedFrameV1): FrameJson {
  return { ordinal: frame.ordinal, kind: frame.kind, ciphertext: toHex(frame.ciphertext), aad: toHex(frame.aad) };
}

function frameFromJson(frame: FrameJson): EncryptedFrameV1 {
  return { ordinal: frame.ordinal, kind: frame.kind, ciphertext: fromHex(frame.ciphertext), aad: fromHex(frame.aad) };
}

function headerToJson(header: ContainerHeaderV1): HeaderJson {
  return {
    containerVersion: 1, semanticVersion: header.semanticVersion, bundleId: header.bundleId,
    payloadCodec: header.payloadCodec, protectionSuite: header.protectionSuite, chunkSize: header.chunkSize,
    keySlots: header.keySlots.map((slot) => slotToJson(slot as RecoverySlot)),
    frameCount: header.frameCount, totalPayloadBytes: header.totalPayloadBytes,
  };
}

export function headerFromJson(header: HeaderJson): ContainerHeaderV1 {
  return {
    containerVersion: 1, semanticVersion: { major: header.semanticVersion.major, minor: header.semanticVersion.minor },
    bundleId: header.bundleId, payloadCodec: header.payloadCodec, protectionSuite: header.protectionSuite,
    chunkSize: header.chunkSize, keySlots: header.keySlots.map(slotFromJson), frameCount: header.frameCount,
    totalPayloadBytes: header.totalPayloadBytes,
  };
}

function deriveMediaNonce(headerDigest: string): Uint8Array {
  return sha256(new Uint8Array([...TEXT_ENCODER.encode(headerDigest), ...TEXT_ENCODER.encode("nautilo-profile-avatar-v1")])).subarray(0, NONCE_BYTES);
}

function computeMediaAad(headerDigest: string, plaintextLength: number): Uint8Array {
  return canonicalJsonBytes({ digest: headerDigest, kind: "avatar", length: plaintextLength });
}

function sealMedia(dek: Uint8Array, headerDigest: string, plaintext: Uint8Array): MediaJson {
  const aad = computeMediaAad(headerDigest, plaintext.length);
  const nonce = deriveMediaNonce(headerDigest);
  return { ciphertext: toHex(xchacha20poly1305(dek, nonce, aad).encrypt(plaintext)), nonce: toHex(nonce), aad: toHex(aad) };
}

function openMedia(dek: Uint8Array, headerDigest: string, media: MediaJson): Uint8Array {
  const ciphertext = fromHex(media.ciphertext);
  if (ciphertext.length < TAG_BYTES) throw new ProfileBundleFileError("avatar ciphertext is shorter than its authentication tag");
  const aad = fromHex(media.aad);
  const nonce = fromHex(media.nonce);
  if (toHex(computeMediaAad(headerDigest, ciphertext.length - TAG_BYTES)) !== toHex(aad)) {
    throw new ProfileBundleFileError("media AAD mismatch (header tampered or AAD mutated)");
  }
  if (toHex(deriveMediaNonce(headerDigest)) !== toHex(nonce)) throw new ProfileBundleFileError("media nonce mismatch");
  try { return xchacha20poly1305(dek, nonce, aad).decrypt(ciphertext); }
  catch { throw new WrongPassphraseError("media AEAD authentication failed (wrong passphrase or tampered media)"); }
}

export type RandomFn = (length: number) => Uint8Array;
const defaultRandom: RandomFn = (length) => crypto.getRandomValues(new Uint8Array(length));

export interface EncryptProfileBundleInput {
  readonly records: readonly SemanticRecord[];
  readonly bundleId: string;
  readonly avatarBytes: Uint8Array | null;
  readonly avatarMedia: AvatarMedia | null;
  readonly passphrase: Uint8Array;
  readonly argon2id: Argon2idDeriveFn;
  readonly salt?: Uint8Array | undefined;
  readonly dek?: Uint8Array | undefined;
  readonly random?: RandomFn | undefined;
}

export async function encryptProfileBundleFile(input: EncryptProfileBundleInput): Promise<ProfileBundleFile> {
  if (input.passphrase.length === 0) throw new ProfileBundleFileError("passphrase must not be empty");
  validateSemanticRecords(input.records, SEMANTIC_VERSION.minor);
  const random = input.random ?? defaultRandom;
  const dek = input.dek ?? protection.generateDek();
  const ownsDek = input.dek === undefined;
  try {
  const salt = input.salt ?? random(protection.ARGON2ID_BOUNDS.saltLength.exactly);
  const slot = await protection.wrapDekWithRecoverySlot({ dek, passphrase: input.passphrase, salt, kdfParams: DEFAULT_PROFILE_BUNDLE_KDF_PARAMS, slotId: 0, argon2id: input.argon2id });
  let totalPayloadBytes = 0;
  for (const record of input.records) totalPayloadBytes += canonicalJsonBytes(record).length;
  const header: ContainerHeaderV1 = {
    containerVersion: CONTAINER_VERSION, semanticVersion: { major: SEMANTIC_VERSION.major, minor: SEMANTIC_VERSION.minor },
    bundleId: input.bundleId, payloadCodec: PAYLOAD_CODEC, protectionSuite: PROTECTION_SUITE_ID, chunkSize: container.LIMITS.chunkSize.max,
    keySlots: [slot], frameCount: input.records.length + 1, totalPayloadBytes,
  };
  const encrypted = protection.encryptBundle({ header, records: input.records as readonly unknown[], dek });
  if (!encrypted.ok) throw new ProfileBundleFileError(`encryptBundle failed: ${encrypted.errors.map((error) => `${error.code}:${error.message}`).join("; ")}`);
  let media: MediaJson | null = null;
  if (input.avatarBytes !== null || input.avatarMedia !== null) {
    if (input.avatarBytes === null || input.avatarMedia === null) throw new ProfileBundleFileError("avatar bytes require matching metadata in the encrypted avatar record");
    assertAvatarMetadataMatchesRecord(input.records, input.avatarMedia, input.avatarBytes);
    media = sealMedia(dek, encrypted.headerDigest, input.avatarBytes);
  }
  return { format: "nautilo-profile-bundle", formatVersion: 1, header: headerToJson(header), frames: encrypted.frames.map(frameToJson), media };
  } finally {
    // Callers that inject a DEK (tests/advanced hosts) retain ownership; the
    // ordinary generated browser DEK is always wiped once serialized.
    if (ownsDek) dek.fill(0);
  }
}

export interface DecryptProfileBundleResult {
  readonly records: readonly SemanticRecord[];
  readonly manifest: unknown;
  readonly bundle: GenieLiveV1;
  readonly avatarBytes: Uint8Array | null;
  readonly avatarMedia: AvatarMedia | null;
  /** The caller owns this recovered DEK and must zero it when finished. */
  readonly dek: Uint8Array;
}

export async function decryptProfileBundleFile(file: ProfileBundleFile, passphrase: Uint8Array, argon2id: Argon2idDeriveFn): Promise<DecryptProfileBundleResult> {
  if (file.format !== "nautilo-profile-bundle") throw new ProfileBundleFileError(`unsupported format: ${String(file.format)}`);
  if (file.formatVersion !== 1) throw new ProfileBundleFileError(`unsupported formatVersion: ${String(file.formatVersion)}`);
  const header = headerFromJson(file.header);
  const frames = file.frames.map(frameFromJson);
  assertContainerBounds(header, frames);
  const recoverySlot = header.keySlots.find((slot) => slot.kind === "recovery");
  if (!recoverySlot) throw new ProfileBundleFileError("no recovery key slot in header");
  const unwrap = await protection.unwrapDekFromRecoverySlot({ slot: recoverySlot, passphrase, argon2id });
  if (!unwrap.ok) throw new WrongPassphraseError(unwrap.code === "WRONG_PASSPHRASE" ? "wrong passphrase (recovery-slot DEK unwrap failed)" : unwrap.message);
  const dek = unwrap.dek;
  try {
  const verified = protection.verifyFinalBundle({ header, frames, dek });
  if (!verified.ok) throw new ProfileBundleFileError(`terminal-manifest verification failed: ${verified.errors.map((error) => `${error.code}:${error.message}`).join("; ")}`);
  const minor = header.semanticVersion.minor;
  if (header.semanticVersion.major !== 1 || (minor !== 0 && minor !== 1)) throw new ProfileBundleFileError(`unsupported semanticVersion: ${header.semanticVersion.major}.${minor}`);
  const records = validateSemanticRecords(verified.records, minor);
  const artifacts = records.filter((record) => record.recordKind === "artifact");
  if (artifacts.length > 0 && file.artifactStream === undefined) throw new ProfileBundleFileError("artifact records require an artifact stream sidecar");
  if (artifacts.length === 0 && file.artifactStream !== undefined) throw new ProfileBundleFileError("artifact stream sidecar has no artifact records");
  const bundleBase = {
    bundleId: header.bundleId, scopes: deriveScopes(records, file.media),
    ...(artifacts.length === 0 ? {} : { artifactMedia: { mediaVersion: semantic.ARTIFACT_MEDIA_FORMAT_VERSION, entries: artifacts.map((artifact) => ({ path: artifact.bytesEntry, size: artifact.size, sha256: artifact.sha256 })) } }),
  };
  const bundle: GenieLiveV1 = minor === 0
    ? { ...bundleBase, semanticVersion: { major: 1, minor: 0 }, records: records as readonly semantic.SemanticRecordV1_0[] }
    : { ...bundleBase, semanticVersion: { major: 1, minor: 1 }, records: records as readonly semantic.SemanticRecordV1_1[] };
  const semanticResult = semantic.validateGenieLiveV1(bundle);
  if (!semanticResult.ok) throw new ProfileBundleFileError(`semantic bundle validation failed: ${semanticResult.errors.map((error) => `${error.code}:${error.message}`).join("; ")}`);
  let avatarBytes: Uint8Array | null = null;
  let avatarMedia: AvatarMedia | null = null;
  if (file.media !== null) {
    const recordMedia = avatarMetadataFromRecords(records);
    if (!recordMedia) throw new ProfileBundleFileError("encrypted avatar media has no authenticated avatar record");
    avatarBytes = openMedia(dek, protection.computeHeaderDigest(header), file.media);
    if (sha256Hex(avatarBytes) !== recordMedia.sha256) throw new ProfileBundleFileError(`avatar sha256 mismatch: encrypted avatar record ${recordMedia.sha256} vs actual ${sha256Hex(avatarBytes)}`);
    avatarMedia = { ...recordMedia, size: avatarBytes.length };
  }
  return { records, manifest: verified.manifest, bundle, avatarBytes, avatarMedia, dek };
  } catch (error) {
    dek.fill(0);
    throw error;
  }
}

function validateSemanticRecords(value: readonly unknown[], minor: 0 | 1): readonly SemanticRecord[] {
  for (let index = 0; index < value.length; index++) {
    const result = semantic.validateSemanticRecord(value[index], minor);
    if (!result.ok) throw new ProfileBundleFileError(`semantic record ${index} validation failed: ${result.errors.map((error) => `${error.code}:${error.message}`).join("; ")}`);
  }
  return value as readonly SemanticRecord[];
}

function deriveScopes(records: readonly SemanticRecord[], media: MediaJson | null): PortableScope[] {
  const scopes: PortableScope[] = ["profile"];
  if (media !== null && records.some((record) => record.recordKind === "avatar" && record.avatar !== null)) scopes.push("avatar");
  if (records.some((record) => record.recordKind === "memory" && record.scope === "private")) scopes.push("privateMemories");
  if (records.some((record) => record.recordKind === "artifact")) scopes.push("privateArtifacts");
  return scopes;
}

function avatarMetadataFromRecords(records: readonly SemanticRecord[]): AvatarMedia | null {
  const avatar = records.find((record): record is semantic.AvatarRecord => record.recordKind === "avatar" && record.avatar !== null)?.avatar;
  return avatar ? { mediaEntry: avatar.mediaEntry, mimeType: avatar.mimeType, sha256: avatar.sha256 } : null;
}

function assertAvatarMetadataMatchesRecord(records: readonly SemanticRecord[], media: AvatarMedia, avatarBytes: Uint8Array): void {
  const recordMedia = avatarMetadataFromRecords(records);
  if (!recordMedia || recordMedia.mimeType !== media.mimeType || recordMedia.sha256 !== media.sha256 || sha256Hex(avatarBytes) !== recordMedia.sha256) {
    throw new ProfileBundleFileError("avatar bytes require matching metadata in the encrypted avatar record");
  }
}

function assertContainerBounds(header: ContainerHeaderV1, frames: readonly EncryptedFrameV1[]): void {
  const headerResult = container.validateContainerHeader(header);
  const framesResult = container.validateFrameSequence(frames);
  if (headerResult.ok && framesResult.ok) return;
  const errors = [...(headerResult.ok ? [] : headerResult.errors), ...(framesResult.ok ? [] : framesResult.errors)];
  throw new ProfileBundleFileError(`invalid protected container: ${errors.map((error) => `${error.code}:${error.message}`).join("; ")}`);
}

export function serializeProfileBundleFile(file: ProfileBundleFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}

export function parseProfileBundleFile(text: string): ProfileBundleFile {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new ProfileBundleFileError("file is not valid JSON"); }
  if (!isRecord(parsed)) throw new ProfileBundleFileError("file is not an object");
  if (parsed["format"] !== "nautilo-profile-bundle") throw new ProfileBundleFileError(`not a nautilo-profile-bundle (format=${String(parsed["format"])})`);
  if (parsed["formatVersion"] !== 1) throw new ProfileBundleFileError(`unsupported formatVersion ${String(parsed["formatVersion"])}`);
  if (!isRecord(parsed["header"])) throw new ProfileBundleFileError("missing header");
  if (!Array.isArray(parsed["frames"])) throw new ProfileBundleFileError("missing frames array");
  if (parsed["media"] !== null && !isRecord(parsed["media"])) throw new ProfileBundleFileError("media must be null or object");
  return { format: "nautilo-profile-bundle", formatVersion: 1, header: parseHeader(parsed["header"]), frames: parsed["frames"].map(parseFrame), media: parsed["media"] === null ? null : parseMedia(parsed["media"]), artifactStream: parseArtifactStreamRef(parsed["artifactStream"]) };
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function parseArtifactStreamRef(value: unknown): ProfileBundleArtifactStreamRef | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new ProfileBundleFileError("artifactStream must be null or object");
  if (value["mediaVersion"] !== 2) throw new ProfileBundleFileError("artifactStream.mediaVersion must be 2");
  if (typeof value["size"] !== "number" || !Number.isInteger(value["size"]) || value["size"] < 0) throw new ProfileBundleFileError("artifactStream.size must be a non-negative integer");
  if (typeof value["sha256"] !== "string" || !/^[0-9a-f]{64}$/.test(value["sha256"])) throw new ProfileBundleFileError("artifactStream.sha256 must be a hex64 string");
  return { mediaVersion: 2, size: value["size"], sha256: value["sha256"] };
}
function parseHeader(value: Record<string, unknown>): HeaderJson {
  if (value["containerVersion"] !== 1) throw new ProfileBundleFileError("header.containerVersion must be 1");
  const semanticVersion = value["semanticVersion"];
  if (!isRecord(semanticVersion) || typeof semanticVersion["major"] !== "number" || typeof semanticVersion["minor"] !== "number") throw new ProfileBundleFileError("header.semanticVersion must be {major,minor}");
  if (typeof value["bundleId"] !== "string") throw new ProfileBundleFileError("header.bundleId must be string");
  if (value["payloadCodec"] !== PAYLOAD_CODEC) throw new ProfileBundleFileError("header.payloadCodec invalid");
  if (value["protectionSuite"] !== PROTECTION_SUITE_ID) throw new ProfileBundleFileError("header.protectionSuite invalid");
  if (typeof value["chunkSize"] !== "number") throw new ProfileBundleFileError("header.chunkSize must be number");
  if (!Array.isArray(value["keySlots"])) throw new ProfileBundleFileError("header.keySlots must be array");
  if (typeof value["frameCount"] !== "number") throw new ProfileBundleFileError("header.frameCount must be number");
  if (typeof value["totalPayloadBytes"] !== "number") throw new ProfileBundleFileError("header.totalPayloadBytes must be number");
  return { containerVersion: 1, semanticVersion: { major: semanticVersion["major"], minor: semanticVersion["minor"] }, bundleId: value["bundleId"], payloadCodec: PAYLOAD_CODEC, protectionSuite: PROTECTION_SUITE_ID, chunkSize: value["chunkSize"], keySlots: value["keySlots"].map(parseSlot), frameCount: value["frameCount"], totalPayloadBytes: value["totalPayloadBytes"] };
}
function parseSlot(value: unknown, index: number): SlotJson {
  if (!isRecord(value)) throw new ProfileBundleFileError(`keySlots[${index}] not object`);
  if (value["kind"] !== "recovery") throw new ProfileBundleFileError(`keySlots[${index}].kind must be recovery`);
  if (typeof value["slotId"] !== "number") throw new ProfileBundleFileError(`keySlots[${index}].slotId must be number`);
  if (value["kdf"] !== "argon2id") throw new ProfileBundleFileError(`keySlots[${index}].kdf must be argon2id`);
  if (!isRecord(value["kdfParams"])) throw new ProfileBundleFileError(`keySlots[${index}].kdfParams missing`);
  if (typeof value["salt"] !== "string" || typeof value["wrappedDek"] !== "string" || typeof value["aad"] !== "string") throw new ProfileBundleFileError(`keySlots[${index}] binary fields must be hex strings`);
  return { kind: "recovery", slotId: value["slotId"], kdf: "argon2id", kdfParams: value["kdfParams"] as Argon2idParams, salt: value["salt"], wrappedDek: value["wrappedDek"], aad: value["aad"] };
}
function parseFrame(value: unknown, index: number): FrameJson {
  if (!isRecord(value)) throw new ProfileBundleFileError(`frames[${index}] not object`);
  if (typeof value["ordinal"] !== "number") throw new ProfileBundleFileError(`frames[${index}].ordinal must be number`);
  if (value["kind"] !== "record" && value["kind"] !== "terminal-manifest") throw new ProfileBundleFileError(`frames[${index}].kind must be record|terminal-manifest`);
  if (typeof value["ciphertext"] !== "string" || typeof value["aad"] !== "string") throw new ProfileBundleFileError(`frames[${index}] binary fields must be hex strings`);
  return { ordinal: value["ordinal"], kind: value["kind"], ciphertext: value["ciphertext"], aad: value["aad"] };
}
function parseMedia(value: Record<string, unknown>): MediaJson {
  if (typeof value["ciphertext"] !== "string" || typeof value["nonce"] !== "string" || typeof value["aad"] !== "string") throw new ProfileBundleFileError("media binary fields must be hex strings");
  return { ciphertext: value["ciphertext"], nonce: value["nonce"], aad: value["aad"] };
}
