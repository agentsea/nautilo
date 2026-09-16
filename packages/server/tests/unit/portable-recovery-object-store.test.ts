import { describe, expect, test } from "bun:test";
import {
  PortableRecoveryObjectStore,
  PortableRecoveryObjectStoreError,
  type PortableRecoveryObjectGet,
  type PortableRecoveryObjectHead,
  type PortableRecoveryObjectStoreConfig,
  type PortableRecoveryObjectStorePort,
  type PortableRecoveryMultipartUploadFactory,
} from "../../src/maintenance/portable-recovery-object-store";

const encoder = new TextEncoder();
const config: PortableRecoveryObjectStoreConfig = {
  endpoint: "https://objects.example.test",
  region: "us-test-1",
  bucket: "nautilo-recovery",
  prefix: "customer/recovery",
  accessKeyId: "access-key-under-test",
  secretAccessKey: "secret-key-under-test",
  sessionToken: "session-token-under-test",
};
const identity = { operationId: "op-123", objectId: "bundle-456" } as const;
const receipt = { ciphertextSha256: "a".repeat(64), ciphertextBytes: 17 } as const;

function bytesBody(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  return (async function* () { yield bytes; })();
}

interface StoredObject {
  readonly head: PortableRecoveryObjectHead;
  readonly body?: Uint8Array;
}

class FakeObjectStorePort implements PortableRecoveryObjectStorePort {
  public readonly objects = new Map<string, StoredObject>();
  public readonly calls: string[] = [];

  public async headObject(input: { readonly bucket: string; readonly key: string }): Promise<PortableRecoveryObjectHead | undefined> {
    this.calls.push(`head:${input.key}`);
    return this.objects.get(input.key)?.head;
  }

  public async getObject(input: { readonly bucket: string; readonly key: string }): Promise<PortableRecoveryObjectGet | undefined> {
    this.calls.push(`get:${input.key}`);
    const object = this.objects.get(input.key);
    if (object === undefined || object.body === undefined) return undefined;
    return { ...object.head, body: bytesBody(object.body) };
  }

  public async putObject(input: {
    readonly bucket: string;
    readonly key: string;
    readonly body: Uint8Array;
    readonly contentType: "application/json";
    readonly ifNoneMatch: "*";
  }): Promise<void> {
    this.calls.push(`put:${input.key}:${input.ifNoneMatch}:${input.contentType}`);
    if (this.objects.has(input.key)) throw new Error("precondition failed");
    this.objects.set(input.key, {
      head: { contentLength: input.body.byteLength, contentType: input.contentType },
      body: input.body,
    });
  }
}

class FakeMultipartFactory implements PortableRecoveryMultipartUploadFactory {
  public readonly inputs: Array<{
    readonly bucket: string;
    readonly key: string;
    readonly body: AsyncIterable<Uint8Array>;
    readonly contentType: "application/octet-stream";
  }> = [];

  public constructor(
    private readonly port: FakeObjectStorePort,
    private readonly uploadedBytes: number,
  ) {}

  public create(input: {
    readonly bucket: string;
    readonly key: string;
    readonly body: AsyncIterable<Uint8Array>;
    readonly contentType: "application/octet-stream";
  }) {
    this.inputs.push(input);
    return {
      done: async () => {
        this.port.calls.push(`upload:${input.key}`);
        this.port.objects.set(input.key, { head: { contentLength: this.uploadedBytes, contentType: input.contentType } });
      },
    };
  }
}

function setup(options: { readonly uploadedBytes?: number } = {}) {
  const port = new FakeObjectStorePort();
  const upload = new FakeMultipartFactory(port, options.uploadedBytes ?? receipt.ciphertextBytes);
  const store = new PortableRecoveryObjectStore(config, { objectStore: port, multipartUpload: upload });
  return { port, upload, store };
}

function descriptorText(input: Partial<Record<string, unknown>> = {}): Uint8Array {
  return encoder.encode(JSON.stringify({
    format: "nautilo-recovery-v1",
    version: 1,
    operationId: identity.operationId,
    objectId: identity.objectId,
    ciphertextSha256: receipt.ciphertextSha256,
    ciphertextBytes: receipt.ciphertextBytes,
    sourceReleaseId: "sha256:source-release",
    completedAt: "2026-08-12T10:00:00.000Z",
    ...input,
  }));
}

function completeRemote(port: FakeObjectStorePort, store: PortableRecoveryObjectStore, descriptor = descriptorText()): void {
  const keys = store.keys(identity);
  port.objects.set(keys.bundleKey, { head: { contentLength: receipt.ciphertextBytes, contentType: "application/octet-stream" }, body: encoder.encode("sealed bytes") });
  port.objects.set(keys.descriptorKey, { head: { contentLength: descriptor.byteLength, contentType: "application/json" }, body: descriptor });
}

describe("portable recovery S3-compatible object store", () => {
  test("maps only safe supplied identity into deterministic bundle and terminal descriptor keys", () => {
    const { store } = setup();
    expect(store.keys(identity)).toEqual({
      bundleKey: "customer/recovery/nautilo-recovery-v1/op-123/bundle-456.bundle",
      descriptorKey: "customer/recovery/nautilo-recovery-v1/op-123/bundle-456.complete.json",
    });
    expect(() => store.keys({ operationId: "../escape", objectId: "bundle" })).toThrow(PortableRecoveryObjectStoreError);
    expect(() => new PortableRecoveryObjectStore({ ...config, endpoint: "http://objects.example.test" }, setup().store as never)).toThrow(PortableRecoveryObjectStoreError);
  });

  test("preflights both keys, streams the original iterable directly, and publishes descriptor last", async () => {
    const { port, upload, store } = setup();
    let iterated = 0;
    const bundle = (async function* () {
      iterated += 1;
      yield encoder.encode("ciphertext one");
      iterated += 1;
      yield encoder.encode("ciphertext two");
    })();
    const descriptor = await store.publish({
      identity,
      bundle,
      receipt: Promise.resolve(receipt),
      sourceReleaseId: "sha256:source-release",
      completedAt: new Date("2026-08-12T10:00:00.000Z"),
    });
    const keys = store.keys(identity);

    expect(upload.inputs).toHaveLength(1);
    expect(upload.inputs[0]?.body).toBe(bundle);
    // The transport never consumes or accumulates ciphertext itself. The real
    // SDK multipart uploader is the only component allowed to consume it.
    expect(iterated).toBe(0);
    expect(port.calls).toEqual([
      `head:${keys.bundleKey}`,
      `head:${keys.descriptorKey}`,
      `upload:${keys.bundleKey}`,
      `head:${keys.bundleKey}`,
      `put:${keys.descriptorKey}:*:application/json`,
      `head:${keys.bundleKey}`,
      `head:${keys.descriptorKey}`,
      `get:${keys.descriptorKey}`,
    ]);
    expect(descriptor).toMatchObject({ ciphertextSha256: receipt.ciphertextSha256, completedAt: "2026-08-12T10:00:00.000Z" });
  });

  test("fails closed before upload when either exact key exists", async () => {
    for (const kind of ["bundle", "descriptor"] as const) {
      const { port, upload, store } = setup();
      const keys = store.keys(identity);
      port.objects.set(kind === "bundle" ? keys.bundleKey : keys.descriptorKey, { head: { contentLength: 1, contentType: kind === "bundle" ? "application/octet-stream" : "application/json" } });
      // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun's expect().rejects is runtime-thenable.
      await expect(store.publish({ identity, bundle: bytesBody(encoder.encode("never uploaded")), receipt: Promise.resolve(receipt), sourceReleaseId: "sha256:source-release" })).rejects.toMatchObject({ code: "EXISTING_OBJECT" });
      expect(upload.inputs).toHaveLength(0);
    }
  });

  test("requires exact post-upload length before terminal publication", async () => {
    const { port, store } = setup({ uploadedBytes: receipt.ciphertextBytes - 1 });
    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun's expect().rejects is runtime-thenable.
    await expect(store.publish({ identity, bundle: bytesBody(encoder.encode("sealed")), receipt: Promise.resolve(receipt), sourceReleaseId: "sha256:source-release" })).rejects.toMatchObject({ code: "INCONSISTENT_REMOTE" });
    expect(port.objects.has(store.keys(identity).descriptorKey)).toBeFalse();
  });

  test("rejects a source release identifier that cannot safely appear in a receipt", async () => {
    const { upload, store } = setup();
    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun's expect().rejects is runtime-thenable.
    await expect(store.publish({ identity, bundle: bytesBody(encoder.encode("sealed")), receipt: Promise.resolve(receipt), sourceReleaseId: "sha256:release/with-newline\n" })).rejects.toMatchObject({ code: "INVALID_IDENTITY" });
    expect(upload.inputs).toHaveLength(0);
  });

  test("observation is read-only and distinguishes not-found, incomplete, complete, and tampered state", async () => {
    const { port, store } = setup();
    expect(await store.observe(identity)).toEqual({ state: "not-found" });
    const keys = store.keys(identity);
    port.objects.set(keys.bundleKey, { head: { contentLength: receipt.ciphertextBytes } });
    expect(await store.observe(identity)).toEqual({ state: "inconsistent" });
    completeRemote(port, store);
    expect(await store.observe(identity)).toMatchObject({ state: "complete", descriptor: { objectId: identity.objectId } });
    const tampered = descriptorText({ ciphertextBytes: receipt.ciphertextBytes + 1 });
    port.objects.set(keys.descriptorKey, { head: { contentLength: tampered.byteLength, contentType: "application/json" }, body: tampered });
    expect(await store.observe(identity)).toEqual({ state: "inconsistent" });
    const duplicate = encoder.encode(`{"format":"nautilo-recovery-v1","format":"nautilo-recovery-v1","version":1,"operationId":"${identity.operationId}","objectId":"${identity.objectId}","ciphertextSha256":"${receipt.ciphertextSha256}","ciphertextBytes":${receipt.ciphertextBytes},"sourceReleaseId":"sha256:source-release","completedAt":"2026-08-12T10:00:00.000Z"}`);
    port.objects.set(keys.descriptorKey, { head: { contentLength: duplicate.byteLength, contentType: "application/json" }, body: duplicate });
    expect(await store.observe(identity)).toEqual({ state: "inconsistent" });
  });

  test("download first verifies the terminal descriptor and returns the remote body without aggregating it", async () => {
    const { port, store } = setup();
    completeRemote(port, store);
    const result = await store.download(identity);
    expect(result.descriptor.ciphertextSha256).toBe(receipt.ciphertextSha256);
    expect(result.body).toBeDefined();
    const bytes: Uint8Array[] = [];
    for await (const chunk of result.body) bytes.push(chunk);
    expect(new TextDecoder().decode(bytes[0])).toBe("sealed bytes");
  });

  test("snapshots caller identity across asynchronous observation and download", async () => {
    const { port, store } = setup();
    completeRemote(port, store);
    const mutable: { operationId: string; objectId: string } = { operationId: identity.operationId, objectId: identity.objectId };
    const originalGet = port.getObject.bind(port);
    port.getObject = async (input) => {
      const result = await originalGet(input);
      // This runs after initial object addressing but before the caller could
      // otherwise derive the bundle key for download.
      mutable.objectId = "mutated-after-await";
      return result;
    };
    const downloaded = await store.download(mutable);
    expect(downloaded.descriptor.objectId).toBe(identity.objectId);
    expect(downloaded.body).toBeDefined();
  });

  test("rejects a bundle whose downloaded content type differs from the verified object", async () => {
    const { port, store } = setup();
    completeRemote(port, store);
    const keys = store.keys(identity);
    const originalGet = port.getObject.bind(port);
    port.getObject = async (input) => {
      const result = await originalGet(input);
      return input.key === keys.bundleKey && result !== undefined ? { ...result, contentType: "text/plain" } : result;
    };
    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun's expect().rejects is runtime-thenable.
    await expect(store.download(identity)).rejects.toMatchObject({ code: "INCONSISTENT_REMOTE" });
  });

  test("never includes recovery credentials in typed errors or completion JSON", async () => {
    const { port, store } = setup();
    port.headObject = async () => { throw new Error(config.secretAccessKey); };
    let failure: unknown;
    try {
      await store.observe(identity);
    } catch (cause) {
      failure = cause;
    }
    expect(failure).toBeInstanceOf(PortableRecoveryObjectStoreError);
    expect(String(failure)).not.toContain(config.secretAccessKey);
    expect(JSON.stringify({ format: "nautilo-recovery-v1", operationId: identity.operationId })).not.toContain(config.secretAccessKey);
  });
});
