/** D448 — the agent-facing registry port retains the dedicated strict shape. */
import { describe, expect, it } from "bun:test";
import type {
  RelayLocalApplyPatchRequest,
  RelayLocalApplyPatchResult,
  RelaySandboxProfile,
} from "@nautilo/relay";
import type { ToolRelayRegistry } from "../../src/nodes/tools";

const REQUEST: RelayLocalApplyPatchRequest = {
  operation: {
    kind: "apply_patch",
    version: 1,
    patch: "*** Begin Patch\n*** Add File: example.txt\n+example\n*** End Patch\n",
    routing: { zone: "current", turnId: "turn-1", agentId: "agent-1" },
  },
  expectedCurrentFolder: "/Users/alice/demo",
};

const RESULT: RelayLocalApplyPatchResult = {
  status: "applied",
  partial: false,
  operationCounts: { add: 1, update: 0, move: 0, delete: 0 },
  pathResults: [{ operation: "add", path: "example.txt", status: "applied", bytesTouched: 8, revisionId: "rev-1" }],
  changedFiles: [{ operation: "add", path: "example.txt", status: "applied", bytesTouched: 8, revisionId: "rev-1" }],
  revisionIds: ["rev-1"],
  unifiedDiff: "+example\n",
  runtimeVersion: "nautilo.apply_patch/v1",
  turnId: "turn-1",
};

const SANDBOX = {
  workspace: "/repo",
  dataDir: "/data",
  toolsBin: "/tools",
  config: { mode: "read-write", writablePaths: ["/repo"], projectPaths: ["/repo"], passthroughEnv: [] },
  mode: "desktop-locked",
  securityLevel: "standard",
  failIfNoBackend: true,
} as unknown as RelaySandboxProfile;

describe("ToolRelayRegistry.applyPatchDispatch (D448)", () => {
  it("exposes the dedicated request and Desktop-local Current Folder port", async () => {
    const calls: unknown[] = [];
    const dispatch: NonNullable<ToolRelayRegistry["applyPatchDispatch"]> = async (relayId, request, options) => {
      calls.push({ relayId, request, options });
      return RESULT;
    };

    expect(await dispatch("relay-1", REQUEST, { sandboxProfile: SANDBOX })).toEqual(RESULT);
    expect(calls).toEqual([{ relayId: "relay-1", request: REQUEST, options: { sandboxProfile: SANDBOX } }]);
    expect(JSON.stringify(calls)).not.toContain("allowedRoots");
  });
});
