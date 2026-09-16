import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { describe, expect, it } from "bun:test";

const PINNED_SAVER_VERSION = "1.0.1";
const PINNED_SAVER_SOURCE_SHA256 =
  "4f4ee16ce294a7ee8c37d9bf30c15af9c586405d1b8e1f099706424a4f413438";
const PINNED_SAVER_SQL_SHA256 =
  "55ece7969ea49a94e0fc62859b5db22ef992292a0a2025e9e3b55efe2852c734";
const CRYPTO_REFERENCE_TYPE = "nautilo.crypto-object-reference.v1";
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const require = createRequire(import.meta.url);

type CryptoReference = Readonly<{
  $nautiloCryptoObjectId: string;
}>;

type SerializerProtocol = Readonly<{
  dumpsTyped(data: unknown): Promise<[string, Uint8Array]>;
  loadsTyped(type: string, data: Uint8Array): Promise<unknown>;
}>;

type CheckpointShape = {
  v: number;
  id: string;
  ts: string;
  channel_values: Record<string, unknown>;
  channel_versions: Record<string, number | string>;
  versions_seen: Record<string, Record<string, number | string>>;
};

type CheckpointMetadataShape = {
  source: "input" | "loop" | "update" | "fork";
  step: number;
  parents: Record<string, string>;
} & Record<string, unknown>;

function isCryptoReference(value: unknown): value is CryptoReference {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && Object.keys(value).length === 1
    && typeof (value as Record<string, unknown>)["$nautiloCryptoObjectId"]
      === "string";
}

/**
 * Deliberately unsafe characterization double. It proves which values pass
 * through the pinned serializer hook, while also making the missing
 * coordinate authentication and forged-reference hazard executable below.
 * It is not a candidate production design.
 */
class UnsafeReferenceSerializer implements SerializerProtocol {
  readonly objects = new Map<string, Uint8Array>();
  #nextId = 0;

  async dumpsTyped(data: unknown): Promise<[string, Uint8Array]> {
    if (isCryptoReference(data)) {
      return [CRYPTO_REFERENCE_TYPE, encoder.encode(JSON.stringify(data))];
    }

    const objectId = `checkpoint-object-${++this.#nextId}`;
    this.objects.set(objectId, encoder.encode(JSON.stringify(data)));
    return [
      CRYPTO_REFERENCE_TYPE,
      encoder.encode(JSON.stringify({
        $nautiloCryptoObjectId: objectId,
      } satisfies CryptoReference)),
    ];
  }

  async loadsTyped(type: string, data: Uint8Array): Promise<unknown> {
    if (type !== CRYPTO_REFERENCE_TYPE) {
      throw new Error(`unexpected serializer type: ${type}`);
    }
    const reference = JSON.parse(decoder.decode(data)) as unknown;
    if (!isCryptoReference(reference)) {
      throw new Error("checkpoint crypto reference is malformed");
    }
    const plaintext = this.objects.get(reference.$nautiloCryptoObjectId);
    if (plaintext === undefined) {
      throw new Error("checkpoint crypto object is unavailable");
    }
    return JSON.parse(decoder.decode(plaintext)) as unknown;
  }
}

class InspectablePostgresSaver extends PostgresSaver {
  dumpCheckpoint(checkpoint: CheckpointShape): Record<string, unknown> {
    return this._dumpCheckpoint(checkpoint as never);
  }

  dumpMetadata(metadata: CheckpointMetadataShape): Promise<unknown> {
    return this._dumpMetadata(metadata as never);
  }

  dumpBlobs(
    values: Record<string, unknown>,
    versions: Record<string, number>,
  ) {
    return this._dumpBlobs("thread-1", "", values, versions);
  }

  dumpWrites(writes: [string, unknown][]) {
    return this._dumpWrites("thread-1", "", "checkpoint-1", "task-1", writes);
  }

  loadMetadata(metadata: Record<string, unknown>): Promise<unknown> {
    return this._loadMetadata(metadata);
  }

  loadBlobs(values: [Uint8Array, Uint8Array, Uint8Array][]) {
    return this._loadBlobs(values);
  }

  loadWrites(values: [Uint8Array, Uint8Array, Uint8Array, Uint8Array][]) {
    return this._loadWrites(values);
  }

  searchWhere(filter?: Record<string, unknown>): [string, unknown[]] {
    return this._searchWhere(
      { configurable: { thread_id: "thread-1", checkpoint_ns: "" } },
      filter,
      undefined,
    );
  }
}

function createSaver(serializer: SerializerProtocol): InspectablePostgresSaver {
  // None of the protected helper calls exercised here opens a connection.
  return new InspectablePostgresSaver({} as never, serializer, {
    schema: "langchain",
  });
}

function checkpointWithCanary(canary: string): CheckpointShape {
  return {
    v: 4,
    id: "checkpoint-1",
    ts: "2026-08-03T00:00:00.000Z",
    channel_values: {
      messages: [{ role: "user", content: canary }],
      protected_context: { canary },
    },
    channel_versions: {
      messages: 1,
      protected_context: 1,
    },
    versions_seen: {
      agent: { messages: 1, protected_context: 1 },
    },
  };
}

describe("M237 pinned PostgresSaver encryption feasibility", () => {
  it("pins the exact upstream serializer/write implementation reviewed by M237", () => {
    const packageRoot = resolve(
      dirname(
        require.resolve("@langchain/langgraph-checkpoint-postgres"),
      ),
      "..",
    );
    const packageJson = JSON.parse(
      readFileSync(resolve(packageRoot, "package.json"), "utf8"),
    ) as { version?: string };
    const source = readFileSync(resolve(packageRoot, "dist/index.js"));
    const sql = readFileSync(resolve(packageRoot, "dist/sql.js"));

    expect(packageJson.version).toBe(PINNED_SAVER_VERSION);
    expect(createHash("sha256").update(source).digest("hex"))
      .toBe(PINNED_SAVER_SOURCE_SHA256);
    expect(createHash("sha256").update(sql).digest("hex"))
      .toBe(PINNED_SAVER_SQL_SHA256);
  });

  it("characterizes the upstream serializer coverage without blessing reference storage", async () => {
    const canary = "M237_CHECKPOINT_PLAINTEXT_CANARY";
    const serializer = new UnsafeReferenceSerializer();
    const saver = createSaver(serializer);
    const checkpoint = checkpointWithCanary(canary);

    const blobs = await saver.dumpBlobs(
      checkpoint.channel_values,
      checkpoint.channel_versions as Record<string, number>,
    );
    const metadata = await saver.dumpMetadata({
      source: "loop",
      step: 1,
      parents: {},
      writes: { agent: { protected: canary } },
    });
    const writes = await saver.dumpWrites([
      ["messages", { role: "tool", content: canary }],
    ]);

    expect(JSON.stringify(blobs)).not.toContain(canary);
    expect(JSON.stringify(metadata)).not.toContain(canary);
    expect(JSON.stringify(writes)).not.toContain(canary);
    expect(blobs.every((blob) => blob[4] === CRYPTO_REFERENCE_TYPE)).toBeTrue();
    expect(writes.every((write) => write[6] === CRYPTO_REFERENCE_TYPE))
      .toBeTrue();

    const loadedBlobs = await saver.loadBlobs(
      blobs.map((blob) => [
        encoder.encode(blob[2]),
        encoder.encode(blob[4]),
        blob[5]!,
      ]),
    );
    const loadedMetadata = await saver.loadMetadata(
      metadata as Record<string, unknown>,
    );
    const loadedWrites = await saver.loadWrites(
      writes.map((write) => [
        encoder.encode(write[3]),
        encoder.encode(write[5]),
        encoder.encode(write[6]),
        write[7],
      ]),
    );

    expect(loadedBlobs).toEqual(checkpoint.channel_values);
    expect(loadedMetadata).toEqual({
      source: "loop",
      step: 1,
      parents: {},
      writes: { agent: { protected: canary } },
    });
    expect(loadedWrites).toEqual([
      ["task-1", "messages", { role: "tool", content: canary }],
    ]);
  });

  it("proves serializer-only metadata references accept a forged database value", async () => {
    const canary = "M237_FORGED_REFERENCE_CANARY";
    const serializer = new UnsafeReferenceSerializer();
    const saver = createSaver(serializer);
    const [, referenceBytes] = await serializer.dumpsTyped({
      secret: canary,
    });
    const forgedMetadata = JSON.parse(
      decoder.decode(referenceBytes),
    ) as Record<string, unknown>;

    // `_loadMetadata` feeds the database JSON back through `dumpsTyped`.
    // A serializer has no thread/checkpoint coordinate here, so this forged
    // reference is accepted. An owned invocation-bound saver façade must
    // authenticate exact coordinates before exposing any decoded value.
    expect(await saver.loadMetadata(forgedMetadata)).toEqual({
      secret: canary,
    });
  });

  it("proves external crypto-object references would outlive checkpoint compaction", () => {
    const cryptoSchema = readFileSync(
      resolve(import.meta.dir, "../../../db/src/schema/crypto-storage.ts"),
      "utf8",
    );
    const storageContract = readFileSync(
      resolve(
        import.meta.dir,
        "../../../lattice-crypto/src/storage/v2-storage-contract.ts",
      ),
      "utf8",
    );

    expect(cryptoSchema).toContain(
      'crypto_objects: Object.freeze(["SELECT", "INSERT"])',
    );
    expect(storageContract).not.toContain("deleteObject(");
  });

  it("proves the raw checkpoint row is structural only for the exact v4 shape", () => {
    const canary = "M237_RAW_CHECKPOINT_CANARY";
    const saver = createSaver(new UnsafeReferenceSerializer());
    const raw = saver.dumpCheckpoint(checkpointWithCanary(canary));

    expect(raw).toEqual({
      v: 4,
      id: "checkpoint-1",
      ts: "2026-08-03T00:00:00.000Z",
      channel_versions: {
        messages: 1,
        protected_context: 1,
      },
      versions_seen: {
        agent: { messages: 1, protected_context: 1 },
      },
    });
    expect(JSON.stringify(raw)).not.toContain(canary);
  });

  it("characterizes the two hazards the protected wrapper must fail closed", () => {
    const canary = "M237_UNSAFE_UPSTREAM_EXTENSION_CANARY";
    const saver = createSaver(new UnsafeReferenceSerializer());
    const checkpoint = {
      ...checkpointWithCanary("safe-in-serializer"),
      unexpected_confidential_field: canary,
    } as CheckpointShape;

    // Upstream copies every top-level field except channel_values. The M237
    // wrapper therefore must enforce the exact v4 structural allowlist before
    // delegating to put().
    expect(JSON.stringify(saver.dumpCheckpoint(checkpoint))).toContain(canary);

    // Upstream implements list({filter}) as a plaintext JSONB containment
    // query over metadata. Protected list filtering must be rejected or
    // replaced; forwarding it would put confidential filters on the wire.
    const [where, parameters] = saver.searchWhere({ secret: canary });
    expect(where).toContain("metadata @>");
    expect(JSON.stringify(parameters)).toContain(canary);
  });
});
