/**
 * Provider-neutral S3-compatible transport for sealed portable-recovery bytes.
 *
 * This module deliberately never opens a local file, invokes a subprocess, or
 * knows how recovery plaintext is made. The only bundle API is an
 * AsyncIterable passed directly to the SDK multipart uploader; download returns
 * the remote body as an AsyncIterable for the target-side container reader.
 */

import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { Readable } from "node:stream";
import {
  PORTABLE_RECOVERY_FORMAT,
  PORTABLE_RECOVERY_VERSION,
  type PortableRecoveryReceipt,
} from "./portable-recovery-container";

const MAX_DESCRIPTOR_BYTES = 16 * 1024;
const MAX_ID_BYTES = 128;
const MAX_PREFIX_BYTES = 256;
const MAX_SOURCE_RELEASE_BYTES = 256;
const MAX_ACCESS_KEY_ID_BYTES = 2 * 1024;
const MAX_SECRET_ACCESS_KEY_BYTES = 8 * 1024;
const MAX_SESSION_TOKEN_BYTES = 16 * 1024;
const BUNDLE_CONTENT_TYPE = "application/octet-stream";
const DESCRIPTOR_CONTENT_TYPE = "application/json";
const BUCKET = /^(?![0-9]+(?:\.[0-9]+){3}$)(?!.*\.\.)(?!.*\.-)(?!.*-\.)[a-z0-9](?:[a-z0-9.-]{1,61})?[a-z0-9]$/;
const PREFIX_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9!_.*'()-]{0,127}$/;
const SAFE_SOURCE_RELEASE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

export class PortableRecoveryObjectStoreError extends Error {
  public constructor(
    public readonly code:
      | "INVALID_CONFIGURATION"
      | "INVALID_IDENTITY"
      | "EXISTING_OBJECT"
      | "NOT_FOUND"
      | "INCONSISTENT_REMOTE"
      | "UPLOAD_FAILED"
      | "COMPLETION_FAILED"
      | "DOWNLOAD_FAILED",
    message: string,
  ) {
    super(message);
    this.name = "PortableRecoveryObjectStoreError";
  }
}

export interface PortableRecoveryObjectStoreConfig {
  /** Explicit S3-compatible HTTPS endpoint. */
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly prefix?: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
  /** Defaults to true because this is designed for S3-compatible stores. */
  readonly forcePathStyle?: boolean;
}

export interface PortableRecoveryObjectIdentity {
  /** A bounded opaque operation identifier. It is never inferred from the environment. */
  readonly operationId: string;
  /** A bounded opaque object identifier. It is never inferred from the environment. */
  readonly objectId: string;
}

export interface PortableRecoveryCompletionDescriptor {
  readonly format: typeof PORTABLE_RECOVERY_FORMAT;
  readonly version: typeof PORTABLE_RECOVERY_VERSION;
  readonly operationId: string;
  readonly objectId: string;
  readonly ciphertextSha256: string;
  readonly ciphertextBytes: number;
  readonly sourceReleaseId: string;
  readonly completedAt: string;
}

export interface PortableRecoveryObjectKeys {
  readonly bundleKey: string;
  readonly descriptorKey: string;
}

export interface PortableRecoveryObjectHead {
  readonly contentLength?: number;
  readonly contentType?: string;
}

export interface PortableRecoveryObjectGet {
  readonly body?: AsyncIterable<Uint8Array>;
  readonly contentLength?: number;
  readonly contentType?: string;
}

/** A small testable surface around the SDK's ordinary object commands. */
export interface PortableRecoveryObjectStorePort {
  headObject(input: { readonly bucket: string; readonly key: string }): Promise<PortableRecoveryObjectHead | undefined>;
  getObject(input: { readonly bucket: string; readonly key: string }): Promise<PortableRecoveryObjectGet | undefined>;
  putObject(input: {
    readonly bucket: string;
    readonly key: string;
    readonly body: Uint8Array;
    readonly contentType: typeof DESCRIPTOR_CONTENT_TYPE;
    readonly ifNoneMatch: "*";
  }): Promise<void>;
}

/** Multipart upload is isolated so tests never need a network client. */
export interface PortableRecoveryMultipartUpload {
  done(): Promise<void>;
}

export interface PortableRecoveryMultipartUploadFactory {
  create(input: {
    readonly bucket: string;
    readonly key: string;
    /** The original container iterable: never aggregated or copied by this module. */
    readonly body: AsyncIterable<Uint8Array>;
    readonly contentType: typeof BUNDLE_CONTENT_TYPE;
  }): PortableRecoveryMultipartUpload;
}

export interface PortableRecoveryObjectStorePorts {
  readonly objectStore: PortableRecoveryObjectStorePort;
  readonly multipartUpload: PortableRecoveryMultipartUploadFactory;
}

export interface PublishPortableRecoveryInput {
  readonly identity: PortableRecoveryObjectIdentity;
  /** Passed to the multipart SDK untouched; completion must resolve after it reaches EOF. */
  readonly bundle: AsyncIterable<Uint8Array>;
  readonly receipt: Promise<PortableRecoveryReceipt>;
  readonly sourceReleaseId: string;
  readonly completedAt?: Date;
}

export type PortableRecoveryObservation =
  | { readonly state: "not-found" }
  | { readonly state: "inconsistent" }
  | { readonly state: "complete"; readonly descriptor: PortableRecoveryCompletionDescriptor };

function error(code: PortableRecoveryObjectStoreError["code"], message: string): PortableRecoveryObjectStoreError {
  return new PortableRecoveryObjectStoreError(code, message);
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<Uint8Array> {
  return typeof value === "object" && value !== null && Symbol.asyncIterator in value && typeof (value as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] === "function";
}

function isSafeOpaqueId(value: unknown): value is string {
  return typeof value === "string"
    && byteLength(value) >= 1
    && byteLength(value) <= MAX_ID_BYTES
    && value !== "."
    && value !== ".."
    && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}

function assertIdentity(identity: PortableRecoveryObjectIdentity): void {
  if (!isSafeOpaqueId(identity.operationId) || !isSafeOpaqueId(identity.objectId)) {
    throw error("INVALID_IDENTITY", "recovery object identity is invalid");
  }
}

function normalizePrefix(value: string | undefined): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (byteLength(value) > MAX_PREFIX_BYTES || value.startsWith("/") || value.endsWith("/")) {
    throw error("INVALID_CONFIGURATION", "recovery object prefix is invalid");
  }
  const segments = value.split("/");
  if (segments.some((segment) => !PREFIX_SEGMENT.test(segment))) {
    throw error("INVALID_CONFIGURATION", "recovery object prefix is invalid");
  }
  return value;
}

function assertBoundedOpaque(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && byteLength(value) <= MAX_SOURCE_RELEASE_BYTES
    && SAFE_SOURCE_RELEASE_ID.test(value);
}

function normalizeConfig(config: PortableRecoveryObjectStoreConfig): PortableRecoveryObjectStoreConfig {
  let endpoint: URL;
  try {
    endpoint = new URL(config.endpoint);
  } catch {
    throw error("INVALID_CONFIGURATION", "recovery object endpoint is invalid");
  }
  if (endpoint.protocol !== "https:" || endpoint.username !== "" || endpoint.password !== "" || endpoint.search !== "" || endpoint.hash !== "" || endpoint.hostname.length === 0 || (endpoint.pathname !== "" && endpoint.pathname !== "/")) {
    throw error("INVALID_CONFIGURATION", "recovery object endpoint is invalid");
  }
  if (typeof config.region !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(config.region)) {
    throw error("INVALID_CONFIGURATION", "recovery object region is invalid");
  }
  // Permit conventional bucket names only; opaque hostnames and path traversal
  // never become part of a remotely-addressed object identity.
  if (typeof config.bucket !== "string" || !BUCKET.test(config.bucket)) {
    throw error("INVALID_CONFIGURATION", "recovery object bucket is invalid");
  }
  if (typeof config.accessKeyId !== "string" || byteLength(config.accessKeyId) === 0 || byteLength(config.accessKeyId) > MAX_ACCESS_KEY_ID_BYTES || typeof config.secretAccessKey !== "string" || byteLength(config.secretAccessKey) === 0 || byteLength(config.secretAccessKey) > MAX_SECRET_ACCESS_KEY_BYTES) {
    throw error("INVALID_CONFIGURATION", "recovery object credentials are invalid");
  }
  if (config.sessionToken !== undefined && (typeof config.sessionToken !== "string" || byteLength(config.sessionToken) === 0 || byteLength(config.sessionToken) > MAX_SESSION_TOKEN_BYTES)) {
    throw error("INVALID_CONFIGURATION", "recovery object credentials are invalid");
  }
  if (config.forcePathStyle !== undefined && typeof config.forcePathStyle !== "boolean") {
    throw error("INVALID_CONFIGURATION", "recovery object path style is invalid");
  }
  const prefix = normalizePrefix(config.prefix);
  return Object.freeze({
    endpoint: endpoint.toString(),
    region: config.region,
    bucket: config.bucket,
    ...(prefix === undefined ? {} : { prefix }),
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    ...(config.sessionToken === undefined ? {} : { sessionToken: config.sessionToken }),
    forcePathStyle: config.forcePathStyle ?? true,
  });
}

function objectKeys(config: PortableRecoveryObjectStoreConfig, identity: PortableRecoveryObjectIdentity): PortableRecoveryObjectKeys {
  assertIdentity(identity);
  const prefix = normalizePrefix(config.prefix);
  const root = [prefix, PORTABLE_RECOVERY_FORMAT, identity.operationId, identity.objectId].filter((part): part is string => part !== undefined).join("/");
  return { bundleKey: `${root}.bundle`, descriptorKey: `${root}.complete.json` };
}

function isExactSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isExactTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function validateReceipt(receipt: PortableRecoveryReceipt): void {
  if (!isExactSha256(receipt.ciphertextSha256) || !Number.isSafeInteger(receipt.ciphertextBytes) || receipt.ciphertextBytes < 1) {
    throw error("COMPLETION_FAILED", "portable recovery receipt is invalid");
  }
}

function parseDescriptor(bytes: Uint8Array, identity: PortableRecoveryObjectIdentity): PortableRecoveryCompletionDescriptor {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_DESCRIPTOR_BYTES) throw error("INCONSISTENT_REMOTE", "remote completion descriptor is invalid");
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw error("INCONSISTENT_REMOTE", "remote completion descriptor is invalid");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw error("INCONSISTENT_REMOTE", "remote completion descriptor is invalid");
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expected = ["ciphertextBytes", "ciphertextSha256", "completedAt", "format", "objectId", "operationId", "sourceReleaseId", "version"];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) throw error("INCONSISTENT_REMOTE", "remote completion descriptor is invalid");
  if (
    record["format"] !== PORTABLE_RECOVERY_FORMAT
    || record["version"] !== PORTABLE_RECOVERY_VERSION
    || record["operationId"] !== identity.operationId
    || record["objectId"] !== identity.objectId
    || !isExactSha256(record["ciphertextSha256"])
    || !Number.isSafeInteger(record["ciphertextBytes"])
    || (record["ciphertextBytes"] as number) < 1
    || !assertBoundedOpaque(record["sourceReleaseId"])
    || !isExactTimestamp(record["completedAt"])
  ) {
    throw error("INCONSISTENT_REMOTE", "remote completion descriptor is invalid");
  }
  const descriptor: PortableRecoveryCompletionDescriptor = {
    format: PORTABLE_RECOVERY_FORMAT,
    version: PORTABLE_RECOVERY_VERSION,
    operationId: identity.operationId,
    objectId: identity.objectId,
    ciphertextSha256: record["ciphertextSha256"],
    ciphertextBytes: record["ciphertextBytes"] as number,
    sourceReleaseId: record["sourceReleaseId"],
    completedAt: record["completedAt"],
  };
  // Reject duplicate JSON members, noncanonical ordering, and ignorable
  // whitespace rather than silently normalizing a remotely supplied receipt.
  const canonical = descriptorBytes(descriptor);
  if (canonical.byteLength !== bytes.byteLength || canonical.some((byte, index) => byte !== bytes[index])) {
    throw error("INCONSISTENT_REMOTE", "remote completion descriptor is invalid");
  }
  return descriptor;
}

async function readBoundedBody(body: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let length = 0;
  try {
    for await (const chunk of body) {
      if (!(chunk instanceof Uint8Array) || chunk.byteLength > MAX_DESCRIPTOR_BYTES - length) {
        throw error("INCONSISTENT_REMOTE", "remote completion descriptor is invalid");
      }
      parts.push(chunk);
      length += chunk.byteLength;
    }
  } catch (cause) {
    if (cause instanceof PortableRecoveryObjectStoreError) throw cause;
    throw error("INCONSISTENT_REMOTE", "remote completion descriptor is unreadable");
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of parts) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function descriptorBytes(descriptor: PortableRecoveryCompletionDescriptor): Uint8Array {
  // Deliberately fixed property order: the completion descriptor is a tiny,
  // auditable protocol record rather than an open-ended JSON document.
  return new TextEncoder().encode(JSON.stringify({
    format: descriptor.format,
    version: descriptor.version,
    operationId: descriptor.operationId,
    objectId: descriptor.objectId,
    ciphertextSha256: descriptor.ciphertextSha256,
    ciphertextBytes: descriptor.ciphertextBytes,
    sourceReleaseId: descriptor.sourceReleaseId,
    completedAt: descriptor.completedAt,
  }));
}

function verifyHead(head: PortableRecoveryObjectHead | undefined, expectedBytes: number): void {
  if (head === undefined || head.contentType !== BUNDLE_CONTENT_TYPE || !Number.isSafeInteger(head.contentLength) || head.contentLength !== expectedBytes) {
    throw error("INCONSISTENT_REMOTE", "remote recovery bundle does not match completion descriptor");
  }
}

function operationError(code: "UPLOAD_FAILED" | "COMPLETION_FAILED" | "DOWNLOAD_FAILED"): PortableRecoveryObjectStoreError {
  return error(code, "recovery object store operation failed");
}

export class PortableRecoveryObjectStore {
  private readonly config: PortableRecoveryObjectStoreConfig;

  public constructor(
    config: PortableRecoveryObjectStoreConfig,
    private readonly ports: PortableRecoveryObjectStorePorts,
  ) {
    this.config = normalizeConfig(config);
  }

  public keys(identity: PortableRecoveryObjectIdentity): PortableRecoveryObjectKeys {
    return objectKeys(this.config, identity);
  }

  /** Read-only resume observation. It never creates, deletes, or mutates objects. */
  public async observe(identity: PortableRecoveryObjectIdentity): Promise<PortableRecoveryObservation> {
    const stableIdentity = Object.freeze({ operationId: identity.operationId, objectId: identity.objectId });
    const keys = this.keys(stableIdentity);
    let bundleHead: PortableRecoveryObjectHead | undefined;
    let descriptorHead: PortableRecoveryObjectHead | undefined;
    try {
      bundleHead = await this.ports.objectStore.headObject({ bucket: this.config.bucket, key: keys.bundleKey });
      descriptorHead = await this.ports.objectStore.headObject({ bucket: this.config.bucket, key: keys.descriptorKey });
    } catch {
      throw operationError("DOWNLOAD_FAILED");
    }
    if (bundleHead === undefined && descriptorHead === undefined) return { state: "not-found" };
    if (bundleHead === undefined || descriptorHead === undefined || descriptorHead.contentType !== DESCRIPTOR_CONTENT_TYPE) return { state: "inconsistent" };

    let descriptorGet: PortableRecoveryObjectGet | undefined;
    try {
      descriptorGet = await this.ports.objectStore.getObject({ bucket: this.config.bucket, key: keys.descriptorKey });
    } catch {
      throw operationError("DOWNLOAD_FAILED");
    }
    const descriptorContentLength = descriptorGet?.contentLength;
    const descriptorLength = typeof descriptorContentLength === "number" ? descriptorContentLength : -1;
    const descriptorBody = descriptorGet?.body;
    if (
      descriptorGet === undefined
      || descriptorGet.contentType !== DESCRIPTOR_CONTENT_TYPE
      || !Number.isSafeInteger(descriptorLength)
      || descriptorLength < 1
      || descriptorLength > MAX_DESCRIPTOR_BYTES
      || !isAsyncIterable(descriptorBody)
    ) return { state: "inconsistent" };
    const expectedDescriptorLength = descriptorLength;
    let descriptor: PortableRecoveryCompletionDescriptor;
    try {
      const bytes = await readBoundedBody(descriptorBody);
      if (bytes.byteLength !== expectedDescriptorLength) return { state: "inconsistent" };
      descriptor = parseDescriptor(bytes, stableIdentity);
      verifyHead(bundleHead, descriptor.ciphertextBytes);
    } catch (cause) {
      if (cause instanceof PortableRecoveryObjectStoreError && cause.code === "INCONSISTENT_REMOTE") return { state: "inconsistent" };
      throw operationError("DOWNLOAD_FAILED");
    }
    return { state: "complete", descriptor };
  }

  /**
   * Publish container bytes and then, only after a matching HEAD, atomically
   * publish the completion descriptor. No code may treat the bundle as usable
   * until the descriptor survives the final GET and bundle HEAD observation.
   */
  public async publish(input: PublishPortableRecoveryInput): Promise<PortableRecoveryCompletionDescriptor> {
    // Snapshot every caller-owned value before the first await. This prevents a
    // mutable request object from changing remote identity or receipt authority
    // after preflight has begun.
    const identity = Object.freeze({ operationId: input.identity.operationId, objectId: input.identity.objectId });
    const bundle = input.bundle;
    const receiptPromise = input.receipt;
    const sourceReleaseId = input.sourceReleaseId;
    const completedAt = input.completedAt ?? new Date();
    const keys = this.keys(identity);
    if (!isAsyncIterable(bundle) || !assertBoundedOpaque(sourceReleaseId)) {
      throw error("INVALID_IDENTITY", "portable recovery publish input is invalid");
    }
    if (!(completedAt instanceof Date) || Number.isNaN(completedAt.getTime())) throw error("INVALID_IDENTITY", "portable recovery completion time is invalid");
    const completedAtText = completedAt.toISOString();
    let bundleHead: PortableRecoveryObjectHead | undefined;
    let descriptorHead: PortableRecoveryObjectHead | undefined;
    try {
      bundleHead = await this.ports.objectStore.headObject({ bucket: this.config.bucket, key: keys.bundleKey });
      descriptorHead = await this.ports.objectStore.headObject({ bucket: this.config.bucket, key: keys.descriptorKey });
    } catch {
      throw operationError("UPLOAD_FAILED");
    }
    if (bundleHead !== undefined || descriptorHead !== undefined) {
      throw error("EXISTING_OBJECT", "portable recovery object identity is already occupied");
    }

    try {
      // Do not wrap `bundle`: preserving its identity proves this layer
      // cannot accidentally aggregate or replay recovery ciphertext in memory.
      await this.ports.multipartUpload.create({
        bucket: this.config.bucket,
        key: keys.bundleKey,
        body: bundle,
        contentType: BUNDLE_CONTENT_TYPE,
      }).done();
    } catch {
      throw operationError("UPLOAD_FAILED");
    }
    let receipt: PortableRecoveryReceipt;
    try {
      receipt = await receiptPromise;
      validateReceipt(receipt);
      bundleHead = await this.ports.objectStore.headObject({ bucket: this.config.bucket, key: keys.bundleKey });
      verifyHead(bundleHead, receipt.ciphertextBytes);
    } catch (cause) {
      if (cause instanceof PortableRecoveryObjectStoreError) throw cause;
      throw operationError("COMPLETION_FAILED");
    }
    const descriptor: PortableRecoveryCompletionDescriptor = {
      format: PORTABLE_RECOVERY_FORMAT,
      version: PORTABLE_RECOVERY_VERSION,
      operationId: identity.operationId,
      objectId: identity.objectId,
      ciphertextSha256: receipt.ciphertextSha256,
      ciphertextBytes: receipt.ciphertextBytes,
      sourceReleaseId,
      completedAt: completedAtText,
    };
    try {
      await this.ports.objectStore.putObject({
        bucket: this.config.bucket,
        key: keys.descriptorKey,
        body: descriptorBytes(descriptor),
        contentType: DESCRIPTOR_CONTENT_TYPE,
        ifNoneMatch: "*",
      });
    } catch {
      throw operationError("COMPLETION_FAILED");
    }
    const observed = await this.observe(identity);
    if (observed.state !== "complete" || observed.descriptor.ciphertextSha256 !== descriptor.ciphertextSha256 || observed.descriptor.sourceReleaseId !== descriptor.sourceReleaseId) {
      throw error("COMPLETION_FAILED", "portable recovery completion could not be verified");
    }
    return Object.freeze({ ...observed.descriptor });
  }

  /** Returns the exact remote body only after the descriptor and bundle agree. */
  public async download(identity: PortableRecoveryObjectIdentity): Promise<{ readonly descriptor: PortableRecoveryCompletionDescriptor; readonly body: AsyncIterable<Uint8Array> }> {
    const stableIdentity = Object.freeze({ operationId: identity.operationId, objectId: identity.objectId });
    const observation = await this.observe(stableIdentity);
    if (observation.state === "not-found") throw error("NOT_FOUND", "portable recovery object was not found");
    if (observation.state !== "complete") throw error("INCONSISTENT_REMOTE", "portable recovery object is incomplete or inconsistent");
    const keys = this.keys(stableIdentity);
    let result: PortableRecoveryObjectGet | undefined;
    try {
      result = await this.ports.objectStore.getObject({ bucket: this.config.bucket, key: keys.bundleKey });
    } catch {
      throw operationError("DOWNLOAD_FAILED");
    }
    if (result === undefined || result.contentType !== BUNDLE_CONTENT_TYPE || result.contentLength !== observation.descriptor.ciphertextBytes || !isAsyncIterable(result.body)) {
      throw error("INCONSISTENT_REMOTE", "remote recovery bundle does not match completion descriptor");
    }
    return { descriptor: Object.freeze({ ...observation.descriptor }), body: result.body };
  }
}

class S3CompatibleObjectStorePort implements PortableRecoveryObjectStorePort {
  public constructor(private readonly client: S3Client) {}

  public async headObject(input: { readonly bucket: string; readonly key: string }): Promise<PortableRecoveryObjectHead | undefined> {
    try {
      const result = await this.client.send(new HeadObjectCommand({ Bucket: input.bucket, Key: input.key }));
      return {
        ...(result.ContentLength === undefined ? {} : { contentLength: result.ContentLength }),
        ...(result.ContentType === undefined ? {} : { contentType: result.ContentType }),
      };
    } catch (cause) {
      if (isObjectNotFound(cause)) return undefined;
      throw cause;
    }
  }

  public async getObject(input: { readonly bucket: string; readonly key: string }): Promise<PortableRecoveryObjectGet | undefined> {
    try {
      const result = await this.client.send(new GetObjectCommand({ Bucket: input.bucket, Key: input.key }));
      if (!isAsyncIterable(result.Body)) throw error("DOWNLOAD_FAILED", "recovery object store operation failed");
      return {
        body: result.Body,
        ...(result.ContentLength === undefined ? {} : { contentLength: result.ContentLength }),
        ...(result.ContentType === undefined ? {} : { contentType: result.ContentType }),
      };
    } catch (cause) {
      if (cause instanceof PortableRecoveryObjectStoreError) throw cause;
      if (isObjectNotFound(cause)) return undefined;
      throw cause;
    }
  }

  public async putObject(input: {
    readonly bucket: string;
    readonly key: string;
    readonly body: Uint8Array;
    readonly contentType: typeof DESCRIPTOR_CONTENT_TYPE;
    readonly ifNoneMatch: "*";
  }): Promise<void> {
    await this.client.send(new PutObjectCommand({
      Bucket: input.bucket,
      Key: input.key,
      Body: input.body,
      ContentType: input.contentType,
      IfNoneMatch: input.ifNoneMatch,
    }));
  }
}

class AwsSdkMultipartUploadFactory implements PortableRecoveryMultipartUploadFactory {
  public constructor(private readonly client: S3Client) {}

  public create(input: {
    readonly bucket: string;
    readonly key: string;
    readonly body: AsyncIterable<Uint8Array>;
    readonly contentType: typeof BUNDLE_CONTENT_TYPE;
  }): PortableRecoveryMultipartUpload {
    const upload = new Upload({
      client: this.client,
      // `Readable.from()` is the SDK-supported representation of the same
      // AsyncIterable. It remains streaming and backpressured; no ciphertext
      // is collected or replayed in this adapter.
      params: { Bucket: input.bucket, Key: input.key, Body: Readable.from(input.body), ContentType: input.contentType },
      queueSize: 1,
      leavePartsOnError: false,
    });
    return { done: async () => { await upload.done(); } };
  }
}

function isObjectNotFound(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const record = value as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  return record.name === "NotFound" || record.name === "NoSuchKey" || record.name === "NotFoundException" || record.$metadata?.httpStatusCode === 404;
}

/** Construct the real S3-compatible transport. Credentials remain in request memory. */
export function createS3CompatiblePortableRecoveryObjectStore(config: PortableRecoveryObjectStoreConfig): PortableRecoveryObjectStore {
  const normalized = normalizeConfig(config);
  const endpoint = normalized.endpoint;
  const forcePathStyle = normalized.forcePathStyle ?? true;
  const clientConfig: S3ClientConfig = {
    endpoint,
    region: normalized.region,
    forcePathStyle,
    credentials: {
      accessKeyId: normalized.accessKeyId,
      secretAccessKey: normalized.secretAccessKey,
      ...(normalized.sessionToken === undefined ? {} : { sessionToken: normalized.sessionToken }),
    },
  };
  const client = new S3Client(clientConfig);
  return new PortableRecoveryObjectStore(normalized, {
    objectStore: new S3CompatibleObjectStorePort(client),
    multipartUpload: new AwsSdkMultipartUploadFactory(client),
  });
}
