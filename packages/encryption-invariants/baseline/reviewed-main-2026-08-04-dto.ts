import type { DtoDeclaration } from "../src/node/dto-inventory";

export const REVIEWED_MAIN_2026_08_04_DTO_DECLARATIONS:
  readonly DtoDeclaration[] = [
    {
      observationId: "wire.http.request.response.delete.api.remote.controllers.bindingid.15697c0",
      locator: "http:request_response:DELETE /api/remote/controllers/:bindingId",
      structuralSignatures: [
        "request.params:{bindingId:string}",
        "response.body:{ok:boolean}",
      ],
      arbitraryPayloads: [],
    },
    {
      observationId: "wire.http.request.response.get.api.remote.controllers.cgf02i",
      locator: "http:request_response:GET /api/remote/controllers",
      structuralSignatures: [
        "response.body:{controllers:{bindingId:string;createdAt:string;installationId:string;label:string;lastSeenAt:string;remoteHostId:string}[]}",
      ],
      arbitraryPayloads: [],
    },
    {
      observationId: "wire.http.request.response.get.api.remote.hosts.e0c5j4",
      locator: "http:request_response:GET /api/remote/hosts",
      structuralSignatures: [
        "response.body:{controllerLabel:string;cursor:{sequence:number;snapshotRevision:number;streamId:string};hosts:{connected:boolean;label:string;lastSeenAt:string;readiness:\"compatible_online\"|\"identity_conflict\"|\"incompatible_online\"|\"offline\"|\"stale\"|\"unknown\";remoteHostId:string}[]}",
      ],
      arbitraryPayloads: [],
    },
    {
      observationId: "wire.http.request.response.patch.api.remote.controllers.bindingid.9dgq5n",
      locator: "http:request_response:PATCH /api/remote/controllers/:bindingId",
      structuralSignatures: [
        "request.params:{bindingId:string}",
        "response.body:{ok:boolean}",
      ],
      arbitraryPayloads: [],
    },
    {
      observationId: "wire.http.request.response.post.api.auth.host.choice.reply.f9s24a",
      locator: "http:request_response:POST /api/auth/host-choice-reply",
      structuralSignatures: [
        "request.body:{choiceId?:string;laneKey?:string;selector?:string;threadId?:string}",
        "response.body:{code:string;error:string}",
        "response.body:{error:string}",
        "response.body:{ok:boolean}",
      ],
      arbitraryPayloads: [],
    },
    {
      observationId: "wire.http.request.response.post.api.relay.electron.origin.credential.16256qh",
      locator: "http:request_response:POST /api/relay/electron-origin-credential",
      structuralSignatures: [
        "request.body:{bodySha256?:unknown;desktopSessionId?:unknown;method?:unknown;path?:unknown;relayId?:unknown;requestId?:unknown}",
        "response.body:{credential:string;expiresAt:string}",
        "response.body:{error:string}",
      ],
      arbitraryPayloads: [
        { path: "request.body.bodySha256", schema: "sha256hex" },
        { path: "request.body.desktopSessionId", schema: "opaque-session-id" },
        { path: "request.body.method", schema: "canonical-http-method" },
        { path: "request.body.path", schema: "canonical-route-path" },
        { path: "request.body.relayId", schema: "uuid" },
        { path: "request.body.requestId", schema: "uuid" },
      ],
    },
    {
      observationId: "wire.http.request.response.post.api.remote.challenges.1bp3j75",
      locator: "http:request_response:POST /api/remote/challenges",
      structuralSignatures: [
        "response.body:{ceremonyContext:string;challengeId:string;deepLink:string;expiresAt:string;manualCode:string;qrSecret:string}",
      ],
      arbitraryPayloads: [],
    },
    {
      observationId: "wire.http.request.response.post.api.remote.challenges.consume.6vo5s4",
      locator: "http:request_response:POST /api/remote/challenges/consume",
      structuralSignatures: [
        "response.body:{bindingId:string;controllerInstallationId:string;installationGeneration:number;installationId:string;ok:boolean;serverBindingGeneration:number;serverInstanceId:string}",
      ],
      arbitraryPayloads: [],
    },
    {
      observationId: "wire.http.request.response.post.api.remote.challenges.manual.prepare.1yj626w",
      locator: "http:request_response:POST /api/remote/challenges/manual/prepare",
      structuralSignatures: [
        "response.body:{ceremonyContext:string;challengeId:string;expiresAt:string}",
      ],
      arbitraryPayloads: [],
    },
    {
      observationId: "wire.http.request.response.post.api.remote.current.folder.select.sme8z8",
      locator: "http:request_response:POST /api/remote/current-folder/select",
      structuralSignatures: [
        "response.body:{error:string}",
        "response.body:{label:string;ok:boolean}",
      ],
      arbitraryPayloads: [],
    },
    {
      observationId: "wire.http.request.response.post.api.remote.host.files.list.iy1sd8",
      locator: "http:request_response:POST /api/remote/host-files/list",
      structuralSignatures: [
        "response.body:{entries:{isDirectory:boolean;isFile:boolean;isSymbolicLink:boolean;name:string;path:string}[];nextCursor:string}",
        "response.body:{error:string}",
      ],
      arbitraryPayloads: [],
    },
    {
      observationId: "wire.http.request.response.post.api.remote.host.files.read.cjx39k",
      locator: "http:request_response:POST /api/remote/host-files/read",
      structuralSignatures: [
        "response.body:{dataBase64:string;entry:{isDirectory:boolean;isFile:boolean;isSymbolicLink:boolean;mtimeMs:number;path:string;size:number}}",
        "response.body:{error:string}",
      ],
      arbitraryPayloads: [],
    },
    {
      observationId: "wire.http.request.response.post.api.remote.host.files.stat.137ag2e",
      locator: "http:request_response:POST /api/remote/host-files/stat",
      structuralSignatures: [
        "response.body:{entry:{isDirectory:boolean;isFile:boolean;isSymbolicLink:boolean;mtimeMs:number;path:string;size:number}}",
        "response.body:{error:string}",
      ],
      arbitraryPayloads: [],
    },
    ...([
      ["wire.ws.client.to.server.remote.host.resume.1fnyo1f", "ws:client_to_server:remote.host.resume"],
      ["wire.ws.server.to.client.host.choice.1tf237n", "ws:server_to_client:host.choice"],
      ["wire.ws.server.to.client.remote.host.connected.y4rlqn", "ws:server_to_client:remote.host.connected"],
      ["wire.ws.server.to.client.remote.host.disconnected.1hclu83", "ws:server_to_client:remote.host.disconnected"],
      ["wire.ws.server.to.client.remote.host.revoked.qhxsla", "ws:server_to_client:remote.host.revoked"],
      ["wire.ws.server.to.client.remote.host.snapshot.1qucj8c", "ws:server_to_client:remote.host.snapshot"],
      ["wire.ws.server.to.client.remote.host.updated.1kcvp1j", "ws:server_to_client:remote.host.updated"],
    ] as const).map(([observationId, locator]) => ({
      observationId,
      locator,
      structuralSignatures: [],
      arbitraryPayloads: [],
    })),
  ];
