import { describe, expect, test } from "bun:test";
import { RELAY_MEDIA_MAX_BYTES } from "@nautilo/relay";
import {
  createExtractAudioFromVideoTool,
  type ExtractAudioFromVideoToolDeps,
} from "../../src/tools/media/extract-audio-from-video";

const ENVELOPE = {
  userId: "00000000-0000-4000-8000-000000000001",
  agentId: "agent-1",
  readableNamespaces: ["namespace-1"],
  writableNamespaces: ["namespace-1"],
  mutableNamespaces: ["namespace-1"],
} as never;

function mp4Bytes(payload = [0xde, 0xad, 0xbe, 0xef]): Buffer {
  return Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, ...payload]);
}

function createTool(deps: ExtractAudioFromVideoToolDeps) {
  return createExtractAudioFromVideoTool({
    ownerId: "00000000-0000-4000-8000-000000000001",
    agentId: "agent-1",
    currentFolder: "/local/project",
    workspacePath: "/workspace",
    memoryAccessEnvelope: ENVELOPE,
  }, deps);
}

describe("extract_audio_from_video", () => {
  test("passes a workspace MP4 through the bounded chunk transport seam and persists the complete M4A artifact", async () => {
    const source = mp4Bytes();
    const audio = Buffer.from("complete-m4a-output");
    const captured: { request: Record<string, unknown> | null; persisted: Buffer | null; actor: unknown } = {
      request: null,
      persisted: null,
      actor: null,
    };
    const tool = createTool({
      readWorkspaceBytes: async () => ({ ok: true, bytes: source }),
      dispatch: async (input) => {
        captured.request = { sourceBytes: input.byteLength };
        return { ok: true, audio };
      },
      createWorkspaceBinaryArtifact: async (input) => {
        captured.persisted = Buffer.from(input.bytes);
        captured.actor = input.actor;
        return {
          ok: true,
          artifactId: "audio-public-id",
          artifactInternalId: "audio-row-id",
          displayPath: "media/meeting.m4a",
          revision: 1,
          size: input.bytes.byteLength,
          sha256: "audio-sha",
        };
      },
    });

    const output = String(await tool.invoke({
      sourcePath: "media/meeting.mp4",
      sourceZone: "workspace",
      artifactPath: "media/meeting.m4a",
    }));

    expect(captured.request).toEqual({ sourceBytes: source.byteLength });
    expect(captured.persisted?.equals(audio)).toBe(true);
    expect(captured.actor).toEqual({ kind: "agent", agentId: "agent-1" });
    expect(output).toContain('"extracted":true');
    expect(output).toContain('"mimeType":"audio/mp4"');
  });

  test("rejects an invalid MP4 before relay extraction", async () => {
    let dispatched = 0;
    const tool = createTool({
      readLocalZoneBytes: async () => ({ ok: true, bytes: Buffer.from("not an MP4") }),
      dispatch: async () => {
        dispatched += 1;
        return { ok: false, error: "must not dispatch" };
      },
    });

    const output = String(await tool.invoke({
      sourcePath: "bad.mp4",
      sourceZone: "current",
      artifactPath: "media/bad.m4a",
    }));

    expect(output).toContain("not a supported MP4");
    expect(dispatched).toBe(0);
  });

  test("does not persist an oversized extractor output", async () => {
    let writes = 0;
    const tool = createTool({
      readWorkspaceBytes: async () => ({ ok: true, bytes: mp4Bytes() }),
      dispatch: async () => ({ ok: true, audio: Buffer.alloc(RELAY_MEDIA_MAX_BYTES + 1) }),
      createWorkspaceBinaryArtifact: async () => {
        writes += 1;
        throw new Error("must not persist oversized audio");
      },
    });

    const output = String(await tool.invoke({
      sourcePath: "meeting.mp4",
      artifactPath: "media/meeting.m4a",
    }));

    expect(output).toContain("no artifact was created");
    expect(writes).toBe(0);
  });

  test("never forwards caller-controlled shell fields to the relay request", async () => {
    const captured: { request: Record<string, unknown> | null } = { request: null };
    const tool = createTool({
      readLocalZoneBytes: async () => ({ ok: true, bytes: mp4Bytes() }),
      dispatch: async (input) => {
        captured.request = { sourceBytes: input.byteLength };
        return { ok: false, error: "ffmpeg is missing" };
      },
    });

    await tool.invoke({
      sourcePath: "meeting; rm -rf /.mp4",
      sourceZone: "absolute",
      artifactPath: "media/meeting.m4a",
      executable: "/bin/sh",
      argv: ["-c", "evil"],
      cwd: "/",
    });

    expect(Object.keys(captured.request ?? {}).sort()).toEqual(["sourceBytes"]);
  });
});
