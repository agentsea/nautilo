import { beforeAll, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createWorkspaceGuard,
  type RelayDispatchRequest,
} from "@nautilo/relay";

mock.module("electron", () => ({
  app: {
    getPath: () => "/tmp/nautilo-relay-session-lifecycle",
    isPackaged: true,
  },
}));

let makeDispatchHandler: typeof import("../../electron/relay.ts").makeDispatchHandler;

beforeAll(async () => {
  ({ makeDispatchHandler } = await import("../../electron/relay.ts"));
});

const desktopRoot = join(import.meta.dir, "../..");
const relaySource = readFileSync(
  join(desktopRoot, "electron/relay.ts"),
  "utf8",
);
const providerRuntimeSource = readFileSync(
  join(desktopRoot, "electron/relay-provider-runtime.ts"),
  "utf8",
);

function mediaStart(sessionId: string): RelayDispatchRequest {
  return {
    correlationId: `media-${sessionId}`,
    toolName: "media_extract_start",
    args: {
      sessionId,
      outputFormat: "m4a",
      totalBytes: 12,
      chunkCount: 1,
    },
    impact: "high",
    approvalObtained: true,
  };
}

describe("Desktop relay production session lifecycle", () => {
  test("standalone dispatch handlers receive independent media owners", async () => {
    const guard = createWorkspaceGuard({ workspaceRoot: "/tmp" });
    const first = makeDispatchHandler(guard);
    const second = makeDispatchHandler(guard);
    const sessionId = "00000000-0000-4000-8000-000000000001";

    expect(await first(mediaStart(sessionId))).toEqual({
      status: "ok",
      result: { ok: true },
    });
    expect(await second(mediaStart(sessionId))).toEqual({
      status: "ok",
      result: { ok: true },
    });
  });

  test("one active session replaces every non-CUA resource-owner global", () => {
    const ownerStart = relaySource.indexOf("let activeRelaySession: DesktopRelaySession | null = null;");
    const start = relaySource.indexOf("export async function startRelay");
    expect(ownerStart).toBeGreaterThan(-1);
    expect(ownerStart).toBeLessThan(start);
    for (const staleGlobal of [
      "let client: RelayClient | null",
      "let runShellOutputArtifacts:",
      "let browserPageSnapshots:",
      "let statusCallback:",
      "let mcpHost:",
      "let activeStructuredSshRuntime:",
      "const mediaSessions = new Map",
      "const browserShotScaleBySession = new Map",
      "let relayGoogleOAuthContext:",
      "let relayGoogleOAuthClientPath:",
    ]) {
      expect(relaySource).not.toContain(staleGlobal);
    }
    expect(relaySource).toContain("let capabilityPublisher: RelayCapabilityPublisher | null = null;");
    expect(relaySource).toContain("Non-owning identity alias retained only for the byte-stable Computer Use");
    expect(relaySource).toContain("publishes no runtime authority: it exists only so stop/handoff can retire");
  });

  test("candidate resources attach once and become active only after connect", () => {
    const start = relaySource.indexOf("export async function startRelay");
    const stop = relaySource.indexOf("export async function stopRelay", start);
    const source = relaySource.slice(start, stop);
    const session = source.indexOf("const candidateSession = new DesktopRelaySession({");
    const firstAllocation = source.indexOf("const hostedRelay = createDesktopHostedRelayAdapter({");
    const attachMcp = source.indexOf("candidateSession.attachMcpHost(candidateMcpHost);");
    const attachTransport = source.indexOf("candidateSession.attachTransport(candidateClient, candidatePublisher);");
    const connect = source.indexOf("connect: () => candidateClient.connect(),");
    const activate = source.indexOf("activeRelaySession = candidateSession;");

    expect(session).toBeGreaterThan(-1);
    expect(session).toBeLessThan(firstAllocation);
    expect(attachMcp).toBeGreaterThan(firstAllocation);
    expect(attachTransport).toBeGreaterThan(attachMcp);
    expect(connect).toBeGreaterThan(attachTransport);
    expect(activate).toBeGreaterThan(connect);
    expect(source).toContain("assertCurrentRelayCandidate(candidateSession, candidateGeneration);");
    expect(source).toContain("if (!activated) throw new Error(\"Desktop relay start was superseded.\");");
    expect(source).toContain("candidateSession.attachStructuredSshRuntime(structuredSshRuntime);");
  });

  test("direct starts fail closed while an active session still owns the relay", () => {
    const guard = relaySource.indexOf("function assertRelayCandidateMayBegin");
    const begin = relaySource.indexOf("function beginPendingRelayCandidate");
    const start = relaySource.indexOf("export async function startRelay");
    const candidateAllocation = relaySource.indexOf("const candidateSession = new DesktopRelaySession", start);
    const pendingCheck = relaySource.indexOf("if (pendingRelayCandidate !== null)", guard);
    const activeCheck = relaySource.indexOf("if (activeRelaySession !== null)", guard);
    expect(activeCheck).toBeGreaterThan(guard);
    expect(activeCheck).toBeLessThan(pendingCheck);
    expect(relaySource.slice(activeCheck, pendingCheck)).toContain(
      "The active Desktop relay must be stopped before starting another.",
    );
    expect(relaySource.slice(begin, start)).toContain("assertRelayCandidateMayBegin();");
    expect(relaySource.indexOf("assertRelayCandidateMayBegin();", start)).toBeLessThan(
      candidateAllocation,
    );
  });

  test("candidate dispatch alone is settlement-bound to exact session ports", () => {
    const start = relaySource.indexOf("export async function startRelay");
    const stop = relaySource.indexOf("export async function stopRelay", start);
    const source = relaySource.slice(start, stop);
    expect(source).toContain("settleBoundWork: (work) => candidateSession.settleBoundWork(work)");
    expect(relaySource).toContain("return (req, signal) => settleBoundWork(dispatch(req, signal));");
    expect(source).toContain("runShellOutputArtifactStore: candidateSession.runShellOutputArtifactStore");
    expect(source).toContain("browserPageSnapshotStore: candidateSession.browserPageSnapshotStore");
    expect(source).toContain("mediaSessions: candidateSession.mediaSessions");
    expect(source).toContain("browserCoordinateScales: candidateSession.browserCoordinateScales");
    expect(source).toContain("snapshotStore: candidateSession.browserPageSnapshotStore");
  });

  test("failed start retires first, attempts client then MCP cleanup, and preserves the original error", () => {
    const start = relaySource.indexOf("export async function startRelay");
    const stop = relaySource.indexOf("export async function stopRelay", start);
    const source = relaySource.slice(start, stop);
    const failure = source.slice(source.lastIndexOf("} catch (error) {"));
    const retire = failure.indexOf("const retired = candidateSession.retire();");
    const disconnect = failure.indexOf("await retired.client?.disconnect();");
    const stopMcp = failure.indexOf("await retired.mcpHost?.stop();");
    const finish = failure.indexOf("await candidateSession.finishRetirement();");
    const rethrow = failure.indexOf("throw error;");

    expect(retire).toBeGreaterThan(-1);
    expect(disconnect).toBeGreaterThan(retire);
    expect(stopMcp).toBeGreaterThan(disconnect);
    expect(finish).toBeGreaterThan(stopMcp);
    expect(rethrow).toBeGreaterThan(finish);
    expect(failure.match(/try \{/g)?.length).toBe(2);
  });

  test("stop detaches first, attempts MCP then client, finishes, and throws the first error", () => {
    const start = relaySource.indexOf("export async function stopRelay");
    const end = relaySource.indexOf("export function getRelayStatus", start);
    const source = relaySource.slice(start, end);
    const invalidate = source.indexOf("relayLifecycleGeneration += 1;");
    const pendingDetach = source.indexOf("pendingRelayCandidate = null;");
    const detach = source.indexOf("activeRelaySession = null;");
    const emptyReturn = source.indexOf("if (retiredSessions.length === 0)");
    const retire = source.indexOf("retired: session.retire(),");
    const stopMcp = source.indexOf("await retired.mcpHost?.stop();");
    const disconnect = source.indexOf("await retired.client?.disconnect();");
    const finish = source.indexOf("await session.finishRetirement();");

    expect(invalidate).toBeGreaterThan(-1);
    expect(pendingDetach).toBeGreaterThan(invalidate);
    expect(detach).toBeGreaterThan(pendingDetach);
    expect(retire).toBeGreaterThan(detach);
    expect(emptyReturn).toBeGreaterThan(retire);
    expect(stopMcp).toBeGreaterThan(retire);
    expect(disconnect).toBeGreaterThan(stopMcp);
    expect(finish).toBeGreaterThan(disconnect);
    expect(source).toContain("firstError ??= error;");
    expect(source).toContain("await previousRetirement;");
    expect(source).toContain("throw firstError instanceof Error ? firstError : new Error(\"Desktop relay shutdown failed.\");");
  });

  test("Google credential paths use the candidate tuple and retirement fence", () => {
    const start = relaySource.indexOf("export async function startRelay");
    const stop = relaySource.indexOf("export async function stopRelay", start);
    const source = relaySource.slice(start, stop);
    expect(source).toContain("googleOAuthContext: candidateSession.googleOAuthContext");
    expect(source).toContain("isSessionClosed: () => candidateSession.closed");
    expect(relaySource).not.toContain("setRelayGoogleOAuthContext");
    expect(providerRuntimeSource).toContain("if (isClosed()) throw new Error(\"Desktop relay session retired\")");
  });
});
