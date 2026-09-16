import { describe, expect, test } from "bun:test";
import type { ToolCall } from "@langchain/core/messages/tool";
import type { ResolvedFocusedResource } from "@nautilo/types";
import { parseOrdinaryContentAccessIntent } from "../../src/tools/content-access-intent";

const call = (name: string, args: Record<string, unknown>): ToolCall => ({
  id: "call-1",
  name,
  args,
  type: "tool_call",
});
const focused: ResolvedFocusedResource[] = [{
  kind: "workspace-artifact",
  displayName: "plan.md",
  location: "server",
  lifetime: "workspace",
  capabilities: ["read"],
  locator: { artifactId: "artifact-focused" },
}];

describe("ordinary content-access intent", () => {
  test("normalizes legacy person targets without changing object identity", () => {
    expect(parseOrdinaryContentAccessIntent(call("share_memory", {
      memory_id: "memory-1",
      target_handle: " @alice ",
      sensitivity: "normal",
    }), [])).toEqual({
      toolName: "share_memory",
      objects: [{ kind: "memory", id: "memory-1" }],
      target: { kind: "person", handle: "alice" },
    });
  });

  test("accepts the additive Room target and rejects legacy/new target conflicts", () => {
    expect(parseOrdinaryContentAccessIntent(call("share_artifact", {
      artifact_id: "artifact-1",
      target: { kind: "room", name: " Project room ", choiceToken: "opaque-choice" },
      sensitivity: "normal",
    }), [])).toEqual({
      toolName: "share_artifact",
      objects: [{ kind: "artifact", id: "artifact-1" }],
      target: { kind: "room", name: "Project room", choiceToken: "opaque-choice" },
    });
    expect(() => parseOrdinaryContentAccessIntent(call("share_artifact", {
      artifact_id: "artifact-1",
      target_handle: "alice",
      target: { kind: "person", handle: "bob" },
    }), [])).toThrow("either the legacy target or target");
  });

  test("combines and deduplicates ask_peer explicit and focused Artifacts", () => {
    expect(parseOrdinaryContentAccessIntent(call("ask_peer", {
      peer_handle: "@alice",
      message_to_peer: "Please review this.",
      artifact_ids: ["artifact-explicit", "artifact-focused"],
      include_focused_artifacts: true,
    }), focused)).toEqual({
      toolName: "ask_peer",
      objects: [
        { kind: "artifact", id: "artifact-explicit" },
        { kind: "artifact", id: "artifact-focused" },
      ],
      target: { kind: "person", handle: "alice" },
    });
  });

  test("returns null for unrelated, projected, and plain ask_peer calls", () => {
    expect(parseOrdinaryContentAccessIntent(call("search_memory", {}), focused)).toBeNull();
    expect(parseOrdinaryContentAccessIntent(call("share_memory", {
      mode: "project",
      source_memory_ids: ["memory-1"],
    }), focused)).toBeNull();
    expect(parseOrdinaryContentAccessIntent(call("ask_peer", {
      peer_handle: "alice",
      message_to_peer: "Hello",
    }), focused)).toBeNull();
  });

  test("fails safely when an applicable call has no usable object or focused Artifact", () => {
    expect(() => parseOrdinaryContentAccessIntent(call("share_memory", {
      target_handle: "alice",
    }), [])).toThrow("Memory id");
    expect(() => parseOrdinaryContentAccessIntent(call("ask_peer", {
      peer_handle: "alice",
      include_focused_artifacts: true,
    }), [])).toThrow("No workspace Artifact");
  });
});
