import {
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import type {
  PortableRecoveryDescriptor,
  RailwayPortableMaintenanceDescriptorProbe,
} from "@nautilo/railway-hosting";

const FORMAT = "nautilo-recovery-v1";
const VERSION = 1;
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
const SOURCE_RELEASE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SHA256 = /^[a-f0-9]{64}$/;

export class RailwayPortableMaintenanceDescriptorProbeError extends Error {
  constructor() {
    super("Railway portable maintenance descriptor probe failed");
    this.name = "RailwayPortableMaintenanceDescriptorProbeError";
  }
}

export interface RailwayPortableDescriptorObjectHead {
  readonly contentLength?: number | undefined;
  readonly contentType?: string | undefined;
}

export interface RailwayPortableDescriptorObjectGet extends RailwayPortableDescriptorObjectHead {
  readonly body?: AsyncIterable<Uint8Array> | undefined;
}

export interface RailwayPortableDescriptorObjectPort {
  readonly headObject: (input: { readonly bucket: string; readonly key: string }, signal?: AbortSignal) => Promise<RailwayPortableDescriptorObjectHead | undefined>;
  readonly getObject: (input: { readonly bucket: string; readonly key: string }, signal?: AbortSignal) => Promise<RailwayPortableDescriptorObjectGet | undefined>;
}

export interface RailwayPortableDescriptorObjectPortFactory {
  readonly create: (input: {
    readonly endpoint: string;
    readonly region: string;
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
    readonly sessionToken?: string | undefined;
  }) => RailwayPortableDescriptorObjectPort;
}

function fail(): never {
  throw new RailwayPortableMaintenanceDescriptorProbeError();
}

function bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function safeId(value: string): boolean {
  return bytes(value) >= 1 && bytes(value) <= MAX_ID_BYTES && value !== "." && value !== ".."
    && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}

function validPrefix(value: string): boolean {
  return value === "" || (bytes(value) <= MAX_PREFIX_BYTES && !value.startsWith("/") && !value.endsWith("/")
    && value.split("/").every((segment) => PREFIX_SEGMENT.test(segment)));
}

function validTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function validSourceRelease(value: unknown): value is string {
  return typeof value === "string" && bytes(value) >= 1 && bytes(value) <= MAX_SOURCE_RELEASE_BYTES && SOURCE_RELEASE.test(value);
}

function snapshot(input: Parameters<RailwayPortableMaintenanceDescriptorProbe["observe"]>[0]) {
  const stable = {
    operationId: `${input.operationId}`,
    objectId: `${input.objectId}`,
    endpoint: `${input.authority.endpoint}`,
    region: `${input.authority.region}`,
    bucket: `${input.authority.bucket}`,
    accessKeyId: `${input.authority.accessKeyId}`,
    secretAccessKey: `${input.authority.secretAccessKey}`,
    prefix: `${input.prefix}`,
    ...(input.sessionToken === undefined ? {} : { sessionToken: `${input.sessionToken}` }),
  };
  let endpoint: URL;
  try { endpoint = new URL(stable.endpoint); } catch { return fail(); }
  if (endpoint.protocol !== "https:" || endpoint.username !== "" || endpoint.password !== ""
    || endpoint.search !== "" || endpoint.hash !== "" || endpoint.hostname === ""
    || (endpoint.pathname !== "" && endpoint.pathname !== "/")
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(stable.region) || !BUCKET.test(stable.bucket)
    || !safeId(stable.operationId) || !safeId(stable.objectId) || !validPrefix(stable.prefix)
    || bytes(stable.accessKeyId) < 1 || bytes(stable.accessKeyId) > MAX_ACCESS_KEY_ID_BYTES
    || bytes(stable.secretAccessKey) < 1 || bytes(stable.secretAccessKey) > MAX_SECRET_ACCESS_KEY_BYTES
    || (stable.sessionToken !== undefined && (bytes(stable.sessionToken) < 1 || bytes(stable.sessionToken) > MAX_SESSION_TOKEN_BYTES))) fail();
  return Object.freeze({ ...stable, endpoint: endpoint.toString() });
}

function isAsyncIterable(value: unknown): value is AsyncIterable<Uint8Array> {
  return typeof value === "object" && value !== null && Symbol.asyncIterator in value
    && typeof (value as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] === "function";
}

async function readBody(body: AsyncIterable<Uint8Array>): Promise<Uint8Array | undefined> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for await (const chunk of body) {
      if (!(chunk instanceof Uint8Array) || chunk.byteLength > MAX_DESCRIPTOR_BYTES - length) return undefined;
      chunks.push(chunk);
      length += chunk.byteLength;
    }
  } catch { return undefined; }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

function canonicalBytes(descriptor: PortableRecoveryDescriptor): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    format: FORMAT,
    version: VERSION,
    operationId: descriptor.operationId,
    objectId: descriptor.objectId,
    ciphertextSha256: descriptor.ciphertextSha256,
    ciphertextBytes: descriptor.ciphertextBytes,
    sourceReleaseId: descriptor.sourceReleaseId,
    completedAt: descriptor.completedAt,
  }));
}

function parseDescriptor(body: Uint8Array, operationId: string, objectId: string): PortableRecoveryDescriptor | undefined {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)); } catch { return undefined; }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = ["ciphertextBytes", "ciphertextSha256", "completedAt", "format", "objectId", "operationId", "sourceReleaseId", "version"];
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])
    || record["format"] !== FORMAT || record["version"] !== VERSION
    || record["operationId"] !== operationId || record["objectId"] !== objectId
    || typeof record["ciphertextSha256"] !== "string" || !SHA256.test(record["ciphertextSha256"])
    || !Number.isSafeInteger(record["ciphertextBytes"]) || (record["ciphertextBytes"] as number) < 1
    || !validSourceRelease(record["sourceReleaseId"]) || !validTimestamp(record["completedAt"])) return undefined;
  const descriptor: PortableRecoveryDescriptor = {
    operationId,
    objectId,
    ciphertextSha256: record["ciphertextSha256"],
    ciphertextBytes: record["ciphertextBytes"] as number,
    sourceReleaseId: record["sourceReleaseId"],
    completedAt: record["completedAt"],
  };
  const canonical = canonicalBytes(descriptor);
  return canonical.byteLength === body.byteLength && canonical.every((byte, index) => byte === body[index])
    ? Object.freeze(descriptor) : undefined;
}

function notFound(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const record = error as { readonly name?: unknown; readonly $metadata?: { readonly httpStatusCode?: unknown } };
  return record.name === "NotFound" || record.name === "NoSuchKey" || record.name === "NotFoundException"
    || record.$metadata?.httpStatusCode === 404;
}

class AwsS3DescriptorPort implements RailwayPortableDescriptorObjectPort {
  constructor(private readonly client: S3Client) {}
  async headObject(input: { readonly bucket: string; readonly key: string }, signal?: AbortSignal): Promise<RailwayPortableDescriptorObjectHead | undefined> {
    try {
      const result = await this.client.send(new HeadObjectCommand({ Bucket: input.bucket, Key: input.key }),
        signal === undefined ? undefined : { abortSignal: signal });
      return { ...(result.ContentLength === undefined ? {} : { contentLength: result.ContentLength }),
        ...(result.ContentType === undefined ? {} : { contentType: result.ContentType }) };
    } catch (error) { if (notFound(error)) return undefined; return fail(); }
  }
  async getObject(input: { readonly bucket: string; readonly key: string }, signal?: AbortSignal): Promise<RailwayPortableDescriptorObjectGet | undefined> {
    try {
      const result = await this.client.send(new GetObjectCommand({ Bucket: input.bucket, Key: input.key }),
        signal === undefined ? undefined : { abortSignal: signal });
      return { ...(isAsyncIterable(result.Body) ? { body: result.Body } : {}),
        ...(result.ContentLength === undefined ? {} : { contentLength: result.ContentLength }),
        ...(result.ContentType === undefined ? {} : { contentType: result.ContentType }) };
    } catch (error) { if (notFound(error)) return undefined; return fail(); }
  }
}

const awsFactory: RailwayPortableDescriptorObjectPortFactory = {
  create(input) {
    const config: S3ClientConfig = {
      endpoint: input.endpoint,
      region: input.region,
      forcePathStyle: true,
      credentials: { accessKeyId: input.accessKeyId, secretAccessKey: input.secretAccessKey,
        ...(input.sessionToken === undefined ? {} : { sessionToken: input.sessionToken }) },
    };
    return new AwsS3DescriptorPort(new S3Client(config));
  },
};

/** Read-only S3 completion proof. It never requests portable bundle bytes. */
export class S3RailwayPortableMaintenanceDescriptorProbe implements RailwayPortableMaintenanceDescriptorProbe {
  readonly #create: RailwayPortableDescriptorObjectPortFactory["create"];
  constructor(factory: RailwayPortableDescriptorObjectPortFactory = awsFactory) { this.#create = factory.create.bind(factory); }

  async observe(input: Parameters<RailwayPortableMaintenanceDescriptorProbe["observe"]>[0], signal?: AbortSignal): ReturnType<RailwayPortableMaintenanceDescriptorProbe["observe"]> {
    const stable = snapshot(input);
    const root = [stable.prefix || undefined, FORMAT, stable.operationId, stable.objectId].filter((value): value is string => value !== undefined).join("/");
    const bundleKey = `${root}.bundle`;
    const descriptorKey = `${root}.complete.json`;
    let port: RailwayPortableDescriptorObjectPort;
    try { port = this.#create({ endpoint: stable.endpoint, region: stable.region, accessKeyId: stable.accessKeyId,
      secretAccessKey: stable.secretAccessKey, ...(stable.sessionToken === undefined ? {} : { sessionToken: stable.sessionToken }) }); }
    catch { return fail(); }
    let bundle: RailwayPortableDescriptorObjectHead | undefined;
    let descriptorHead: RailwayPortableDescriptorObjectHead | undefined;
    try {
      bundle = await port.headObject({ bucket: stable.bucket, key: bundleKey }, signal);
      descriptorHead = await port.headObject({ bucket: stable.bucket, key: descriptorKey }, signal);
    } catch { return fail(); }
    if (bundle === undefined && descriptorHead === undefined) return { state: "not-found" };
    if (bundle === undefined || descriptorHead === undefined || descriptorHead.contentType !== DESCRIPTOR_CONTENT_TYPE) return { state: "inconsistent" };
    let object: RailwayPortableDescriptorObjectGet | undefined;
    try { object = await port.getObject({ bucket: stable.bucket, key: descriptorKey }, signal); } catch { return fail(); }
    if (object === undefined || object.contentType !== DESCRIPTOR_CONTENT_TYPE || !Number.isSafeInteger(object.contentLength)
      || object.contentLength! < 1 || object.contentLength! > MAX_DESCRIPTOR_BYTES || !isAsyncIterable(object.body)) return { state: "inconsistent" };
    const body = await readBody(object.body);
    if (body === undefined || body.byteLength !== object.contentLength) return { state: "inconsistent" };
    const descriptor = parseDescriptor(body, stable.operationId, stable.objectId);
    if (descriptor === undefined || bundle.contentType !== BUNDLE_CONTENT_TYPE || !Number.isSafeInteger(bundle.contentLength)
      || bundle.contentLength !== descriptor.ciphertextBytes) return { state: "inconsistent" };
    return { state: "complete", descriptor };
  }
}
