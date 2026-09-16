import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NautiloApiClient } from "../../src/client";
import {
  createRemotePairingChallengeResponseSchema,
  remoteControllerSchema,
  remoteHostPresenceEventSchema,
  remoteHostSchema,
  remoteHostSnapshotEventSchema,
  remoteHostSnapshotResponseSchema,
  listRemoteHostFilesResponseSchema,
} from "../../src/schemas/remote-control";

const CHALLENGE_ID = "00000000-0000-4000-8000-000000000061";
const BINDING_ID = "00000000-0000-4000-8000-000000000071";
const INSTALLATION_ID = "00000000-0000-4000-8000-000000000081";

function urlOf(input: Parameters<typeof fetch>[0]): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

describe("D458 remote-controller api client", () => {
  let realFetch: typeof fetch;
  beforeEach(() => { realFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = realFetch; });

  test("challenge request uses a fresh session and response contains no credentials", async () => {
    let method = "";
    let url = "";
    let auth = "";
    const mock = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      method = init?.method ?? "GET";
      url = urlOf(input);
      auth = (init?.headers as Record<string, string>)?.["Authorization"] ?? "";
      return new Response(JSON.stringify({
        deepLink: `nautilo://remote/pair?challengeId=${CHALLENGE_ID}&secret=q1`,
        challengeId: CHALLENGE_ID,
        ceremonyContext: "ab".repeat(32),
        qrSecret: "q1",
        manualCode: "ABCDE12345FG",
        expiresAt: "2026-07-27T00:00:00.000Z",
      }), { status: 200, headers: { "content-type": "application/json" } });
    };
    globalThis.fetch = Object.assign(mock, { preconnect: realFetch.preconnect.bind(realFetch) }) as typeof fetch;
    const client = new NautiloApiClient("http://server.test");
    client.setToken("bearer");
    const response = await client.createRemotePairingChallenge({ relayId: "relay-1" });
    expect(method).toBe("POST");
    expect(url).toBe("http://server.test/api/remote/challenges");
    expect(auth).toBe("Bearer bearer");
    expect(JSON.stringify(response)).not.toContain("relayToken");
    expect(JSON.stringify(response)).not.toContain("verifierDigest");
  });

  test("host/controller projections reject relay and installation selectors", () => {
    const parsed = remoteControllerSchema.parse({
      bindingId: BINDING_ID, installationId: INSTALLATION_ID, label: null,
      remoteHostId: BINDING_ID, createdAt: "2026-07-27T00:00:00.000Z", lastSeenAt: null,
    });
    expect(Object.keys(parsed)).not.toContain("relayToken");
    expect(Object.keys(parsed)).not.toContain("verifierDigest");
    expect(remoteHostSchema.safeParse({
      remoteHostId: BINDING_ID, label: "My Mac", connected: true, readiness: "compatible_online", lastSeenAt: null,
      relayId: "private-relay-id",
    }).success).toBe(false);
    expect(remoteHostSchema.safeParse({
      remoteHostId: BINDING_ID, label: "My Mac", connected: true, readiness: "compatible_online", lastSeenAt: null,
      hostInstallationId: "private-installation-id",
    }).success).toBe(false);
    expect(createRemotePairingChallengeResponseSchema.safeParse({
      challengeId: "c1", ceremonyContext: "ab".repeat(32), qrSecret: "q", manualCode: "m", expiresAt: "x",
    }).success).toBe(false);
  });

  test("snapshot and ordered presence stream are browser-safe and reconcilable", () => {
    const host = {
      remoteHostId: BINDING_ID, label: "Studio Mac", connected: true, readiness: "compatible_online",
      lastSeenAt: "2026-07-27T00:00:00.000Z",
    };
    const snapshot = remoteHostSnapshotResponseSchema.parse({
      hosts: [host],
      cursor: { streamId: "presence-stream-a", sequence: 12, snapshotRevision: 4 },
    });
    expect(snapshot.cursor.sequence).toBe(12);
    expect(remoteHostSnapshotEventSchema.parse({
      type: "remote.host.snapshot",
      ...snapshot,
    }).cursor.snapshotRevision).toBe(4);

    const event = remoteHostPresenceEventSchema.parse({
      type: "remote.host.updated", eventId: "event-13", remoteHostId: BINDING_ID,
      streamId: "presence-stream-a", sequence: 13, snapshotRevision: 5, host,
    });
    expect(event.type).toBe("remote.host.updated");
    expect(JSON.stringify(event)).not.toContain("relayId");
    expect(JSON.stringify(event)).not.toContain("desktopSessionId");
  });

  test("strict host projection rejects every known internal selector or workspace field", () => {
    const safeHost = {
      remoteHostId: BINDING_ID, label: "Studio Mac", connected: false, readiness: "offline",
      lastSeenAt: null,
    };
    const forbidden = [
      "relayId",
      "relayToken",
      "hostInstallationId",
      "desktopSessionId",
      "pairingGeneration",
      "serverInstanceId",
      "workspaceRoot",
      "rootPath",
      "capabilities",
    ] as const;
    for (const field of forbidden) {
      expect(remoteHostSchema.safeParse({ ...safeHost, [field]: "private" }).success).toBe(false);
    }
  });

  test("Computer Files uses a signed POST body and accepts no private root metadata", async () => {
    let method = "";
    let url = "";
    let body = "";
    let mobileOrigin = "";
    const mock = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      method = init?.method ?? "GET";
      url = urlOf(input);
      body = typeof init?.body === "string" ? init.body : "";
      mobileOrigin = (init?.headers as Record<string, string>)?.["X-Nautilo-Mobile-Origin"] ?? "";
      return new Response(JSON.stringify({
        entries: [{ name: "notes.md", path: "notes.md", isDirectory: false, isFile: true, isSymbolicLink: false }],
        nextCursor: null,
      }), { status: 200, headers: { "content-type": "application/json" } });
    };
    globalThis.fetch = Object.assign(mock, { preconnect: realFetch.preconnect.bind(realFetch) }) as typeof fetch;
    const client = new NautiloApiClient("http://server.test");
    await client.listRemoteHostFiles(
      { remoteHostId: BINDING_ID, rootKind: "workspace", relativePath: "" },
      { mobileOriginProof: { proof: "opaque" } as never },
    );
    expect(method).toBe("POST");
    expect(url).toBe("http://server.test/api/remote/host-files/list");
    expect(body).toBe(JSON.stringify({ remoteHostId: BINDING_ID, rootKind: "workspace", relativePath: "" }));
    expect(mobileOrigin).toBe(JSON.stringify({ proof: "opaque" }));
    expect(listRemoteHostFilesResponseSchema.safeParse({
      entries: [], nextCursor: null, root: "/private/path",
    }).success).toBe(false);
  });

  test("Current Folder selection sends only exact host and root-relative choice", async () => {
    let url = "";
    let body = "";
    const mock = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      url = urlOf(input);
      body = typeof init?.body === "string" ? init.body : "";
      return new Response(JSON.stringify({ ok: true, label: "project" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    globalThis.fetch = Object.assign(mock, { preconnect: realFetch.preconnect.bind(realFetch) }) as typeof fetch;
    const client = new NautiloApiClient("http://server.test");
    await client.selectRemoteHostCurrentFolder(
      { remoteHostId: BINDING_ID, sourceRootKind: "workspace", relativePath: "projects/project" },
      { mobileOriginProof: { proof: "opaque" } as never },
    );
    expect(url).toBe("http://server.test/api/remote/current-folder/select");
    expect(body).toBe(JSON.stringify({
      remoteHostId: BINDING_ID,
      sourceRootKind: "workspace",
      relativePath: "projects/project",
    }));
    expect(body).not.toContain("/Users/");
  });
});
