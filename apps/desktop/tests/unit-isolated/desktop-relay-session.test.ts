import { describe, expect, test } from "bun:test";
import type {
  BrowserPageReadResult,
  RelayClient,
  RelayStatus,
} from "@nautilo/relay";
import type { RelayMcpHostHandle } from "@nautilo/mcp-client";

import {
  DesktopRelaySession,
  type DesktopRelaySessionOptions,
} from "../../electron/desktop-relay-session.ts";
import type { RelayCapabilityPublisher } from "../../electron/relay-capability-publisher.ts";
import type { MediaSessionRecord } from "../../electron/relay-dispatch/media.ts";
import type { StructuredSshDispatchRuntime } from "../../electron/relay-dispatch/structured-ssh.ts";
import type { BrowserPageSnapshotOwnerBinding } from "../../electron/browser-page-snapshot-store.ts";
import type { RunShellOutputOwnerBinding } from "../../electron/run-shell-output-continuity.ts";

const OWNER: RunShellOutputOwnerBinding & BrowserPageSnapshotOwnerBinding = {
  instanceId: "instance-1",
  userId: "user-1",
  relayId: "relay-1",
  desktopSessionId: "desktop-1",
};

function createSession(overrides: Partial<DesktopRelaySessionOptions> = {}) {
  return new DesktopRelaySession({
    serverUrl: "https://server.example",
    token: "oauth-token",
    clientPath: "/private/oauth-client.json",
    ...overrides,
  });
}

function page(content: string): BrowserPageReadResult {
  return {
    targetRole: "interactive",
    finalUrl: "https://example.test/article",
    title: "Example article",
    content,
    blocks: [],
    totalCharacters: content.length,
    totalCharactersCapped: false,
    totalBytes: Buffer.byteLength(content, "utf8"),
    estimatedTokens: Math.ceil(content.length / 4),
    offsetCharacters: 0,
    nextOffsetCharacters: content.length,
    returnedCharacters: content.length,
    remainingCharacters: 0,
    eof: true,
    truncated: false,
    contextClamped: false,
    extraction: {
      method: "mozilla-readability-turndown-v1",
      root: "article",
      iframeCount: 0,
    },
    timing: { readiness: "complete" },
    quality: "complete",
    challenge: { detected: false, confidence: "none", signals: [] },
    failure: "none",
    diagnostics: [],
  };
}

function transportFixtures() {
  let publisherCloseCount = 0;
  const client = { identity: "client" } as unknown as RelayClient;
  const mcpHost = { identity: "mcp" } as unknown as RelayMcpHostHandle;
  const publisher = {
    close: () => {
      publisherCloseCount += 1;
    },
  } as unknown as RelayCapabilityPublisher;
  return {
    client,
    mcpHost,
    publisher,
    publisherCloseCount: () => publisherCloseCount,
  };
}

function mediaRecord(source: Buffer, audio?: Buffer): MediaSessionRecord {
  return {
    source: [source],
    expectedIndex: 1,
    chunkCount: 1,
    totalBytes: source.byteLength,
    receivedBytes: source.byteLength,
    createdAt: Date.now(),
    ...(audio === undefined ? {} : { audio }),
  };
}

describe("DesktopRelaySession", () => {
  test("freezes its exact Google OAuth tuple and exposes owned resources read-only", () => {
    const session = createSession();
    const oauth = session.googleOAuthContext;

    expect(oauth).toEqual({
      serverUrl: "https://server.example",
      token: "oauth-token",
      clientPath: "/private/oauth-client.json",
    });
    expect(Object.isFrozen(oauth)).toBe(true);
    expect(session.runShellOutputArtifactStore).toBe(
      session.runShellOutputArtifactStore,
    );
    expect(session.browserPageSnapshotStore).toBe(
      session.browserPageSnapshotStore,
    );
    expect(session.closed).toBe(false);
  });

  test("allows each optional attachment once and rejects double or post-retirement attachment", () => {
    const session = createSession();
    const fixtures = transportFixtures();
    const ssh = { identity: "ssh" } as unknown as StructuredSshDispatchRuntime;

    session.attachMcpHost(fixtures.mcpHost);
    session.attachTransport(fixtures.client, fixtures.publisher);
    session.attachStructuredSshRuntime(ssh);
    expect(session.mcpHost).toBe(fixtures.mcpHost);
    expect(session.client).toBe(fixtures.client);
    expect(session.publisher).toBe(fixtures.publisher);
    expect(session.structuredSshRuntime).toBe(ssh);
    expect(() => session.attachMcpHost(fixtures.mcpHost)).toThrow("already attached");
    expect(() => session.attachTransport(fixtures.client, fixtures.publisher)).toThrow("already attached");
    expect(() => session.attachStructuredSshRuntime(ssh)).toThrow("already attached");

    session.retire();
    expect(() => session.attachMcpHost(fixtures.mcpHost)).toThrow("retired");
  });

  test("retires partial starts synchronously and returns detached transport exactly once", () => {
    const partial = createSession();
    const partialFixtures = transportFixtures();
    partial.attachMcpHost(partialFixtures.mcpHost);

    expect(partial.retire()).toEqual({
      client: null,
      mcpHost: partialFixtures.mcpHost,
    });
    expect(partial.retire()).toEqual({ client: null, mcpHost: null });

    const complete = createSession();
    const completeFixtures = transportFixtures();
    complete.attachMcpHost(completeFixtures.mcpHost);
    complete.attachTransport(completeFixtures.client, completeFixtures.publisher);
    const detached = complete.retire();

    expect(detached).toEqual({
      client: completeFixtures.client,
      mcpHost: completeFixtures.mcpHost,
    });
    expect(detached.client).toBe(completeFixtures.client);
    expect(detached.mcpHost).toBe(completeFixtures.mcpHost);
    expect(complete.publisher).toBeNull();
    expect(completeFixtures.publisherCloseCount()).toBe(1);
    complete.retire();
    expect(completeFixtures.publisherCloseCount()).toBe(1);
  });

  test("zeroes media bytes and makes media and coordinate ports inert before returning", () => {
    const session = createSession();
    const source = Buffer.from("source-secret");
    const audio = Buffer.from("audio-secret");
    const record = mediaRecord(source, audio);
    session.mediaSessions.adjustBufferedBytes(source.byteLength + audio.byteLength);
    session.mediaSessions.set("media-1", record);
    session.browserCoordinateScales.set("browser-1", 2);

    session.retire();

    expect(source.equals(Buffer.alloc(source.byteLength))).toBe(true);
    expect(audio.equals(Buffer.alloc(audio.byteLength))).toBe(true);
    expect(session.mediaSessions.size()).toBe(0);
    expect(session.mediaSessions.getBufferedBytes()).toBe(0);
    expect(session.mediaSessions.get("media-1")).toBeUndefined();
    expect(session.browserCoordinateScales.get("browser-1")).toBeUndefined();

    const lateBytes = Buffer.from("late");
    session.mediaSessions.set("late", mediaRecord(lateBytes));
    session.mediaSessions.adjustBufferedBytes(lateBytes.byteLength);
    session.browserCoordinateScales.set("late", 3);
    expect(session.mediaSessions.has("late")).toBe(false);
    expect(session.mediaSessions.getBufferedBytes()).toBe(0);
    expect(session.browserCoordinateScales.get("late")).toBeUndefined();
  });

  test("clears OAuth, SSH, output, and browser snapshots while retaining callback until final retirement", async () => {
    const statuses: RelayStatus[] = [];
    const session = createSession({ onStatusChange: (status) => statuses.push(status) });
    const ssh = { identity: "ssh" } as unknown as StructuredSshDispatchRuntime;
    session.attachStructuredSshRuntime(ssh);

    const draft = session.runShellOutputArtifactStore.createDraft(OWNER);
    draft.append("stdout", Buffer.from("retained output"), 15);
    const artifact = draft.commit();
    const snapshot = session.browserPageSnapshotStore.create(
      OWNER,
      page("retained browser text"),
    );
    expect(snapshot.ok).toBe(true);

    session.retire();

    expect(session.googleOAuthContext).toBeNull();
    expect(session.structuredSshRuntime).toBeNull();
    expect(session.runShellOutputArtifactStore.read({
      reference: artifact.reference,
      owner: OWNER,
      deleteAfterRead: false,
      offsetBytes: 0,
      maxBytes: 1024,
    })).toBeNull();
    expect(session.browserPageSnapshotStore.debugState()).toEqual({
      entries: 0,
      retainedBytes: 0,
    });
    expect(session.statusCallback).not.toBeNull();
    session.statusCallback?.("disconnected");
    expect(statuses).toEqual(["disconnected"]);

    await session.finishRetirement();
    expect(session.statusCallback).toBeNull();
  });

  test("sweeps resources populated by late bound work without touching a replacement session", async () => {
    const retired = createSession();
    const replacement = createSession({ serverUrl: "https://replacement.example" });
    let finishWork!: () => void;
    const work = new Promise<void>((resolve) => {
      finishWork = resolve;
    });
    const settled = retired.settleBoundWork(work);
    retired.retire();
    let retirementFinished = false;
    const retirement = retired.finishRetirement().then(() => {
      retirementFinished = true;
    });

    const retiredDraft = retired.runShellOutputArtifactStore.createDraft(OWNER);
    retiredDraft.append("stdout", Buffer.from("late retired output"), 19);
    const retiredArtifact = retiredDraft.commit();
    const replacementDraft = replacement.runShellOutputArtifactStore.createDraft(OWNER);
    replacementDraft.append("stdout", Buffer.from("replacement output"), 18);
    const replacementArtifact = replacementDraft.commit();

    await Promise.resolve();
    expect(retirementFinished).toBe(false);
    finishWork();
    await settled;
    await retirement;
    expect(retirementFinished).toBe(true);

    expect(retired.runShellOutputArtifactStore.read({
      reference: retiredArtifact.reference,
      owner: OWNER,
      deleteAfterRead: false,
      offsetBytes: 0,
      maxBytes: 1024,
    })).toBeNull();
    expect(replacement.runShellOutputArtifactStore.read({
      reference: replacementArtifact.reference,
      owner: OWNER,
      deleteAfterRead: false,
      offsetBytes: 0,
      maxBytes: 1024,
    })?.stdout).toBe("replacement output");
    expect(replacement.googleOAuthContext?.serverUrl).toBe(
      "https://replacement.example",
    );
  });

  test("preserves bound-work fulfillment and rejection while applying the retired sweep", async () => {
    const fulfilled = createSession();
    fulfilled.retire();
    expect(await fulfilled.settleBoundWork(Promise.resolve("done"))).toBe("done");

    const rejected = createSession();
    rejected.retire();
    const failure = new Error("late failure");
    let observed: unknown;
    try {
      await rejected.settleBoundWork(Promise.reject(failure));
    } catch (error) {
      observed = error;
    }
    expect(observed).toBe(failure);
  });
});
