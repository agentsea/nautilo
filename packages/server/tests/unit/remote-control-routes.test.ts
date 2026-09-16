import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ed25519 } from "@noble/curves/ed25519.js";
import Fastify from "fastify";
import { RELAY_PROTOCOL_VERSION } from "@nautilo/relay";
import { canonicalRemotePairingTranscript } from "@nautilo/types";
import type { RemotePairingStore } from "../../src/remote-control/pairing-store";
import { remoteControlRoutes } from "../../src/routes/remote-control";
import { digestPairingVerifier, requirePairingPepper } from "../../src/remote-control/pairing-secrets";

const USER = "00000000-0000-4000-8000-000000000001";
const OTHER_USER = "00000000-0000-4000-8000-000000000002";
const ACTOR = "00000000-0000-4000-8000-000000000011";
const SERVER = "00000000-0000-4000-8000-000000000021";
const RELAY_TOKEN = "00000000-0000-4000-8000-000000000031";
const HOST = "00000000-0000-4000-8000-000000000041";
const INSTALLATION = "00000000-0000-4000-8000-000000000051";
const CONTROLLER = "00000000-0000-4000-8000-000000000052";
const BINDING = "00000000-0000-4000-8000-000000000071";
const PEPPER = "0123456789abcdef0123456789abcdef";

type Challenge = Awaited<ReturnType<RemotePairingStore["findChallengeForVerification"]>>;

function createStore() {
  let challenge: NonNullable<Challenge> | null = null;
  let failures = 0;
  let installationWrites = 0;
  let hostReads = 0;
  let consumed = false;
  let renamed = false;
  let revoked = false;
  const store: RemotePairingStore = {
    ensureControllerInstallation: async () => {
      installationWrites += 1;
      return { id: "controller-row", installationGeneration: 1 };
    },
    createChallenge: async (input) => {
      consumed = false;
      challenge = {
        id: "00000000-0000-4000-8000-000000000061",
        version: 1,
        serverInstanceId: input.serverInstanceId,
        serverBindingGeneration: input.serverBindingGeneration,
        userId: input.userId,
        actorId: input.actorId,
        relayTokenId: input.relayTokenId,
        hostInstallationId: input.hostInstallationId,
        desktopSessionId: input.desktopSessionId,
        pairingGeneration: input.pairingGeneration,
        qrVerifierDigest: input.qrVerifierDigest,
        manualVerifierDigest: input.manualVerifierDigest ?? null,
        expiresAt: input.expiresAt,
        consumedAt: null,
        revokedAt: null,
        failedAttempts: 0,
      };
      return { id: challenge.id, version: challenge.version };
    },
    findChallengeForVerification: async () => challenge,
    findChallengeForManualVerifier: async ({ manualVerifierDigest }) =>
      challenge?.manualVerifierDigest === manualVerifierDigest ? challenge : null,
    recordFailedVerifierAttempt: async () => {
      failures += 1;
      return "rejected";
    },
    consumeChallengeAndCreateBinding: async () => {
      if (!challenge || consumed || challenge.expiresAt.getTime() <= Date.now()) return "conflict";
      consumed = true;
      return "committed";
    },
    consumeChallengeEnsureInstallationAndCreateBinding: async () => {
      installationWrites += 1;
      if (!challenge || consumed || challenge.expiresAt.getTime() <= Date.now()) {
        return { outcome: "conflict" };
      }
      consumed = true;
      return {
        outcome: "committed",
        controllerInstallationId: "controller-row",
        bindingId: "binding-row",
        installationGeneration: 1,
      };
    },
    revokeBindingForUser: async () => revoked,
    revokeChallenge: async () => false,
    cleanupExpiredChallenges: async () => 0,
    findActiveRelayForUser: async ({ relayTokenId, userId, actorId }) =>
      relayTokenId === RELAY_TOKEN && userId === USER && actorId === ACTOR
        ? { relayTokenId: RELAY_TOKEN, hostInstallationId: HOST, label: "Mac", revokedAt: null }
        : null,
    listPairedHostRowsForUser: async () => {
      hostReads += 1;
      return [{
      remoteHostId: "00000000-0000-4000-8000-000000000061",
      label: "Mac",
      pairingGeneration: RELAY_TOKEN,
      durableLastSeenAt: null,
      durableCapabilities: { profile: "desktop-agent" },
      }];
    },
    listPairedHostRowsForController: async ({ controllerInstallationId }) => {
      hostReads += 1;
      return controllerInstallationId === CONTROLLER
        ? {
            controllerLabel: "iPhone simulator",
            rows: [{
              remoteHostId: "00000000-0000-4000-8000-000000000061",
              label: "Mac",
              pairingGeneration: RELAY_TOKEN,
              durableLastSeenAt: null,
            }],
          }
        : { controllerLabel: null, rows: [] };
    },
    listActiveHostBindingsForController: async ({ controllerInstallationId }) =>
      controllerInstallationId === CONTROLLER
        ? [{ bindingId: BINDING, pairingGeneration: RELAY_TOKEN, label: "Mac" }]
        : [],
    listControllerBindingsForUser: async () => [],
    renameControllerInstallationForUser: async () => renamed,
    findControllerOriginForOrdinaryRequest: async () => null,
  };
  return {
    store,
    get challenge() { return challenge; },
    setExpired() { if (challenge) challenge.expiresAt = new Date(0); },
    setRenamed(value: boolean) { renamed = value; },
    setRevoked(value: boolean) { revoked = value; },
    get failures() { return failures; },
    get installationWrites() { return installationWrites; },
    get hostReads() { return hostReads; },
  };
}

function proof(challengeId: string, ceremonyContext: string) {
  const key = ed25519.keygen(new Uint8Array(32).fill(9));
  const publicKey = Buffer.from(key.publicKey).toString("hex");
  const transcript = canonicalRemotePairingTranscript({
    challengeId,
    ceremonyContext,
    installationId: INSTALLATION,
    algorithm: "Ed25519",
    publicKey,
  });
  return {
    algorithm: "Ed25519",
    ceremonyContext,
    publicKey,
    signature: Buffer.from(ed25519.sign(new TextEncoder().encode(transcript), key.secretKey)).toString("hex"),
  };
}

function responseBody(response: { body: string }): unknown {
  return JSON.parse(response.body) as unknown;
}

function responseJson<T>(response: { body: string }): T {
  return responseBody(response) as T;
}

async function makeApp(input: {
  verdict?: "active" | "inactive" | "unavailable";
  store?: ReturnType<typeof createStore>;
  currentFolderRoot?: string | null;
} = {}) {
  const app = Fastify();
  app.decorateRequest("sessionUserId", null);
  app.decorateRequest("sessionActorId", null);
  app.decorateRequest("accessTokenIssuedAt", null);
  app.decorateRequest("resolvedPrincipal", null);
  app.addHook("preHandler", async (request) => {
    const wrong = request.headers["x-test-user"] === "other";
    (request as unknown as { sessionUserId: string }).sessionUserId = wrong ? OTHER_USER : USER;
    (request as unknown as { sessionActorId: string }).sessionActorId = ACTOR;
    (request as unknown as { accessTokenIssuedAt: number }).accessTokenIssuedAt = Math.floor(Date.now() / 1000);
    (request as unknown as { resolvedPrincipal: { logtoSub: string } }).resolvedPrincipal = { logtoSub: "logto-sub" };
  });
  const state = input.store ?? createStore();
  let remoteMutations = 0;
  const fileDispatches: Array<{ relayId: string; request: { op: string; path: string; allowedRoots: string[] } }> = [];
  const controlDispatches: Array<{ relayId: string; request: Record<string, unknown> }> = [];
  const remoteRevocations: Array<{ userId: string; remoteHostId: string }> = [];
  remoteControlRoutes(app, {
    store: state.store,
    registry: {
      snapshotForUser: () => [{
        relayId: "relay-live",
        userId: USER,
        pairingGeneration: RELAY_TOKEN,
        desktopSessionId: "desktop-session",
        protocolVersion: RELAY_PROTOCOL_VERSION,
        lastSeenAt: Date.now(),
        capabilities: { profile: "desktop-agent", canControlDesktop: true },
      }],
      getCapabilities: () => ({
        profile: "desktop-agent",
        canReadWorkspace: true,
        canBrowsePairedFilesystem: true,
        workspaceRoot: "/Users/alice/Documents/Nautilo",
        currentFolderRoot: input.currentFolderRoot === undefined ? "/Users/alice/project" : input.currentFolderRoot,
      }),
      fsDispatch: async (relayId, request) => {
        fileDispatches.push({ relayId, request });
        if (request.op === "readdir") {
          return {
            ok: true,
            entries: [
              { name: "notes.md", dir: false, file: true, symlink: false },
              { name: "src", dir: true, file: false, symlink: false },
            ],
          };
        }
        if (request.op === "readFile") return { ok: true, dataBase64: Buffer.from("hello").toString("base64") };
        if (request.op === "lstat") {
          return {
            ok: true,
            stat: {
              size: 5, mtimeMs: 1, birthtimeMs: 1, mode: 0o644,
              isFile: true, isDirectory: false, isSymbolicLink: false, isFIFO: false, isSocket: false,
            },
          };
        }
        return {
          ok: true,
          stat: {
            size: 0, mtimeMs: 1, birthtimeMs: 1, mode: 0o755,
            isFile: false, isDirectory: true, isSymbolicLink: false, isFIFO: false, isSocket: false,
          },
        };
      },
      dispatch: async (relayId, request) => {
        controlDispatches.push({ relayId, request });
        if (request.toolName === "nautilo_paired_filesystem_directory") {
          return {
            status: "ok" as const,
            result: {
              entries: [{ name: "Home", path: "loc_home", isDirectory: true, isFile: false, isSymbolicLink: false }],
              nextCursor: "Home",
            },
          };
        }
        return { status: "ok", result: { ok: true, label: "project" } };
      },
    },
    getServerIdentity: async () => ({ serverInstanceId: SERVER, serverBindingGeneration: 1 }),
    verifyActiveUser: async () => input.verdict ?? "active",
    admitOrigin: async ({ mobileHeader }) =>
      mobileHeader === "valid-mobile-proof"
        ? {
            status: "verified",
            origin: {
              kind: "paired_mobile",
              serverInstanceId: SERVER,
              serverBindingGeneration: 1,
              userId: USER,
              actorId: ACTOR,
              controllerInstallationId: CONTROLLER,
              installationGeneration: 1,
              requestId: "00000000-0000-4000-8000-000000000099",
            },
          }
        : { status: "denied" },
    onRemoteHostMutation: () => { remoteMutations += 1; },
    onRemoteHostRevoked: (revocation) => {
      remoteMutations += 1;
      remoteRevocations.push(revocation);
    },
  });
  await app.ready();
  return {
    app,
    state,
    remoteRevocations,
    fileDispatches,
    controlDispatches,
    get remoteMutations() { return remoteMutations; },
  };
}

describe("D458 remote-control routes", () => {
  let previousPepper: string | undefined;
  beforeEach(() => { previousPepper = process.env["NAUTILO_REMOTE_PAIRING_PEPPER"]; process.env["NAUTILO_REMOTE_PAIRING_PEPPER"] = PEPPER; });
  afterEach(() => {
    if (previousPepper === undefined) delete process.env["NAUTILO_REMOTE_PAIRING_PEPPER"];
    else process.env["NAUTILO_REMOTE_PAIRING_PEPPER"] = previousPepper;
  });

  test("QR and manual code consume the same secret-free ceremony path", async () => {
    const { app, state } = await makeApp();
    const created = await app.inject({ method: "POST", url: "/api/remote/challenges", payload: { relayId: "relay-live" } });
    expect(created.statusCode).toBe(200);
    const qr = responseJson<{ challengeId: string; ceremonyContext: string; qrSecret: string; manualCode: string; deepLink: string }>(created);
    expect(JSON.stringify(qr)).not.toContain("relayToken");
    expect(JSON.stringify(qr)).not.toContain("Digest");
    expect(qr.deepLink).toContain("nautilo://remote/pair?");
    expect(qr.deepLink).toContain(`challengeId=${qr.challengeId}`);
    expect(qr.deepLink).toContain(`ceremonyContext=${qr.ceremonyContext}`);
    for (const privateValue of [RELAY_TOKEN, HOST, SERVER, ACTOR]) {
      expect(qr.deepLink).not.toContain(privateValue);
    }
    const first = await app.inject({
      method: "POST", url: "/api/remote/challenges/consume",
      payload: { challengeId: qr.challengeId, secret: qr.qrSecret, installationId: INSTALLATION, proof: proof(qr.challengeId, qr.ceremonyContext) },
    });
    expect(first.statusCode).toBe(200);
    expect(responseBody(first)).toEqual({
      ok: true,
      installationId: INSTALLATION,
      controllerInstallationId: "controller-row",
      bindingId: "binding-row",
      installationGeneration: 1,
      serverInstanceId: SERVER,
      serverBindingGeneration: 1,
    });

    const secondCreated = await app.inject({ method: "POST", url: "/api/remote/challenges", payload: { relayId: "relay-live" } });
    const manual = responseJson<{ challengeId: string; manualCode: string }>(secondCreated);
    const prepared = await app.inject({ method: "POST", url: "/api/remote/challenges/manual/prepare", payload: { manualCode: manual.manualCode } });
    const manualInputs = responseJson<{ challengeId: string; ceremonyContext: string }>(prepared);
    expect(JSON.stringify(manualInputs)).not.toContain("Digest");
    const manualConsume = await app.inject({
      method: "POST", url: "/api/remote/challenges/consume",
      payload: { challengeId: manualInputs.challengeId, secret: manual.manualCode, installationId: INSTALLATION, proof: proof(manualInputs.challengeId, manualInputs.ceremonyContext) },
    });
    expect(manualConsume.statusCode).toBe(200);
    await app.close();
    expect(state.challenge).not.toBeNull();
  });

  test("wrong owner, inactive/unavailable Logto, expiry and replay all give the same denial", async () => {
    const { app, state } = await makeApp();
    const issued = await app.inject({ method: "POST", url: "/api/remote/challenges", payload: { relayId: "relay-live" } });
    const data = responseJson<{ challengeId: string; ceremonyContext: string; qrSecret: string }>(issued);
    state.setExpired();
    const cases = [
      await app.inject({ method: "POST", url: "/api/remote/challenges", headers: { "x-test-user": "other" }, payload: { relayId: "relay-live" } }),
      await app.inject({ method: "POST", url: "/api/remote/challenges/consume", payload: { challengeId: data.challengeId, secret: data.qrSecret, installationId: INSTALLATION, proof: proof(data.challengeId, data.ceremonyContext) } }),
    ];
    for (const response of cases) {
      expect(response.statusCode).toBe(403);
      expect(responseBody(response)).toEqual({ error: "remote_unavailable" });
    }
    expect(state.installationWrites).toBe(0);
    await app.close();
    const inactive = await makeApp({ verdict: "inactive" });
    const unavailable = await makeApp({ verdict: "unavailable" });
    for (const fixture of [inactive, unavailable]) {
      const response = await fixture.app.inject({ method: "POST", url: "/api/remote/challenges", payload: { relayId: "relay-live" } });
      expect(response.statusCode).toBe(403);
      expect(responseBody(response)).toEqual({ error: "remote_unavailable" });
      await fixture.app.close();
    }
  });

  test("invalid proof context, encoding, or signature cannot persist an installation", async () => {
    const { app, state } = await makeApp();
    const issued = await app.inject({ method: "POST", url: "/api/remote/challenges", payload: { relayId: "relay-live" } });
    const data = responseJson<{ challengeId: string; ceremonyContext: string; qrSecret: string }>(issued);
    const signed = proof(data.challengeId, data.ceremonyContext);
    const response = await app.inject({
      method: "POST",
      url: "/api/remote/challenges/consume",
      payload: {
        challengeId: data.challengeId,
        secret: data.qrSecret,
        installationId: INSTALLATION,
        proof: { ...signed, ceremonyContext: "00".repeat(32), signature: "0".repeat(128) },
      },
    });
    expect(response.statusCode).toBe(403);
    expect(responseBody(response)).toEqual({ error: "remote_unavailable" });
    expect(state.installationWrites).toBe(0);
    expect(state.failures).toBe(1);
    await app.close();
  });

  test("committed pairing and revocation request best-effort host reconciliation", async () => {
    const fixture = await makeApp();
    const { app, state } = fixture;
    const issued = await app.inject({ method: "POST", url: "/api/remote/challenges", payload: { relayId: "relay-live" } });
    const data = responseJson<{ challengeId: string; ceremonyContext: string; qrSecret: string }>(issued);
    const consumed = await app.inject({
      method: "POST",
      url: "/api/remote/challenges/consume",
      payload: { challengeId: data.challengeId, secret: data.qrSecret, installationId: INSTALLATION, proof: proof(data.challengeId, data.ceremonyContext) },
    });
    expect(consumed.statusCode).toBe(200);
    expect(fixture.remoteMutations).toBe(1);
    state.setRevoked(true);
    const revoked = await app.inject({ method: "DELETE", url: `/api/remote/controllers/${BINDING}` });
    expect(revoked.statusCode).toBe(200);
    expect(fixture.remoteMutations).toBe(2);
    expect(fixture.remoteRevocations).toEqual([
      { userId: USER, remoteHostId: BINDING },
    ]);
    await app.close();
  });

  test("five bad verifier submissions and cross-user rename/revoke are non-enumerating", async () => {
    const { app, state } = await makeApp();
    const issued = await app.inject({ method: "POST", url: "/api/remote/challenges", payload: { relayId: "relay-live" } });
    const data = responseJson<{ challengeId: string; ceremonyContext: string }>(issued);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await app.inject({
        method: "POST", url: "/api/remote/challenges/consume",
        payload: { challengeId: data.challengeId, secret: "bad", installationId: INSTALLATION, proof: proof(data.challengeId, data.ceremonyContext) },
      });
      expect(response.statusCode).toBe(403);
    }
    expect(state.failures).toBe(5);
    const rename = await app.inject({ method: "PATCH", url: "/api/remote/controllers/foreign", payload: { label: "Phone" } });
    const revoke = await app.inject({ method: "DELETE", url: "/api/remote/controllers/foreign" });
    expect(responseBody(rename)).toEqual({ error: "remote_unavailable" });
    expect(responseBody(revoke)).toEqual({ error: "remote_unavailable" });
    state.setRenamed(true);
    state.setRevoked(true);
    expect(responseBody(await app.inject({ method: "PATCH", url: `/api/remote/controllers/${BINDING}`, payload: { label: "Phone" } }))).toEqual({ ok: true });
    expect(responseBody(await app.inject({ method: "DELETE", url: `/api/remote/controllers/${BINDING}` }))).toEqual({ ok: true });
    await app.close();
  });

  test("a wrong user cannot burn another ceremony's verifier budget", async () => {
    const { app, state } = await makeApp();
    const issued = await app.inject({ method: "POST", url: "/api/remote/challenges", payload: { relayId: "relay-live" } });
    const data = responseJson<{ challengeId: string; ceremonyContext: string }>(issued);
    const response = await app.inject({
      method: "POST",
      url: "/api/remote/challenges/consume",
      headers: { "x-test-user": "other" },
      payload: { challengeId: data.challengeId, secret: "bad", installationId: INSTALLATION, proof: proof(data.challengeId, data.ceremonyContext) },
    });
    expect(responseBody(response)).toEqual({ error: "remote_unavailable" });
    expect(state.failures).toBe(0);
    await app.close();
  });

  test("host snapshot is binding-only, cursor-bearing, and a single durable projection read", async () => {
    const { app, state } = await makeApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/remote/hosts",
      headers: { "x-nautilo-mobile-origin": "valid-mobile-proof" },
    });
    expect(response.statusCode).toBe(200);
    const body = responseJson<{
      hosts: Array<Record<string, unknown>>;
      cursor: { streamId: string; sequence: number; snapshotRevision: number };
    }>(response);
    expect(body.cursor).toEqual({ streamId: "remote-hosts-snapshot-only", sequence: 0, snapshotRevision: 0 });
    expect(responseJson<{ controllerLabel: string }>(response).controllerLabel).toBe("iPhone simulator");
    expect(body.hosts[0]).toMatchObject({
      remoteHostId: "00000000-0000-4000-8000-000000000061",
      connected: true,
      readiness: "compatible_online",
    });
    expect(JSON.stringify(body)).not.toContain(RELAY_TOKEN);
    expect(JSON.stringify(body)).not.toContain(HOST);
    expect(state.hostReads).toBe(1);
    await app.close();
  });

  test("host snapshot denies an absent or invalid phone proof", async () => {
    const { app, state } = await makeApp();
    for (const headers of [{}, { "x-nautilo-mobile-origin": "wrong" }]) {
      const response = await app.inject({
        method: "GET",
        url: "/api/remote/hosts",
        headers,
      });
      expect(response.statusCode).toBe(403);
      expect(responseBody(response)).toEqual({ error: "remote_unavailable" });
    }
    expect(state.hostReads).toBe(0);
    await app.close();
  });

  test("Computer Files binds a signed phone to its exact durable host and never returns private roots", async () => {
    const { app, fileDispatches } = await makeApp();
    const payload = { remoteHostId: BINDING, rootKind: "workspace", relativePath: "" };
    const denied = await app.inject({
      method: "POST",
      url: "/api/remote/host-files/list",
      payload,
    });
    expect(denied.statusCode).toBe(403);
    const response = await app.inject({
      method: "POST",
      url: "/api/remote/host-files/list",
      headers: { "x-nautilo-mobile-origin": "valid-mobile-proof" },
      payload,
    });
    expect(response.statusCode).toBe(200);
    expect(responseJson<{
      entries: Array<{ name: string; path: string; isDirectory: boolean; isFile: boolean; isSymbolicLink: boolean }>;
      nextCursor: string | null;
    }>(response)).toEqual({
      entries: [
        { name: "notes.md", path: "notes.md", isDirectory: false, isFile: true, isSymbolicLink: false },
        { name: "src", path: "src", isDirectory: true, isFile: false, isSymbolicLink: false },
      ],
      nextCursor: null,
    });
    expect(response.body).not.toContain("/Users/alice");
    expect(fileDispatches).toHaveLength(2);
    expect(fileDispatches.every((entry) =>
      entry.relayId === "relay-live" &&
      entry.request.allowedRoots.length === 1 &&
      entry.request.allowedRoots[0] === "/Users/alice/Documents/Nautilo",
    )).toBe(true);
    await app.close();
  });

  test("Computer Files reports missing Current Folder before relay filesystem dispatch", async () => {
    const { app, fileDispatches } = await makeApp({ currentFolderRoot: null });
    const response = await app.inject({
      method: "POST",
      url: "/api/remote/host-files/list",
      headers: { "x-nautilo-mobile-origin": "valid-mobile-proof" },
      payload: { remoteHostId: BINDING, rootKind: "current_folder", relativePath: "" },
    });
    expect(response.statusCode).toBe(409);
    expect(responseBody(response)).toEqual({ error: "no_current_folder" });
    expect(fileDispatches).toHaveLength(0);
    await app.close();
  });

  test("paired filesystem browsing is phone-proof-bound, opaque, directory-only, and never uses generic fs", async () => {
    const { app, fileDispatches, controlDispatches } = await makeApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/remote/host-files/list",
      headers: { "x-nautilo-mobile-origin": "valid-mobile-proof" },
      payload: { remoteHostId: BINDING, rootKind: "paired_filesystem", relativePath: "" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain("/Users/alice");
    expect(responseJson<{ nextCursor: string | null }>(response).nextCursor).toBe("SG9tZQ");
    expect(fileDispatches).toHaveLength(0);
    expect(controlDispatches).toEqual([{
      relayId: "relay-live",
      request: {
        toolName: "nautilo_paired_filesystem_directory",
        args: {
          rootKind: "paired_filesystem",
          operation: "list_directories",
          relativePath: "",
          limit: 50,
          includeHidden: false,
          query: "",
        },
        impact: "low",
        approvalObtained: true,
        executionClass: "desktop",
        timeout: 20_000,
      },
    }]);
    await app.close();
  });

  test("paired filesystem forbids stat and previews", async () => {
    const { app, fileDispatches } = await makeApp();
    for (const url of ["/api/remote/host-files/stat", "/api/remote/host-files/read"]) {
      const response = await app.inject({
        method: "POST",
        url,
        headers: { "x-nautilo-mobile-origin": "valid-mobile-proof" },
        payload: { remoteHostId: BINDING, rootKind: "paired_filesystem", relativePath: "loc_test/secret" },
      });
      expect(response.statusCode).toBe(409);
      expect(responseBody(response)).toEqual({ error: "unsupported" });
    }
    expect(fileDispatches).toHaveLength(0);
    await app.close();
  });

  test("Computer Files preview is proof-bound and returns only relative metadata plus bounded bytes", async () => {
    const { app } = await makeApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/remote/host-files/read",
      headers: { "x-nautilo-mobile-origin": "valid-mobile-proof" },
      payload: { remoteHostId: BINDING, rootKind: "workspace", relativePath: "notes.md" },
    });
    expect(response.statusCode).toBe(200);
    expect(responseJson<{
      entry: { path: string; size: number; mtimeMs: number; isFile: boolean; isDirectory: boolean; isSymbolicLink: boolean };
      dataBase64: string;
    }>(response)).toEqual({
      entry: {
        path: "notes.md", size: 5, mtimeMs: 1,
        isFile: true, isDirectory: false, isSymbolicLink: false,
      },
      dataBase64: Buffer.from("hello").toString("base64"),
    });
    await app.close();
  });

  test("Current Folder selection is phone-proof-bound to one exact host and carries no absolute path", async () => {
    const { app, controlDispatches } = await makeApp();
    const payload = {
      remoteHostId: BINDING,
      sourceRootKind: "workspace",
      relativePath: "projects/project",
    };
    const denied = await app.inject({
      method: "POST",
      url: "/api/remote/current-folder/select",
      payload,
    });
    expect(denied.statusCode).toBe(403);
    const response = await app.inject({
      method: "POST",
      url: "/api/remote/current-folder/select",
      headers: { "x-nautilo-mobile-origin": "valid-mobile-proof" },
      payload,
    });
    expect(response.statusCode).toBe(200);
    expect(responseBody(response)).toEqual({ ok: true, label: "project" });
    expect(controlDispatches).toEqual([{
      relayId: "relay-live",
      request: {
        toolName: "nautilo_current_folder_select",
        args: { sourceRootKind: "workspace", relativePath: "projects/project" },
        impact: "low",
        approvalObtained: true,
        executionClass: "desktop",
        timeout: 20_000,
      },
    }]);
    expect(JSON.stringify(controlDispatches)).not.toContain("/Users/alice");
    await app.close();
  });

  test("Current Folder selection rejects path traversal before relay dispatch", async () => {
    const { app, controlDispatches } = await makeApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/remote/current-folder/select",
      headers: { "x-nautilo-mobile-origin": "valid-mobile-proof" },
      payload: { remoteHostId: BINDING, sourceRootKind: "workspace", relativePath: "../private" },
    });
    expect(response.statusCode).toBe(400);
    expect(controlDispatches).toHaveLength(0);
    await app.close();
  });

  test("test fixture verifier digest is HMAC-backed rather than plaintext", () => {
    const digest = digestPairingVerifier(requirePairingPepper(), "manual", "ABCDEFGHJKLM");
    expect(digest).not.toBe("ABCDEFGHJKLM");
  });
});
