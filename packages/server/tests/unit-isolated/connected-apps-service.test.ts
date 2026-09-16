import { describe, expect, mock, test } from "bun:test";
import type {
  ConnectedAppOauthAttemptRow,
  ConnectedAppProfileRow,
  ConnectedAppProviderConfigRow,
  ConnectedAppScope,
} from "@nautilo/db";
import { BUNDLED_CONNECTION_PROVIDER_CATALOG } from "../../src/connected-apps/catalog";
import { OomolHostedConnectedAppDriver } from "../../src/connected-apps/hosted-driver";
import {
  LocalConnectedAppDriverError,
  OpenConnectorLocalConnectedAppDriver,
} from "../../src/connected-apps/local-driver";
import { ConnectedAppResultPresenter } from "../../src/connected-apps/result-presentation";
import { ConnectedAppArtifactInputError } from "../../src/connected-apps/artifact-input";
import {
  ConnectedAppService,
  type ConnectedAppStore,
} from "../../src/connected-apps/service";
import { connectedAppProviderDefinitions } from "../../src/connected-apps/providers";

const PROVIDERS = Object.fromEntries(
  connectedAppProviderDefinitions(BUNDLED_CONNECTION_PROVIDER_CATALOG).map((provider) => [provider.id, provider]),
);

const ATTEMPT_ID = "33333333-3333-4333-8333-333333333333";
const PROFILE_ID = "44444444-4444-4444-8444-444444444444";

function memoryStore(): ConnectedAppStore & {
  attempts: ConnectedAppOauthAttemptRow[];
  profiles: ConnectedAppProfileRow[];
} {
  const attempts: ConnectedAppOauthAttemptRow[] = [];
  const profiles: ConnectedAppProfileRow[] = [];
  const matches = (row: { userId: string; namespaceId: string }, scope: ConnectedAppScope) =>
    row.userId === scope.userId && row.namespaceId === scope.namespaceId;
  return {
    attempts,
    profiles,
    getProfile: async (scope, providerId, driverKind) => profiles.find((row) =>
      matches(row, scope) && row.providerId === providerId && row.driverKind === driverKind) ?? null,
    upsertProfile: async (input) => {
      const current = profiles.find((row) => matches(row, input)
        && row.providerId === input.providerId && row.driverKind === input.driverKind);
      const now = new Date();
      const row: ConnectedAppProfileRow = {
        ...input,
        id: current?.id ?? PROFILE_ID,
        revision: (current?.revision ?? -1) + 1,
        createdAt: current?.createdAt ?? now,
        updatedAt: now,
      };
      if (current) profiles.splice(profiles.indexOf(current), 1, row);
      else profiles.push(row);
      return row;
    },
    markUserProfilesState: async (userId, providerId, driverKind, status, lastErrorCode) => {
      for (const row of profiles) {
        if (row.userId === userId && row.providerId === providerId && row.driverKind === driverKind) {
          row.status = status;
          row.lastErrorCode = lastErrorCode;
          row.revision += 1;
        }
      }
    },
    deleteProfile: async (scope, providerId, driverKind) => {
      for (let index = profiles.length - 1; index >= 0; index -= 1) {
        const row = profiles[index];
        if (row && matches(row, scope) && row.providerId === providerId && row.driverKind === driverKind) {
          profiles.splice(index, 1);
        }
      }
    },
    getProviderConfig: async () => null,
    upsertProviderConfig: async () => { throw new Error("not used"); },
    findActiveAttempt: async (scope, providerId, driverKind) => attempts.find((row) =>
      matches(row, scope) && row.providerId === providerId && row.driverKind === driverKind
      && row.status === "connecting" && row.expiresAt > new Date()) ?? null,
    expireAttempts: async (scope, providerId, driverKind) => {
      for (const row of attempts) {
        if (matches(row, scope) && row.providerId === providerId && row.driverKind === driverKind
          && row.status === "connecting") {
          row.status = "expired";
          row.completedAt = new Date();
        }
      }
    },
    insertAttempt: async (input) => {
      const now = new Date();
      const row: ConnectedAppOauthAttemptRow = {
        ...input,
        id: ATTEMPT_ID,
        completedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      attempts.push(row);
      return row;
    },
    getAttempt: async (scope, attemptId) => attempts.find((row) =>
      matches(row, scope) && row.id === attemptId) ?? null,
    finishAttempt: async (scope, attemptId, status, errorCode) => {
      const row = attempts.find((candidate) => matches(candidate, scope)
        && candidate.id === attemptId && candidate.status === "connecting");
      if (!row) return false;
      row.status = status;
      row.errorCode = errorCode;
      row.completedAt = new Date();
      return true;
    },
  };
}

async function addConnectedLocalProfile(
  store: ConnectedAppStore,
  scope: ConnectedAppScope,
  providerId: "notion" | "canva" | "airtable" | "dropbox" = "notion",
): Promise<void> {
  const now = new Date();
  await store.upsertProfile({
    userId: scope.userId,
    namespaceId: scope.namespaceId,
    providerId,
    driverKind: "openconnector_local",
    status: "connected",
    connectedAccountId: `account-${scope.namespaceId}`,
    providerConfigId: `${providerId}-local-config`,
    connectionName: `connection-${scope.namespaceId}`,
    providerUserId: scope.userId,
    providerWorkspaceIdentity: `workspace-${scope.namespaceId}`,
    providerUserKind: "user",
    accountUsername: "member",
    accountDisplayName: "Member",
    accountEmail: "member@example.com",
    accountAvatarUrl: null,
    accountWorkspaceName: "Workspace",
    driverCredentialRefId: null,
    driverCredentialNamespaceId: null,
    driverCredentialAgentId: null,
    driverCredentialRecordId: null,
    lastErrorCode: null,
    connectedAt: now,
    lastVerifiedAt: now,
  });
}

function hostedGateway(providerId: "notion" | "slack" | "canva" = "notion"): {
  fetch: typeof fetch;
  actionPaths: string[];
  connectionRequestPolls(): number;
  setSearchDrift(value: boolean): void;
  setCreateDrift(value: boolean): void;
  setWriteDispatchFailure(value: boolean): void;
} {
  let externalUserId = "";
  let connectionName = "";
  const actionPaths: string[] = [];
  let searchDrift = false;
  let createDrift = false;
  let writeDispatchFailure = false;
  let requestPolls = 0;
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
    if (url.pathname.endsWith("/link")) {
      externalUserId = String(body["userId"]);
      connectionName = String(body["alias"]);
      return Response.json({ success: true, data: {
        id: "request-A", status: "initiated", projectId: "project-A",
        providerConfigId: "provider-A", externalUserId, service: providerId,
        alias: connectionName, authorizationUrl: `https://authorization.example/${providerId}`,
        connectedAccountId: null, errorCode: null, errorMessage: null,
        expiresAt: "2030-01-01T00:00:00Z", createdAt: 1, updatedAt: 1,
      } });
    }
    if (url.pathname.includes("/connection-requests/")) {
      requestPolls += 1;
      return Response.json({ success: true, data: {
      id: "request-A", status: "connected", projectId: "project-A",
      providerConfigId: "provider-A", externalUserId, service: providerId,
      alias: connectionName, authorizationUrl: `https://authorization.example/${providerId}`,
      connectedAccountId: "account-A", errorCode: null, errorMessage: null,
      expiresAt: "2030-01-01T00:00:00Z", createdAt: 1, updatedAt: 2,
      } });
    }
    if (url.pathname.endsWith("/profile")) return Response.json({ success: true, data: {
      connectedAccountId: "account-A", externalUserId, service: providerId, fetchedAt: 1,
      profile: { id: "provider-user-A", kind: "user", username: "alex", displayName: "Alex", email: null, avatarUrl: null, metadata: { workspaceId: "workspace-A", workspaceName: "Pilot Workspace" } },
    } });
    if (url.pathname.includes("/actions/")) {
      actionPaths.push(url.pathname);
      const actionId = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
      if (actionId === "notion.create_page" && writeDispatchFailure) {
        throw new TypeError("simulated transport loss after dispatch began");
      }
      return Response.json({ success: true, data: {
        output: actionId === "canva.get_design" ? {
          design: {
            id: "DAH-test",
            title: "Launch graphic",
            editUrl: "https://www.canva.com/design/DAH-test/edit",
            viewUrl: "https://www.canva.com/design/DAH-test/view",
            thumbnailUrl: "https://media.canva.com/preview.png",
            thumbnailWidth: 640,
            thumbnailHeight: 480,
            ownerUserId: null,
            ownerTeamId: null,
            createdAt: null,
            updatedAt: null,
          },
        } : actionId === "slack.list_conversations" ? {
          conversations: [{
            channelId: "C123", name: "general", type: "public_channel",
            isArchived: false, isPrivate: false, isMember: true,
            topic: null, purpose: null,
          }],
          nextCursor: null,
        } : actionId === "slack.post_message" ? {
          ts: "1711.0001", channelId: "C123",
        } : actionId === "slack.get_channel_messages" ? {
          messages: [{ ts: "1711.0001", userId: "U123", text: "Nautilo connection test" }],
          hasMore: false,
        } : actionId === "notion.search" && searchDrift ? { results: [] }
          : actionId === "notion.create_page" && createDrift ? { created: true }
          : actionId === "notion.search" ? {
          object: "list", results: [], next_cursor: null, has_more: false,
        } : {
          object: "page", id: "page-A",
          created_time: "2026-08-28T00:00:00.000Z",
          last_edited_time: "2026-08-28T00:00:00.000Z",
          parent: { workspace: true }, properties: {},
          url: "https://notion.so/page-A", is_archived: false, in_trash: false,
        },
        executionId: "execution-A", actionId, message: null,
      } });
    }
    return Response.json({ error: { code: "not_found" } }, { status: 404 });
  };
  return {
    fetch: fetchImpl as typeof fetch,
    actionPaths,
    connectionRequestPolls: () => requestPolls,
    setSearchDrift(value) { searchDrift = value; },
    setCreateDrift(value) { createDrift = value; },
    setWriteDispatchFailure(value) { writeDispatchFailure = value; },
  };
}

describe("D456 connected-app service", () => {
  test("returns the catalog-owned Canva descriptor with all 13 capabilities", async () => {
    const service = new ConnectedAppService(
      memoryStore(),
      { catalog: BUNDLED_CONNECTION_PROVIDER_CATALOG, source: "bundled", reason: null },
      "http://127.0.0.1:3001",
      null,
      "openconnector_local",
      null,
      PROVIDERS["canva"]!,
    );

    const [canva] = await service.list({
      userId: "11111111-1111-4111-8111-111111111111",
      namespaceId: "22222222-2222-4222-8222-222222222222",
    }, { canManageConnectionProviders: true });

    expect(canva).toMatchObject({
      id: "canva",
      displayName: "Canva",
      providerSetupStatus: "setup_required",
      canManageProviderSetup: true,
    });
    expect(canva?.capabilities).toHaveLength(13);
    expect(canva?.capabilities.map((capability) => capability.operationId)).toEqual(
      BUNDLED_CONNECTION_PROVIDER_CATALOG.providers
        .find((provider) => provider.id === "canva")?.operations
        .map((operation) => operation.sourceActionId),
    );
  });

  test("reports eligibility only for the exact connected Human×Namespace", async () => {
    const store = memoryStore();
    const gateway = hostedGateway();
    const driver = new OomolHostedConnectedAppDriver(
      "oo_proj_abcdefghijklmnopqrstuvwxyz123456",
      { fetch: gateway.fetch },
    );
    const catalog = { catalog: BUNDLED_CONNECTION_PROVIDER_CATALOG, source: "bundled" as const, reason: null };
    const connectedScope = {
      userId: "11111111-1111-4111-8111-111111111111",
      namespaceId: "22222222-2222-4222-8222-222222222222",
    };
    const service = new ConnectedAppService(
      store, catalog, "http://127.0.0.1:3001", driver, "oomol_hosted", null, PROVIDERS["notion"]!,
    );

    expect(await service.isConnected(connectedScope)).toBe(false);
    const started = await service.startOauth(connectedScope);
    await service.inspectAttempt(connectedScope, started.attemptId);
    expect(await service.isConnected(connectedScope)).toBe(true);
    expect(await service.isConnected({ ...connectedScope, namespaceId: "33333333-3333-4333-8333-333333333333" })).toBe(false);
    expect(await service.isConnected({ ...connectedScope, userId: "99999999-9999-4999-8999-999999999999" })).toBe(false);

    await store.deleteProfile(connectedScope, "notion", "oomol_hosted");
    expect(await service.isConnected(connectedScope)).toBe(false);
  });

  test("turns a stale local OAuth setup into an administrator-visible repair state", async () => {
    const store = memoryStore();
    const scope = {
      userId: "11111111-1111-4111-8111-111111111111",
      namespaceId: "22222222-2222-4222-8222-222222222222",
    };
    await addConnectedLocalProfile(store, scope, "airtable");
    store.profiles[0]!.status = "reconnect_required";
    const now = new Date();
    const config: ConnectedAppProviderConfigRow = {
      id: "55555555-5555-4555-8555-555555555555",
      providerId: "airtable",
      driverKind: "openconnector_local",
      status: "ready",
      clientId: "airtable-client",
      adminCredentialRefId: null,
      adminCredentialNamespaceId: null,
      adminCredentialAgentId: null,
      lastErrorCode: null,
      revision: 0,
      lastVerifiedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    let savedConfig: Omit<ConnectedAppProviderConfigRow, "id" | "createdAt" | "updatedAt" | "revision"> | null = null;
    const localStore: ConnectedAppStore = {
      ...store,
      getProviderConfig: async () => savedConfig
        ? { ...config, ...savedConfig, revision: 1 }
        : config,
      upsertProviderConfig: async (input) => {
        savedConfig = input;
        return { ...config, ...input, revision: 1 };
      },
    };
    const localDriver = {
      startOauth: async () => {
        throw new LocalConnectedAppDriverError("oauth_client_not_configured", 400);
      },
    } as unknown as OpenConnectorLocalConnectedAppDriver;
    const service = new ConnectedAppService(
      localStore,
      { catalog: BUNDLED_CONNECTION_PROVIDER_CATALOG, source: "bundled", reason: null },
      "http://127.0.0.1:3001",
      null,
      "openconnector_local",
      localDriver,
      PROVIDERS["airtable"]!,
    );

    const error = await service.startOauth(scope).catch((reason: unknown) => reason);
    expect(error).toMatchObject({ code: "oauth_client_not_configured", status: 400 });
    expect(savedConfig).toMatchObject({
      providerId: "airtable",
      status: "error",
      clientId: "airtable-client",
      lastErrorCode: "oauth_client_not_configured",
      lastVerifiedAt: now,
    });
    expect((await service.list(scope, { canManageConnectionProviders: true }))[0]).toMatchObject({
      id: "airtable",
      providerReady: false,
      providerSetupStatus: "error",
      canManageProviderSetup: true,
    });
  });

  test("disconnect removes only its exact Human×Namespace profile", async () => {
    const store = memoryStore();
    const firstScope = {
      userId: "11111111-1111-4111-8111-111111111111",
      namespaceId: "22222222-2222-4222-8222-222222222222",
    };
    const otherNamespace = {
      ...firstScope,
      namespaceId: "33333333-3333-4333-8333-333333333333",
    };
    await addConnectedLocalProfile(store, firstScope);
    await addConnectedLocalProfile(store, otherNamespace);
    const localStore: ConnectedAppStore = {
      ...store,
      getProviderConfig: async () => ({ status: "ready" } as ConnectedAppProviderConfigRow),
    };
    const localDriver = {
      disconnect: async () => undefined,
    } as unknown as OpenConnectorLocalConnectedAppDriver;
    const catalog = { catalog: BUNDLED_CONNECTION_PROVIDER_CATALOG, source: "bundled" as const, reason: null };
    const service = new ConnectedAppService(
      localStore, catalog, "http://127.0.0.1:3001", null, "openconnector_local", localDriver, PROVIDERS["notion"]!,
    );

    expect(await service.disconnect(firstScope)).toMatchObject({ status: "disconnected", providerId: "notion" });
    expect(await store.getProfile(firstScope, "notion", "openconnector_local")).toBeNull();
    expect(await store.getProfile(otherNamespace, "notion", "openconnector_local")).toMatchObject({ status: "connected" });
  });

  test("reuses the same hosted service and dispatcher for every signed Slack action", async () => {
    const store = memoryStore();
    const gateway = hostedGateway("slack");
    const driver = new OomolHostedConnectedAppDriver(
      "oo_proj_abcdefghijklmnopqrstuvwxyz123456",
      { fetch: gateway.fetch },
    );
    const catalog = { catalog: BUNDLED_CONNECTION_PROVIDER_CATALOG, source: "bundled" as const, reason: null };
    const scope = {
      userId: "11111111-1111-4111-8111-111111111111",
      namespaceId: "22222222-2222-4222-8222-222222222222",
    };
    const service = new ConnectedAppService(
      store,
      catalog,
      "http://127.0.0.1:3001",
      driver,
      "oomol_hosted",
      null,
      PROVIDERS["slack"]!,
    );

    const started = await service.startOauth(scope);
    expect(started).toMatchObject({ providerId: "slack" });
    expect(await service.inspectAttempt(scope, started.attemptId)).toMatchObject({
      status: "connected",
      providerId: "slack",
    });
    expect((await service.list(scope))[0]).toMatchObject({
      id: "slack",
      displayName: "Slack",
      status: "connected",
    });

    const listed = await service.execute({
      scope,
      operationId: "slack.list_conversations",
      effect: "read",
      args: {},
    });
    expect(listed.result).toMatchObject({ conversations: [{ channelId: "C123" }] });

    const posted = await service.execute({
      scope,
      operationId: "slack.post_message",
      effect: "write",
      args: { channelId: "C123", text: "Nautilo connection test" },
    });
    expect(posted).toMatchObject({
      providerId: "slack",
      operationId: "slack.post_message",
      reconciliation: {
        status: "confirmed",
        operationId: "slack.get_channel_messages",
      },
    });
  });

  test("applies the signed Canva result mapping after schema validation without exposing preview coordinates", async () => {
    const store = memoryStore();
    const scope = {
      userId: "11111111-1111-4111-8111-111111111111",
      namespaceId: "22222222-2222-4222-8222-222222222222",
    };
    await addConnectedLocalProfile(store, scope, "canva");
    const localStore: ConnectedAppStore = {
      ...store,
      getProviderConfig: async () => ({ status: "ready" } as ConnectedAppProviderConfigRow),
    };
    const execute = mock(async () => ({
      data: {
        design: {
          id: "DAH-test",
          title: "Launch graphic",
          editUrl: "https://www.canva.com/design/DAH-test/edit",
          viewUrl: "https://www.canva.com/design/DAH-test/view",
          thumbnailUrl: "https://media.canva.com/preview.png",
          thumbnailWidth: 640,
          thumbnailHeight: 480,
          ownerUserId: null,
          ownerTeamId: null,
          createdAt: null,
          updatedAt: null,
        },
      },
      executionId: "execution-canva-A",
    }));
    const localDriver = { execute } as unknown as OpenConnectorLocalConnectedAppDriver;
    const presenter = new ConnectedAppResultPresenter((async () => {
      throw new Error("previews are fetched only through the authenticated media route");
    }) as unknown as typeof fetch);
    const service = new ConnectedAppService(
      localStore,
      { catalog: BUNDLED_CONNECTION_PROVIDER_CATALOG, source: "bundled", reason: null },
      "http://127.0.0.1:3001",
      null,
      "openconnector_local",
      localDriver,
      PROVIDERS["canva"]!,
      presenter,
    );

    const receipt = await service.execute({
      scope,
      operationId: "canva.get_design",
      effect: "read",
      args: { designId: "DAH-test" },
    });

    expect(receipt.presentation).toMatchObject({
      kind: "entity",
      title: "Launch graphic",
      preview: { alt: "Canva design thumbnail" },
      links: [
        { label: "Open in Canva", url: "https://www.canva.com/design/DAH-test/view" },
        { label: "Edit in Canva", url: "https://www.canva.com/design/DAH-test/edit" },
      ],
    });
    expect(receipt.presentation?.kind === "entity"
      && typeof receipt.presentation.preview?.ref === "string").toBe(true);
    expect(JSON.stringify(receipt.result)).not.toContain("media.canva.com");
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      providerId: "canva",
      operationId: "canva.get_design",
    }));
  });

  test("routes a signed Dropbox transit result through the local driver into the Room artifact lane", async () => {
    const store = memoryStore();
    const scope = {
      userId: "11111111-1111-4111-8111-111111111111",
      namespaceId: "22222222-2222-4222-8222-222222222222",
    };
    await addConnectedLocalProfile(store, scope, "dropbox");
    const localStore: ConnectedAppStore = {
      ...store,
      getProviderConfig: async () => ({ status: "ready" } as ConnectedAppProviderConfigRow),
    };
    const transitFileId = `${"d".repeat(32)}.pdf`;
    const execute = mock(async () => ({
      data: {
        fileId: "id:dropbox-file",
        name: "brief.pdf",
        mimeType: "application/pdf",
        sizeBytes: 4,
        file: {
          fileId: transitFileId,
          downloadUrl: `http://127.0.0.1:3001/api/files/${transitFileId}`,
          name: "brief.pdf",
          mimeType: "application/pdf",
          sizeBytes: 4,
        },
      },
      executionId: "execution-dropbox-A",
    }));
    const readTransitFile = mock(async () => ({
      chunks: (async function* () { yield Uint8Array.from([37, 80, 68, 70]); })(),
    }));
    const deleteTransitFile = mock(async () => true);
    const localDriver = { execute, readTransitFile, deleteTransitFile } as unknown as OpenConnectorLocalConnectedAppDriver;
    const service = new ConnectedAppService(
      localStore,
      { catalog: BUNDLED_CONNECTION_PROVIDER_CATALOG, source: "bundled", reason: null },
      "http://127.0.0.1:3001",
      null,
      "openconnector_local",
      localDriver,
      PROVIDERS["dropbox"]!,
      new ConnectedAppResultPresenter(),
    );
    const imported: number[] = [];

    const receipt = await service.execute({
      scope,
      operationId: "dropbox.download_file",
      effect: "read",
      args: { path: "/brief.pdf" },
      artifactImporter: async ({ logicalPath, mimeType, chunks }) => {
        for await (const chunk of chunks) imported.push(...chunk);
        return {
          artifactId: "artifact-dropbox-A",
          path: logicalPath,
          mime: mimeType,
          bytes: imported.length,
        };
      },
    });

    expect(readTransitFile).toHaveBeenCalledWith({ fileId: transitFileId });
    expect(deleteTransitFile).toHaveBeenCalledWith({
      config: { status: "ready" },
      fileId: transitFileId,
    });
    expect(imported).toEqual([37, 80, 68, 70]);
    expect(receipt.presentation).toMatchObject({
      kind: "artifact_import",
      status: "ready",
      artifacts: [{
        artifactId: "artifact-dropbox-A",
        path: "connected-apps/dropbox/brief.pdf",
      }],
    });
    expect(JSON.stringify(receipt.result)).not.toContain("downloadUrl");
  });

  test("stages an authorized Room artifact, dispatches only its transit reference, and cleans it up", async () => {
    const store = memoryStore();
    const scope = {
      userId: "11111111-1111-4111-8111-111111111111",
      namespaceId: "22222222-2222-4222-8222-222222222222",
    };
    await addConnectedLocalProfile(store, scope, "dropbox");
    const config = { status: "ready" } as ConnectedAppProviderConfigRow;
    const localStore: ConnectedAppStore = {
      ...store,
      getProviderConfig: async () => config,
    };
    const events: string[] = [];
    const stageTransitFile = mock(async (input: { chunks: AsyncIterable<Uint8Array> }) => {
      const bytes: number[] = [];
      for await (const chunk of input.chunks) bytes.push(...chunk);
      events.push(`staged:${bytes.join(",")}`);
      return {
        fileId: `${"a".repeat(32)}.pdf`,
        name: "brief.pdf",
        mimeType: "application/pdf",
        sizeBytes: bytes.length,
      };
    });
    const execute = mock(async (input: { args: Record<string, unknown> }) => {
      events.push("dispatched");
      expect(input.args).toEqual({
        path: "/Nautilo/brief.pdf",
        mode: "overwrite",
        file: {
          fileId: `${"a".repeat(32)}.pdf`,
          name: "brief.pdf",
          mimeType: "application/pdf",
        },
      });
      expect(JSON.stringify(input.args)).not.toContain("artifactPath");
      expect(JSON.stringify(input.args)).not.toContain("%PDF");
      return {
        data: {
          metadata: {
            tag: "file",
            name: "brief.pdf",
            id: "id:uploaded-brief",
            pathDisplay: "/Nautilo/brief.pdf",
            pathLower: "/nautilo/brief.pdf",
            clientModified: null,
            serverModified: "2026-09-03T12:00:00Z",
            rev: "rev-A",
            sizeBytes: 4,
            isDownloadable: true,
            contentHash: null,
            url: null,
            expiresAt: null,
            sharingInfo: null,
            linkPermissions: null,
          },
        },
        executionId: "execution-dropbox-upload-A",
      };
    });
    const deleteTransitFile = mock(async () => {
      events.push("cleaned");
      return true;
    });
    const localDriver = {
      stageTransitFile,
      execute,
      deleteTransitFile,
    } as unknown as OpenConnectorLocalConnectedAppDriver;
    const service = new ConnectedAppService(
      localStore,
      { catalog: BUNDLED_CONNECTION_PROVIDER_CATALOG, source: "bundled", reason: null },
      "http://127.0.0.1:3001",
      null,
      "openconnector_local",
      localDriver,
      PROVIDERS["dropbox"]!,
    );
    const close = mock(async () => { events.push("closed"); });
    const verify = mock(async () => { events.push("verified"); });
    const receipt = await service.execute({
      scope,
      operationId: "dropbox.upload_file",
      effect: "write",
      args: {
        path: "/Nautilo/brief.pdf",
        artifactPath: "/brief.pdf",
        mode: "overwrite",
      },
      artifactInputResolver: async ({ artifactPath }) => {
        expect(artifactPath).toBe("/brief.pdf");
        return {
          name: "brief.pdf",
          mimeType: "application/pdf",
          sizeBytes: 4,
          chunks: (async function* () { yield Uint8Array.from([37, 80, 68, 70]); })(),
          verify,
          close,
        };
      },
    });

    expect(receipt).toMatchObject({
      operationId: "dropbox.upload_file",
      executionId: "execution-dropbox-upload-A",
      result: { metadata: { id: "id:uploaded-brief", sizeBytes: 4 } },
    });
    expect(events).toEqual(["staged:37,80,68,70", "verified", "dispatched", "cleaned", "closed"]);
    expect(stageTransitFile).toHaveBeenCalledWith(expect.objectContaining({
      config,
      name: "brief.pdf",
      mimeType: "application/pdf",
      sizeBytes: 4,
    }));
    expect(deleteTransitFile).toHaveBeenCalledWith({
      config,
      fileId: `${"a".repeat(32)}.pdf`,
    });
  });

  test("deletes staged bytes and refuses provider dispatch when the artifact changes", async () => {
    const store = memoryStore();
    const scope = {
      userId: "11111111-1111-4111-8111-111111111111",
      namespaceId: "22222222-2222-4222-8222-222222222222",
    };
    await addConnectedLocalProfile(store, scope, "dropbox");
    const config = { status: "ready" } as ConnectedAppProviderConfigRow;
    const localStore: ConnectedAppStore = { ...store, getProviderConfig: async () => config };
    const execute = mock(async () => { throw new Error("provider dispatch must not run"); });
    const deleteTransitFile = mock(async () => true);
    const localDriver = {
      stageTransitFile: async () => ({
        fileId: `${"b".repeat(32)}.bin`,
        name: "moving.bin",
        mimeType: "application/octet-stream",
        sizeBytes: 1,
      }),
      execute,
      deleteTransitFile,
    } as unknown as OpenConnectorLocalConnectedAppDriver;
    const service = new ConnectedAppService(
      localStore,
      { catalog: BUNDLED_CONNECTION_PROVIDER_CATALOG, source: "bundled", reason: null },
      "http://127.0.0.1:3001",
      null,
      "openconnector_local",
      localDriver,
      PROVIDERS["dropbox"]!,
    );
    const close = mock(async () => undefined);
    const error = await service.execute({
      scope,
      operationId: "dropbox.upload_file",
      effect: "write",
      args: { path: "/moving.bin", artifactPath: "/moving.bin" },
      artifactInputResolver: async () => ({
        name: "moving.bin",
        mimeType: "application/octet-stream",
        sizeBytes: 1,
        chunks: (async function* () { yield Uint8Array.from([1]); })(),
        verify: async () => { throw new ConnectedAppArtifactInputError("connected_app_artifact_changed", 409); },
        close,
      }),
    }).catch((cause: unknown) => cause);

    expect(error).toMatchObject({ code: "connected_app_artifact_changed", status: 409 });
    expect(execute).not.toHaveBeenCalled();
    expect(deleteTransitFile).toHaveBeenCalledWith({
      config,
      fileId: `${"b".repeat(32)}.bin`,
    });
    expect(close).toHaveBeenCalledTimes(1);
  });

  test("terminates an active attempt immediately so the Human can start over", async () => {
    const store = memoryStore();
    const gateway = hostedGateway();
    const driver = new OomolHostedConnectedAppDriver(
      "oo_proj_abcdefghijklmnopqrstuvwxyz123456",
      { fetch: gateway.fetch },
    );
    const catalog = {
      catalog: BUNDLED_CONNECTION_PROVIDER_CATALOG,
      source: "bundled" as const,
      reason: null,
    };
    const scope = {
      userId: "11111111-1111-4111-8111-111111111111",
      namespaceId: "22222222-2222-4222-8222-222222222222",
    };
    const service = new ConnectedAppService(
      store,
      catalog,
      "http://127.0.0.1:3001",
      driver,
      "oomol_hosted",
      null,
      PROVIDERS["notion"]!,
    );

    const started = await service.startOauth(scope);
    const otherUser = await service.cancelAttempt(
      { ...scope, userId: "99999999-9999-4999-8999-999999999999" },
      started.attemptId,
    ).catch((cause: unknown) => cause);
    expect(otherUser).toMatchObject({
      code: "connected_app_attempt_not_found",
      status: 404,
    });
    expect(await service.cancelAttempt(scope, started.attemptId)).toEqual({
      status: "failed",
      providerId: "notion",
      account: null,
      errorCode: "authorization_restarted",
    });
    expect((await service.list(scope))[0]).toMatchObject({
      status: "not_connected",
      attemptId: null,
    });
  });

  test("persists only durable handles, resumes after reconstruction, and admits exact actions", async () => {
    const store = memoryStore();
    const gateway = hostedGateway();
    const driver = new OomolHostedConnectedAppDriver(
      "oo_proj_abcdefghijklmnopqrstuvwxyz123456",
      { fetch: gateway.fetch },
    );
    const catalog = { catalog: BUNDLED_CONNECTION_PROVIDER_CATALOG, source: "bundled" as const, reason: null };
    const scope = { userId: "11111111-1111-4111-8111-111111111111", namespaceId: "22222222-2222-4222-8222-222222222222" };
    const first = new ConnectedAppService(
      store, catalog, "http://127.0.0.1:3001", driver, "oomol_hosted", null, PROVIDERS["notion"]!,
    );

    const started = await first.startOauth(scope);
    expect(started.attemptId).toBe(ATTEMPT_ID);
    expect(JSON.stringify(store.attempts)).not.toContain(started.authorizationUrl);
    expect((await first.list(scope))[0]).toMatchObject({ status: "connecting", attemptId: ATTEMPT_ID });

    const afterRestart = new ConnectedAppService(
      store, catalog, "http://127.0.0.1:3001", driver, "oomol_hosted", null, PROVIDERS["notion"]!,
    );
    const [firstInspection, overlappingInspection] = await Promise.all([
      afterRestart.inspectAttempt(scope, ATTEMPT_ID),
      afterRestart.inspectAttempt(scope, ATTEMPT_ID),
    ]);
    expect(firstInspection).toMatchObject({
      status: "connected",
      account: { displayName: "Alex" },
    });
    expect(overlappingInspection).toEqual(firstInspection);
    expect(gateway.connectionRequestPolls()).toBe(1);
    expect((await afterRestart.list(scope))[0]).toMatchObject({ status: "connected", attemptId: null });

    const invalidInput = await afterRestart.execute({
      scope, operationId: "notion.search", effect: "read", args: { query: "pilot", unexpected: true },
    }).catch((cause: unknown) => cause);
    expect(invalidInput).toMatchObject({ code: "connected_app_input_invalid", status: 400 });
    const effectMismatch = await afterRestart.execute({
      scope, operationId: "notion.create_page", effect: "read", args: {},
    }).catch((cause: unknown) => cause);
    expect(effectMismatch).toMatchObject({ code: "connected_app_operation_not_admitted", status: 403 });
    const unsupported = await afterRestart.execute({
      scope, operationId: "notion.unreviewed_future_action", effect: "read", args: {},
    }).catch((cause: unknown) => cause);
    expect(unsupported).toMatchObject({ code: "connected_app_operation_not_admitted", status: 403 });
    const receipt = await afterRestart.execute({
      scope, operationId: "notion.search", effect: "read", args: { query: "pilot" },
    });
    expect(receipt).toMatchObject({
      providerId: "notion", operationId: "notion.search", executionId: "execution-A",
      profileId: PROFILE_ID, effect: "read", reconciliation: null,
      result: { object: "list", results: [], next_cursor: null, has_more: false },
    });
    expect(gateway.actionPaths).toHaveLength(1);

    gateway.setSearchDrift(true);
    const drift = await afterRestart.execute({
      scope, operationId: "notion.search", effect: "read", args: { query: "pilot" },
    }).catch((cause: unknown) => cause);
    expect(drift).toMatchObject({ code: "connected_app_output_schema_drift", status: 502 });
    gateway.setSearchDrift(false);

    const writeReceipt = await afterRestart.execute({
      scope,
      operationId: "notion.create_page",
      effect: "write",
      args: {
        parent: { workspace: true },
        properties: {
          title: { title: [{ type: "text", text: { content: "Nautilo connection test" } }] },
        },
      },
    });
    expect(writeReceipt).toMatchObject({
      operationId: "notion.create_page",
      executionId: "execution-A",
      effect: "write",
      reconciliation: {
        status: "confirmed",
        operationId: "notion.retrieve_page",
        executionId: "execution-A",
        errorCode: null,
      },
      result: { object: "page", id: "page-A" },
    });
    expect(gateway.actionPaths).toHaveLength(4);

    gateway.setCreateDrift(true);
    const driftedWrite = await afterRestart.execute({
      scope,
      operationId: "notion.create_page",
      effect: "write",
      args: {
        parent: { workspace: true },
        properties: { title: { title: [{ type: "text", text: { content: "Schema drift test" } }] } },
      },
    });
    // The exact upstream contract permits this sparse response, but the signed
    // receipt mapping cannot identify it. Preserve an unconfirmed outcome and
    // do not disguise it as success that is safe to retry.
    expect(driftedWrite).toMatchObject({
      operationId: "notion.create_page",
      reconciliation: {
        status: "unconfirmed",
        operationId: "notion.retrieve_page",
        executionId: null,
        errorCode: "connected_app_receipt_invalid",
      },
      result: { created: true },
    });
    gateway.setCreateDrift(false);

    gateway.setWriteDispatchFailure(true);
    const unknownWrite = await afterRestart.execute({
      scope,
      operationId: "notion.create_page",
      effect: "write",
      args: {
        parent: { workspace: true },
        properties: { title: { title: [{ type: "text", text: { content: "Do not retry test" } }] } },
      },
    }).catch((cause: unknown) => cause);
    expect(unknownWrite).toMatchObject({
      code: "connected_app_write_outcome_unknown_do_not_retry",
      status: 502,
    });
    gateway.setWriteDispatchFailure(false);

    const otherRoomScope = {
      userId: scope.userId,
      namespaceId: "55555555-5555-4555-8555-555555555555",
    };
    const otherNamespace = await afterRestart.execute({
      scope: otherRoomScope,
      operationId: "notion.search",
      effect: "read",
      args: { query: "same human, another room" },
    }).catch((cause: unknown) => cause);
    expect(otherNamespace).toMatchObject({ code: "connected_app_not_connected", status: 409 });
    expect(store.profiles.some((row) => row.userId === scope.userId
      && row.namespaceId === otherRoomScope.namespaceId)).toBe(false);

    const otherHuman = await afterRestart.execute({
      scope: {
        userId: "66666666-6666-4666-8666-666666666666",
        namespaceId: "77777777-7777-4777-8777-777777777777",
      },
      operationId: "notion.search",
      effect: "read",
      args: { query: "must fail" },
    }).catch((cause: unknown) => cause);
    expect(otherHuman).toMatchObject({ code: "connected_app_not_connected", status: 409 });
  });
});
