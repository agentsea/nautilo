import type { DtoDeclaration } from "../src/node/dto-inventory";

export const REVIEWED_D487_DTO_DECLARATIONS:
  readonly DtoDeclaration[] = [
    {
      observationId: "wire.http.request.response.get.api.profile.agent.photo.library.1pfwh5a",
      locator: "http:request_response:GET /api/profile/agent-photo-library",
      structuralSignatures: [
        "request.query:{cursor?:string;limit?:string;projection?:string}",
        "response.body:{entries:{createdAt:string;deletedAt:string;id:string;isCurrent:boolean;media:{fullUrl?:string;thumbnailUrl:string};origin:string;purgeAfter:string;source:string}[];nextCursor:string;scope:{agentId:string;libraryRevision:string;selectionRevision:string;serverInstanceId:string;viewerUserId:string}}",
        "response.body:{error:{code:string;message:string;retryable:boolean}}",
      ],
      arbitraryPayloads: [],
    },
    {
      observationId: "wire.http.request.response.get.api.profile.agent.photo.library.current.1c7sdwc",
      locator: "http:request_response:GET /api/profile/agent-photo-library/current",
      structuralSignatures: [
        "response.body:{current:{avatarRef:{blobId:string;kind:\"generated\"}|{blobId:string;kind:\"uploaded\"}|{id:string;kind:\"preset\"};entryId:string;lastUndoableRevisionId:string;scope:{agentId:string;libraryRevision:string;selectionRevision:string;serverInstanceId:string;viewerUserId:string}};scope:{agentId:string;libraryRevision:string;selectionRevision:string;serverInstanceId:string;viewerUserId:string}}",
        "response.body:{error:{code:string;message:string;retryable:boolean}}",
      ],
      arbitraryPayloads: [],
    },
    {
      observationId: "wire.http.request.response.get.api.profile.agent.photo.library.entries.entryid.media.nfhaoi",
      locator: "http:request_response:GET /api/profile/agent-photo-library/entries/:entryId/media",
      structuralSignatures: [
        "request.params:{entryId:string}",
        "request.query:{size?:string}",
        "response.body:Buffer",
        "response.body:null",
        "response.body:{bytes:Buffer;contentType:\"image/png\"|\"image/webp\";etag:string;ok:true}",
        "response.body:{error:{code:string;message:string;retryable:boolean}}",
      ],
      arbitraryPayloads: [],
    },
    {
      observationId: "wire.http.request.response.get.api.profile.agent.photo.library.entries.entryid.ty05rd",
      locator: "http:request_response:GET /api/profile/agent-photo-library/entries/:entryId",
      structuralSignatures: [
        "request.params:{entryId:string}",
        "response.body:{entry:{createdAt:string;deletedAt:string;id:string;isCurrent:boolean;media:{fullUrl?:string;thumbnailUrl:string};origin:string;purgeAfter:string;source:string};scope:{agentId:string;libraryRevision:string;selectionRevision:string;serverInstanceId:string;viewerUserId:string}}",
        "response.body:{error:{code:string;message:string;retryable:boolean}}",
      ],
      arbitraryPayloads: [],
    },
    {
      observationId: "wire.http.request.response.get.api.profile.agent.photo.library.presets.a3clmt",
      locator: "http:request_response:GET /api/profile/agent-photo-library/presets",
      structuralSignatures: [
        "response.body:{error:{code:string;message:string;retryable:boolean}}",
        "response.body:{presets:{id:string;thumbnailUrl:string}[];scope:{agentId:string;libraryRevision:string;selectionRevision:string;serverInstanceId:string;viewerUserId:string}}",
      ],
      arbitraryPayloads: [],
    },
    ...([
      ["wire.http.request.response.post.api.profile.agent.photo.library.entries.entryid.delete.1mzjzq7", "http:request_response:POST /api/profile/agent-photo-library/entries/:entryId/delete"],
      ["wire.http.request.response.post.api.profile.agent.photo.library.entries.entryid.restore.spawn2", "http:request_response:POST /api/profile/agent-photo-library/entries/:entryId/restore"],
    ] as const).map(([observationId, locator]) => ({
      observationId,
      locator,
      structuralSignatures: [
        "request.params:{entryId:string}",
        "response.body:{changed:true;entryId:string;operation:\"delete\"|\"restore\";scope:{agentId:string;libraryRevision:string;selectionRevision:string;serverInstanceId:string;viewerUserId:string}}",
        "response.body:{error:{code:string;message:string;retryable:boolean}}",
      ],
      arbitraryPayloads: [],
    })),
    {
      observationId: "wire.http.request.response.post.api.profile.agent.photo.library.generate.nittvy",
      locator: "http:request_response:POST /api/profile/agent-photo-library/generate",
      structuralSignatures: [
        "request.body:unknown",
        "response.body:{entries:{createdAt:string;id:string;media:{fullUrl:string;thumbnailUrl:string};origin:string;source:string}[];entryIds:string[];operation:\"create\";scope:{agentId:string;libraryRevision:string;selectionRevision:string;serverInstanceId:string;viewerUserId:string}}",
        "response.body:{error:{code:string;message:string;retryable:boolean}}",
      ],
      arbitraryPayloads: [
        { path: "request.body", schema: "agent-photo-library-generate-request-v1" },
      ],
    },
    ...([
      ["wire.http.request.response.post.api.profile.agent.photo.library.select.y8fsax", "http:request_response:POST /api/profile/agent-photo-library/select", "agent-photo-library-select-request-v1"],
      ["wire.http.request.response.post.api.profile.agent.photo.library.undo.3o37uz", "http:request_response:POST /api/profile/agent-photo-library/undo", "agent-photo-library-undo-request-v1"],
    ] as const).map(([observationId, locator, schema]) => ({
      observationId,
      locator,
      structuralSignatures: [
        "request.body:unknown",
        "response.body:{changed:boolean;currentAvatarRef:{blobId:string;kind:\"generated\"}|{blobId:string;kind:\"uploaded\"}|{id:string;kind:\"preset\"};currentEntryId:string;operation:\"select\"|\"undo\";revisionId:string;scope:{agentId:string;libraryRevision:string;selectionRevision:string;serverInstanceId:string;viewerUserId:string}}",
        "response.body:{error:{code:string;message:string;retryable:boolean}}",
      ],
      arbitraryPayloads: [{ path: "request.body", schema }],
    })),
    {
      observationId: "wire.http.request.response.post.api.profile.agent.photo.library.upload.gmeig",
      locator: "http:request_response:POST /api/profile/agent-photo-library/upload",
      structuralSignatures: [
        "response.body:{entries:{createdAt:string;id:string;media:{fullUrl:string;thumbnailUrl:string};origin:string;source:string}[];entryIds:string[];operation:\"create\";scope:{agentId:string;libraryRevision:string;selectionRevision:string;serverInstanceId:string;viewerUserId:string}}",
        "response.body:{error:{code:string;message:string;retryable:boolean}}",
      ],
      arbitraryPayloads: [],
    },
  ];
