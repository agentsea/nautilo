import { beforeEach, describe, expect, test } from "bun:test";
import { RELAY_MEDIA_MAX_BYTES } from "@nautilo/relay";
import { setRelayRegistry } from "../../src/nodes/tools";
import {
  createIngestLocalMediaTool,
  type IngestLocalMediaToolDeps,
} from "../../src/tools/media/ingest-local-media";

const OWNER_ID = "00000000-0000-4000-8000-000000000001";
const ENVELOPE = {
  userId: OWNER_ID,
  agentId: "agent-1",
  readableNamespaces: ["namespace-1"],
  writableNamespaces: ["namespace-1"],
  mutableNamespaces: ["namespace-1"],
} as never;

function mp4Bytes(payload = [0xde, 0xad, 0xbe, 0xef]): Buffer {
  return Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, ...payload]);
}

function createTool(deps: IngestLocalMediaToolDeps = {}) {
  return createIngestLocalMediaTool(
    {
      ownerId: OWNER_ID,
      agentId: "agent-1",
      currentFolder: "/local/project",
      workspacePath: "/workspace",
      memoryAccessEnvelope: ENVELOPE,
    },
    deps,
  );
}

beforeEach(() => {
  setRelayRegistry(null);
});

describe("ingest_local_media", () => {
  test("reads the local MP4 through the relay and persists exact artifact bytes", async () => {
    const source = mp4Bytes([0x00, 0x61, 0xff, 0x62]);
    const captured: {
      persisted: { bytes: Buffer | Uint8Array; mimeType: string; actor: unknown } | null;
    } = { persisted: null };
    const tool = createTool({
      readLocalZoneBytes: async () => ({ ok: true, bytes: source }),
      createWorkspaceBinaryArtifact: async (input) => {
        captured.persisted = input;
        return {
          ok: true,
          artifactId: "artifact-public-id",
          artifactInternalId: "artifact-row-id",
          displayPath: "media/meeting.mp4",
          revision: 1,
          size: input.bytes.byteLength,
          sha256: "test-sha",
        };
      },
    });

    const output = String(await tool.invoke({
      sourcePath: "meeting.mp4",
      sourceZone: "current",
      artifactPath: "media/meeting.mp4",
    }));

    expect(captured.persisted).not.toBeNull();
    const actualPersistence = captured.persisted!;
    expect(Buffer.from(actualPersistence.bytes).equals(source)).toBe(true);
    expect(actualPersistence.mimeType).toBe("video/mp4");
    expect(actualPersistence.actor).toEqual({ kind: "agent", agentId: "agent-1" });
    expect(output).toContain('"ingested":true');
    expect(output).toContain('"artifactId":"artifact-public-id"');
    expect(output).toContain('"artifactInternalId":"artifact-row-id"');
    expect(output).toContain('"path":"media/meeting.mp4"');
    expect(output).toContain(`"size":${source.byteLength}`);
  });

  test("persists a generated MP4 larger than the generic 16 MiB file cap", async () => {
    const source = Buffer.alloc(17 * 1024 * 1024, 0x5a);
    mp4Bytes().copy(source);
    let persistedExactly = false;
    const tool = createTool({
      readLocalZoneBytes: async () => ({ ok: true, bytes: source }),
      createWorkspaceBinaryArtifact: async (input) => {
        persistedExactly = Buffer.from(input.bytes).equals(source);
        return { ok: true, artifactId: "id", artifactInternalId: "internal", displayPath: "media/large.mp4", revision: 1, size: input.bytes.byteLength, sha256: "sha" };
      },
    });
    const output = String(await tool.invoke({ sourcePath: "large.mp4", sourceZone: "current", artifactPath: "media/large.mp4" }));
    expect(persistedExactly).toBe(true);
    expect(output).toContain('"ingested":true');
  });

  test("rejects non-MP4 sources before local bytes are read", async () => {
    let reads = 0;
    const tool = createTool({
      readLocalZoneBytes: async () => {
        reads += 1;
        return { ok: true, bytes: mp4Bytes() };
      },
    });

    const output = String(await tool.invoke({
      sourcePath: "meeting.wav",
      sourceZone: "current",
      artifactPath: "media/meeting.mp4",
    }));

    expect(output).toContain("only .mp4");
    expect(reads).toBe(0);
  });

  test("rejects payloads above the relay cap without persisting bytes", async () => {
    let writes = 0;
    const tool = createTool({
      readLocalZoneBytes: async () => ({
        ok: true,
        bytes: Buffer.alloc(RELAY_MEDIA_MAX_BYTES + 1),
      }),
      createWorkspaceBinaryArtifact: async () => {
        writes += 1;
        throw new Error("must not persist oversized payload");
      },
    });

    const output = String(await tool.invoke({
      sourcePath: "meeting.mp4",
      sourceZone: "absolute",
      artifactPath: "media/meeting.mp4",
    }));

    expect(output).toContain("relay media limit");
    expect(writes).toBe(0);
  });
});
