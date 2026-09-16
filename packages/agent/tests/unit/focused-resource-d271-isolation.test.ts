import { describe, expect, test } from "bun:test";
import {
  RELAY_PROTOCOL_VERSION,
  type RelayCapabilities,
  type RelayLocalFileRequest,
  type RelayLocalFileResult,
} from "@nautilo/relay";
import type { ResolvedFocusedResource } from "@nautilo/types";
import { setRelayRegistry } from "../../src/nodes/tools";
import type { ToolRelayRegistry } from "../../src/nodes/tools";
import { executeLocalFileCommand } from "../../src/tools/file/local-file-dispatch";
import {
  buildFocusedLocalFileHints,
  runWithFocusedLocalFileHints,
} from "../../src/tools/file/local-file-routing";
import { fileToolSchema } from "../../src/tools/file/schema";

const ownerId = "user-1";

/**
 * D423 Phase 5 / 5.1.4 — the focused-local-file lane and the D271 durable
 * attachment lane must not cross-wire. These assertions pin the agent-side
 * boundary: focus refs route only through the local-file relay tier, never
 * touch D271 attachment storage, and never leak a raw relay id onto the model
 * surface (tool schema, wire operation, or tool result text).
 */

const OWNED_ROUTING_MODULES = [
  "../../src/tools/file/local-file-routing.ts",
  "../../src/tools/file/local-file-dispatch.ts",
  "../../src/tools/file/local-zone-io.ts",
  "../../src/tools/office/local-office-routing.ts",
  "../../src/tools/office/local-office-dispatch.ts",
  "../../src/tools/media/extract-audio-from-video.ts",
] as const;

async function moduleSource(rel: string): Promise<string> {
  const src = Bun.file(new URL(rel, import.meta.url));
  return await src.text();
}

describe("D423 focused-resource / D271 isolation (5.1.4)", () => {
  test("routing modules import no D271 attachment / upload / DB storage", async () => {
    const forbidden = [
      "uploadMessageAttachment",
      "uploadComposerBlob",
      "preflightComposerChatAttachment",
      "attachmentId",
      "@nautilo/db",
      "recordRevision",
      "file_revisions",
      "../backups",
      "attachments.ts",
      "uploadAttachment",
    ];
    for (const rel of OWNED_ROUTING_MODULES) {
      const text = await moduleSource(rel);
      for (const token of forbidden) {
        expect(text.includes(token)).toBe(false);
      }
    }
  });

  test("the unified file tool schema never exposes relayId / relayIdHint", () => {
    const shape = fileToolSchema.shape as Record<string, unknown>;
    expect(!("relayId" in shape)).toBe(true);
    expect(!("relayIdHint" in shape)).toBe(true);
    expect(!("relay" in shape)).toBe(true);
  });

  test("buildFocusedLocalFileHints emits only {relayId,path} — no attachment/artifact ids", () => {
    const manifest: ResolvedFocusedResource[] = [
      {
        kind: "workspace-artifact",
        displayName: "note.md",
        location: "server",
        lifetime: "workspace",
        capabilities: ["read", "edit"],
        locator: { artifactId: "art-1" },
      },
      {
        kind: "message-attachment",
        displayName: "upload.pdf",
        location: "server",
        lifetime: "message",
        capabilities: ["read"],
        locator: { attachmentId: "att-1" },
      },
      {
        kind: "local-file",
        displayName: "deck.pptx",
        location: "relay",
        lifetime: "turn",
        capabilities: ["read", "edit"],
        toolTarget: { tool: "file", zone: "absolute", path: "/a/b/deck.pptx" },
        locator: { relayId: "relay-B", path: "/a/b/deck.pptx" },
      },
    ];
    const hints = buildFocusedLocalFileHints(manifest);
    expect(hints).toHaveLength(1);
    expect(Object.keys(hints[0]!).sort()).toEqual(["path", "relayId"]);
    const serialized = JSON.stringify(hints);
    // D271 + artifact identifiers never ride on a focus hint.
    expect(serialized.includes("attachmentId")).toBe(false);
    expect(serialized.includes("artifactId")).toBe(false);
  });
});

describe("focused local-file routing leaks no relay id (5.1.4 privacy)", () => {
  function caps(): RelayCapabilities {
    return {
      profile: "desktop-agent",
      workspaceRoot: "/Users/alice/project",
      dataDir: "/Users/alice/.nautilo",
      toolsBin: "/opt/nautilo/tools",
      userHome: "/Users/alice",
      canReadWorkspace: true,
      canWriteWorkspace: true,
      localFileExecution: true,
      canRunOffice: true,
      allowedRoots: ["/Users/alice/project"],
    };
  }

  function makeRegistry(
    localFileDispatch: (relayId: string, req: RelayLocalFileRequest) => Promise<RelayLocalFileResult>,
  ): ToolRelayRegistry {
    return {
      findByCapabilityForUser(capability, userId) {
        if (userId !== ownerId) return [];
        return capability === "canReadWorkspace" || capability === "canWriteWorkspace"
          ? ["relay-A", "relay-B"]
          : [];
      },
      getCapabilities(id) {
        return id === "relay-A" || id === "relay-B" ? caps() : undefined;
      },
      getProtocolVersion() {
        return RELAY_PROTOCOL_VERSION;
      },
      async dispatch() {
        throw new Error("dispatch must not be used");
      },
      async localFileDispatch(relayId, req) {
        return localFileDispatch(relayId, req);
      },
    };
  }

  test("the wire operation + tool result carry no raw relay id", async () => {
    const focusedRelay = "relay-B";
    const captured: Array<{ relayId: string; req: RelayLocalFileRequest }> = [];
    let returnedResult = "";
    setRelayRegistry(
      makeRegistry(async (relayId, req) => {
        captured.push({ relayId, req });
        // Return a result that deliberately echoes a path but no relay id.
        return { ok: true, result: JSON.stringify({ path: "/Users/alice/other/deck.pptx", matches: [] }) };
      }),
    );
    const hints = buildFocusedLocalFileHints([
      {
        kind: "local-file",
        displayName: "deck.pptx",
        location: "relay",
        lifetime: "turn",
        capabilities: ["read", "edit"],
        toolTarget: { tool: "file", zone: "absolute", path: "/Users/alice/other/deck.pptx" },
        locator: { relayId: focusedRelay, path: "/Users/alice/other/deck.pptx" },
      },
    ]);
    await runWithFocusedLocalFileHints(hints, async () => {
      returnedResult = (await executeLocalFileCommand(
        { command: "grep", zone: "absolute", path: "/Users/alice/other/deck.pptx", query: "x" },
        {
          ownerId,
          agentId: "agent-1",
          turnId: "turn-1",
          zoneCtx: { workspaceRoot: "/srv/ws", currentFolder: null },
          approvalObtained: true,
        },
      )) as string;
    });

    // Dispatch reached the focused relay (the routing bit), but the relay id is
    // the dispatch TARGET, never serialized into the wire operation payload.
    expect(captured).toHaveLength(1);
    expect(captured[0]?.relayId).toBe(focusedRelay);
    const wireJson = JSON.stringify(captured[0]?.req);
    expect(wireJson.includes(focusedRelay)).toBe(false);
    expect(wireJson.includes("relayId")).toBe(false);
    // And the tool result text the model sees never contains the relay id.
    expect(returnedResult.includes(focusedRelay)).toBe(false);
  });
});
