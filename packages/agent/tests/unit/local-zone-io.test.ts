import { describe, expect, test } from "bun:test";
import { setRelayRegistry } from "../../src/nodes/tools";
import { RELAY_PROTOCOL_VERSION } from "@nautilo/relay";
import {
  formatLocalMutationTurnIdError,
  parseLocalWriteRevisionId,
  queryLocalZoneStat,
  readLocalZoneText,
  requireLocalMutationTurnId,
  writeLocalZoneBytes,
  writeLocalZoneText,
} from "../../src/tools/file/local-zone-io";
import { LOCAL_HISTORY_INPUT_REQUIRED } from "../../src/tools/file/local-history-routing";

const ownerId = "user-1";

describe("local-zone-io helpers (M206)", () => {
  test("requireLocalMutationTurnId accepts appOperationId", () => {
    const appOpId = "app:writer:00000000-0000-4000-8000-000000000099";
    const result = requireLocalMutationTurnId(undefined, "document.write", appOpId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.turnId).toBe(appOpId);
    expect(result.source).toBe("app_operation");
  });

  test("requireLocalMutationTurnId prefers agent turnId over appOperationId", () => {
    const result = requireLocalMutationTurnId("turn-agent", "document.write", "app:writer:uuid");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.turnId).toBe("turn-agent");
    expect(result.source).toBe("agent_turn");
  });

  test("requireLocalMutationTurnId fails closed without turnId", () => {
    const result = requireLocalMutationTurnId(undefined, "document.write");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe(LOCAL_HISTORY_INPUT_REQUIRED);
    const formatted = formatLocalMutationTurnIdError(result);
    expect(formatted).toContain(LOCAL_HISTORY_INPUT_REQUIRED);
  });

  test("parseLocalWriteRevisionId extracts revisionId from write JSON", () => {
    expect(
      parseLocalWriteRevisionId(
        JSON.stringify({ applied: true, revisionId: "local:relay-1:abc" }),
      ),
    ).toBe("local:relay-1:abc");
  });

  test("readLocalZoneText and queryLocalZoneStat use local-file dispatch", async () => {
    const calls: string[] = [];
    setRelayRegistry({
      findByCapabilityForUser: () => ["relay-1"],
      getCapabilities: () => ({
        profile: "desktop-agent",
        canReadWorkspace: true,
        canWriteWorkspace: true,
        localFileExecution: true,
        allowedRoots: ["/tmp/project"],
      }),
      getProtocolVersion: () => RELAY_PROTOCOL_VERSION,
      async dispatch() {
        throw new Error("fs dispatch must not be used");
      },
      async localFileDispatch(_relayId, req) {
        if (req.operation.kind !== "file") return { ok: false, message: "bad op" };
        calls.push(req.operation.command);
        if (req.operation.command === "read") {
          return {
            ok: true,
            result: JSON.stringify({
              content: Buffer.from("hello", "utf8").toString("base64"),
              binary: true,
            }),
          };
        }
        return { ok: true, result: JSON.stringify({ size: 5 }) };
      },
    });

    const ctx = {
      ownerId,
      agentId: "agent-1",
      zoneCtx: { workspaceRoot: "/ws", currentFolder: "/tmp/project" },
      approvalObtained: false,
    };

    const read = await readLocalZoneText("doc.html", "current", ctx);
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.text).toBe("hello");

    const stat = await queryLocalZoneStat("doc.html", "current", ctx);
    expect(stat.ok).toBe(true);
    if (stat.ok) expect(stat.stat.size).toBe(5);

    expect(calls).toEqual(["read", "stat"]);
  });

  test("writeLocalZoneText carries mutation identity and rejects Desktop JSON errors", async () => {
    let routedMutationRequestId: string | undefined;
    setRelayRegistry({
      findByCapabilityForUser: () => ["relay-1"],
      getCapabilities: () => ({
        profile: "desktop-agent",
        canReadWorkspace: true,
        canWriteWorkspace: true,
        localFileExecution: true,
        allowedRoots: ["/tmp/project"],
      }),
      getProtocolVersion: () => RELAY_PROTOCOL_VERSION,
      async dispatch() {
        throw new Error("fs dispatch must not be used");
      },
      async localFileDispatch(_relayId, req) {
        if (req.operation.kind !== "file") return { ok: false, message: "bad op" };
        routedMutationRequestId = (
          req.operation.args["_routing"] as { mutationRequestId?: string }
        ).mutationRequestId;
        return {
          ok: true,
          result: JSON.stringify({
            error: "missing_mutation_request_id",
            message: "trusted mutation identity is unavailable",
          }),
        };
      },
    });

    const result = await writeLocalZoneText("doc.html", "current", "next", {
      ownerId,
      agentId: "agent-1",
      turnId: "turn-1",
      mutationRequestId: "d448:trusted:semantics",
      zoneCtx: { workspaceRoot: "/ws", currentFolder: "/tmp/project" },
      approvalObtained: true,
    });

    expect(routedMutationRequestId).toBe("d448:trusted:semantics");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("missing_mutation_request_id");
  });

  test("writeLocalZoneText rejects an incomplete success receipt", async () => {
    setRelayRegistry({
      findByCapabilityForUser: () => ["relay-1"],
      getCapabilities: () => ({
        profile: "desktop-agent",
        canReadWorkspace: true,
        canWriteWorkspace: true,
        localFileExecution: true,
        allowedRoots: ["/tmp/project"],
      }),
      getProtocolVersion: () => RELAY_PROTOCOL_VERSION,
      async dispatch() {
        throw new Error("fs dispatch must not be used");
      },
      async localFileDispatch() {
        return { ok: true, result: JSON.stringify({ path: "doc.html" }) };
      },
    });

    const result = await writeLocalZoneText("doc.html", "current", "next", {
      ownerId,
      agentId: "agent-1",
      turnId: "turn-1",
      mutationRequestId: "d448:trusted:semantics",
      zoneCtx: { workspaceRoot: "/ws", currentFolder: "/tmp/project" },
      approvalObtained: true,
    });
    expect(result).toEqual({
      ok: false,
      error: "local write returned an incomplete mutation receipt",
    });
  });

  test("writeLocalZoneText sends an atomic SHA guard and preserves stale details", async () => {
    const expectedSha256 = "a".repeat(64);
    const actualSha256 = "b".repeat(64);
    setRelayRegistry({
      findByCapabilityForUser: () => ["relay-1"],
      getCapabilities: () => ({
        profile: "desktop-agent",
        canReadWorkspace: true,
        canWriteWorkspace: true,
        localFileExecution: true,
        allowedRoots: ["/tmp/project"],
      }),
      getProtocolVersion: () => RELAY_PROTOCOL_VERSION,
      async dispatch() {
        throw new Error("fs dispatch must not be used");
      },
      async localFileDispatch(_relayId, req) {
        if (req.operation.kind !== "file") return { ok: false, message: "bad op" };
        expect(req.operation.args["expectedSha256"]).toBe(expectedSha256);
        return {
          ok: true,
          result: JSON.stringify({
            error: "stale_sha256",
            message: "canonical file sha256 does not match expectedSha256",
            expectedSha256,
            actualSha256,
          }),
        };
      },
    });

    const result = await writeLocalZoneText(
      "doc.html",
      "current",
      "next",
      {
        ownerId,
        agentId: "agent-1",
        turnId: "turn-1",
        mutationRequestId: "d448:trusted:semantics",
        zoneCtx: { workspaceRoot: "/ws", currentFolder: "/tmp/project" },
        approvalObtained: true,
      },
      { expectedSha256 },
    );
    expect(result).toEqual({
      ok: false,
      code: "stale_sha256",
      error: "stale_sha256: canonical file sha256 does not match expectedSha256",
      currentSha256: actualSha256,
    });
  });

  test("writeLocalZoneText preserves the historical unguarded request shape", async () => {
    setRelayRegistry({
      findByCapabilityForUser: () => ["relay-1"],
      getCapabilities: () => ({
        profile: "desktop-agent",
        canReadWorkspace: true,
        canWriteWorkspace: true,
        localFileExecution: true,
        allowedRoots: ["/tmp/project"],
      }),
      getProtocolVersion: () => RELAY_PROTOCOL_VERSION,
      async dispatch() {
        throw new Error("fs dispatch must not be used");
      },
      async localFileDispatch(_relayId, req) {
        if (req.operation.kind !== "file") return { ok: false, message: "bad op" };
        expect(req.operation.args).not.toHaveProperty("expectedSha256");
        return {
          ok: true,
          result: JSON.stringify({
            applied: true,
            revisionId: "local:relay-1:unguarded",
          }),
        };
      },
    });

    const result = await writeLocalZoneText("doc.html", "current", "next", {
      ownerId,
      agentId: "agent-1",
      turnId: "turn-1",
      mutationRequestId: "d448:trusted:semantics",
      zoneCtx: { workspaceRoot: "/ws", currentFolder: "/tmp/project" },
      approvalObtained: true,
    });
    expect(result.ok).toBe(true);
  });

  test("writeLocalZoneBytes accepts only a canonical published revision receipt", async () => {
    let mode: "success" | "malformed" = "success";
    setRelayRegistry({
      findByCapabilityForUser: () => ["relay-1"],
      getCapabilities: () => ({
        profile: "desktop-agent",
        canReadWorkspace: true,
        canWriteWorkspace: true,
        localFileExecution: true,
        allowedRoots: ["/tmp/project"],
      }),
      getProtocolVersion: () => RELAY_PROTOCOL_VERSION,
      async dispatch() {
        throw new Error("fs dispatch must not be used");
      },
      async localFileDispatch() {
        return mode === "success"
          ? {
              ok: true,
              result: {
                applied: true,
                revisionId: "local:relay-1:binary",
                path: "out.docx",
              },
            }
          : { ok: true, result: undefined };
      },
    });
    const ctx = {
      ownerId,
      agentId: "agent-1",
      turnId: "turn-1",
      mutationRequestId: "d448:trusted:semantics",
      zoneCtx: { workspaceRoot: "/ws", currentFolder: "/tmp/project" },
      approvalObtained: true,
    };

    const success = await writeLocalZoneBytes(
      "out.docx",
      "current",
      Buffer.from("bytes"),
      ctx,
      "test write",
    );
    expect(success.ok).toBe(true);

    mode = "malformed";
    const malformed = await writeLocalZoneBytes(
      "out.docx",
      "current",
      Buffer.from("bytes"),
      ctx,
      "test write",
    );
    expect(malformed).toEqual({
      ok: false,
      error: "local write returned a malformed mutation receipt",
    });
  });

  test("local writes reject pre-v9 relays before dispatch", async () => {
    let dispatched = false;
    setRelayRegistry({
      findByCapabilityForUser: () => ["relay-old"],
      getCapabilities: () => ({
        profile: "desktop-agent",
        canReadWorkspace: true,
        canWriteWorkspace: true,
        localFileExecution: true,
        allowedRoots: ["/tmp/project"],
      }),
      getProtocolVersion: () => 8,
      async dispatch() {
        throw new Error("fs dispatch must not be used");
      },
      async localFileDispatch() {
        dispatched = true;
        return { ok: true, result: "unreachable" };
      },
    });
    const result = await writeLocalZoneText("doc.html", "current", "next", {
      ownerId,
      agentId: "agent-1",
      turnId: "turn-1",
      mutationRequestId: "d448:trusted:semantics",
      zoneCtx: { workspaceRoot: "/ws", currentFolder: "/tmp/project" },
      approvalObtained: true,
    });
    expect(dispatched).toBe(false);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("v9 Nautilo desktop relay");
  });
});

describe("create-only local transport", () => {
  test("never falls back to write when an older Desktop rejects create", async () => {
    const commands: string[] = [];
    setRelayRegistry({
      findByCapabilityForUser: () => ["relay-1"],
      getCapabilities: () => ({ profile: "desktop-agent", canReadWorkspace: true,
        canWriteWorkspace: true, localFileExecution: true, allowedRoots: ["/tmp/project"] }),
      getProtocolVersion: () => RELAY_PROTOCOL_VERSION,
      async dispatch() { throw new Error("must not use raw fs writes"); },
      async localFileDispatch(_relayId, req, options) {
        if (req.operation.kind !== "file") throw new Error("expected file operation");
        commands.push(req.operation.command);
        expect(options.mutating).toBe(true);
        expect(options.approvalObtained).toBe(true);
        return { ok: true, result: `Error: unknown local file command ${req.operation.command}` };
      },
    });
    const result = await writeLocalZoneText("new.doc.html", "current", "new", {
      ownerId, agentId: "agent-1", turnId: "turn-1", mutationRequestId: "create-1",
      zoneCtx: { workspaceRoot: "/ws", currentFolder: "/tmp/project" }, approvalObtained: true,
    }, { createOnly: true });
    expect(result.ok).toBe(false);
    expect(commands).toEqual(["create"]);
  });
});
