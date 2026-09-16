import type { DtoDeclaration } from "../src/node/dto-inventory";

/** Static wire shapes reviewed from the current main documentMedia provenance. */
export const REVIEWED_MAIN_2026_09_09_DOCUMENTMEDIA_DTO_DECLARATIONS: readonly DtoDeclaration[] = [
  {
    "observationId": "wire.app.bridge.app.to.host.arbitrary.apps.workbench.src.apps.app.bridge.ts.appdocumentsavecopyrequest.icsavi",
    "locator": "app_bridge:app_to_host_arbitrary:apps/workbench/src/apps/app-bridge.ts#AppDocumentSaveCopyRequest",
    "structuralSignatures": [
      "declaration.payload:{op:\"saveCopy\";requestId:string;type:\"nautilo.app.document.req\";value:unknown}"
    ],
    "arbitraryPayloads": [
      {
        "path": "value",
        "schema": "DocumentMediaValueV1"
      }
    ]
  },
  {
    "observationId": "wire.app.bridge.app.to.host.arbitrary.apps.workbench.src.apps.app.bridge.ts.appdocumentwriterequest.8sghah",
    "locator": "app_bridge:app_to_host_arbitrary:apps/workbench/src/apps/app-bridge.ts#AppDocumentWriteRequest",
    "structuralSignatures": [
      "declaration.payload:{baseRevision?:null|number;baseSha256?:null|string;conflictPolicy?:\"strict\";op:\"downloadCopy\"|\"write\";requestId:string;type:\"nautilo.app.document.req\";value:unknown}"
    ],
    "arbitraryPayloads": [
      {
        "path": "value",
        "debtId": "debt.wire.arbitrary.ptg8v3"
      }
    ]
  },
  {
    "observationId": "wire.app.bridge.app.to.host.nautilo.app.asset.cancel.glxcmj",
    "locator": "app_bridge:app_to_host:nautilo.app.asset.cancel",
    "structuralSignatures": [
      "frame.payload:{requestId:string;type:\"nautilo.app.asset.cancel\"}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.app.bridge.app.to.host.nautilo.app.asset.req.read.63tud0",
    "locator": "app_bridge:app_to_host:nautilo.app.asset.req#read",
    "structuralSignatures": [
      "frame.payload:{op:\"read\";ref:string;requestId:string;type:\"nautilo.app.asset.req\"}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.app.bridge.app.to.host.nautilo.app.assets.req.pick.1u148v8",
    "locator": "app_bridge:app_to_host:nautilo.app.assets.req#pick",
    "structuralSignatures": [
      "frame.payload:{op:\"pick\";requestId:string;type:\"nautilo.app.assets.req\"}|{op:\"read\";ref:string;requestId:string;type:\"nautilo.app.assets.req\"}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.app.bridge.app.to.host.nautilo.app.document.req.authoredchange.1crk8bn",
    "locator": "app_bridge:app_to_host:nautilo.app.document.req#authoredChange",
    "structuralSignatures": [
      "frame.payload:{fresh?:boolean;op:\"authoredChange\"|\"read\"|\"stat\";requestId:string;type:\"nautilo.app.document.req\"}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.app.bridge.app.to.host.nautilo.app.document.req.downloadcopy.jid00g",
    "locator": "app_bridge:app_to_host:nautilo.app.document.req#downloadCopy",
    "structuralSignatures": [
      "frame.payload:{baseRevision?:null|number;baseSha256?:null|string;conflictPolicy?:\"strict\";op:\"downloadCopy\"|\"write\";requestId:string;type:\"nautilo.app.document.req\";value:unknown}"
    ],
    "arbitraryPayloads": [
      {
        "path": "value",
        "schema": "DocumentMediaValueV1"
      }
    ]
  },
  {
    "observationId": "wire.app.bridge.app.to.host.nautilo.app.document.req.read.1ujb5jp",
    "locator": "app_bridge:app_to_host:nautilo.app.document.req#read",
    "structuralSignatures": [
      "frame.payload:{fresh?:boolean;op:\"authoredChange\"|\"read\"|\"stat\";requestId:string;type:\"nautilo.app.document.req\"}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.app.bridge.app.to.host.nautilo.app.document.req.savecopy.tfya39",
    "locator": "app_bridge:app_to_host:nautilo.app.document.req#saveCopy",
    "structuralSignatures": [
      "frame.payload:{op:\"saveCopy\";requestId:string;type:\"nautilo.app.document.req\";value:unknown}"
    ],
    "arbitraryPayloads": [
      {
        "path": "value",
        "schema": "DocumentMediaValueV1"
      }
    ]
  },
  {
    "observationId": "wire.app.bridge.app.to.host.nautilo.app.document.req.stat.vp1nc7",
    "locator": "app_bridge:app_to_host:nautilo.app.document.req#stat",
    "structuralSignatures": [
      "frame.payload:{fresh?:boolean;op:\"authoredChange\"|\"read\"|\"stat\";requestId:string;type:\"nautilo.app.document.req\"}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.app.bridge.app.to.host.nautilo.app.document.req.write.fhgd58",
    "locator": "app_bridge:app_to_host:nautilo.app.document.req#write",
    "structuralSignatures": [
      "frame.payload:{baseRevision?:null|number;baseSha256?:null|string;conflictPolicy?:\"strict\";op:\"downloadCopy\"|\"write\";requestId:string;type:\"nautilo.app.document.req\";value:unknown}"
    ],
    "arbitraryPayloads": [
      {
        "path": "value",
        "debtId": "debt.wire.arbitrary.1d1pwg2"
      }
    ]
  },
  {
    "observationId": "wire.app.bridge.app.to.host.nautilo.app.lifecycle.register.1b65so8",
    "locator": "app_bridge:app_to_host:nautilo.app.lifecycle.register",
    "structuralSignatures": [
      "frame.payload:{type:\"nautilo.app.lifecycle.register\"}|{type:\"nautilo.app.lifecycle.unregister\"}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.app.bridge.app.to.host.nautilo.app.media.cancel.1ufcsnn",
    "locator": "app_bridge:app_to_host:nautilo.app.media.cancel",
    "structuralSignatures": [
      "frame.payload:{requestId:string;type:\"nautilo.app.media.cancel\"}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.app.bridge.app.to.host.nautilo.app.media.req.closepreview.1r0zsns",
    "locator": "app_bridge:app_to_host:nautilo.app.media.req#closePreview",
    "structuralSignatures": [
      "frame.payload:{op:\"closePreview\";requestId:string;revokeToken:string;type:\"nautilo.app.media.req\"}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.app.bridge.app.to.host.nautilo.app.media.req.exportcapabilities.1jz579c",
    "locator": "app_bridge:app_to_host:nautilo.app.media.req#exportCapabilities",
    "structuralSignatures": [
      "frame.payload:{op:\"exportCapabilities\";requestId:string;type:\"nautilo.app.media.req\"}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.app.bridge.app.to.host.nautilo.app.media.req.exportvideo.1pdpnbh",
    "locator": "app_bridge:app_to_host:nautilo.app.media.req#exportVideo",
    "structuralSignatures": [
      "frame.payload:{exportSettings?:import(\"@nautilo/types\").VideoExportSettings;op:\"exportVideo\";publishToWorkspace?:boolean;requestId:string;revision:null|number;sha256:string;type:\"nautilo.app.media.req\"}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.app.bridge.app.to.host.nautilo.app.media.req.importvideo.1nsrwos",
    "locator": "app_bridge:app_to_host:nautilo.app.media.req#importVideo",
    "structuralSignatures": [
      "frame.payload:{op:\"importVideo\";requestId:string;type:\"nautilo.app.media.req\"}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.app.bridge.app.to.host.nautilo.app.media.req.openpreview.kvzolw",
    "locator": "app_bridge:app_to_host:nautilo.app.media.req#openPreview",
    "structuralSignatures": [
      "frame.payload:{mediaId:string}|{ref:string}&{op:\"openPreview\";requestId:string;type:\"nautilo.app.media.req\"}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.app.bridge.app.to.host.nautilo.app.media.req.openworkspacecopy.1b8mxpo",
    "locator": "app_bridge:app_to_host:nautilo.app.media.req#openWorkspaceCopy",
    "structuralSignatures": [
      "frame.payload:{op:\"openWorkspaceCopy\";requestId:string;type:\"nautilo.app.media.req\"}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.app.bridge.app.to.host.nautilo.app.media.req.saveworkspacecopy.9qn6x7",
    "locator": "app_bridge:app_to_host:nautilo.app.media.req#saveWorkspaceCopy",
    "structuralSignatures": [
      "frame.payload:{op:\"saveWorkspaceCopy\";requestId:string;sha256:string;type:\"nautilo.app.media.req\"}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.app.bridge.app.to.host.nautilo.app.media.req.workspacecopycapabilities.11xstea",
    "locator": "app_bridge:app_to_host:nautilo.app.media.req#workspaceCopyCapabilities",
    "structuralSignatures": [
      "frame.payload:{op:\"workspaceCopyCapabilities\";requestId:string;type:\"nautilo.app.media.req\"}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.app.bridge.app.to.host.nautilo.app.video.generation.req.gettakestatus.vffm6b",
    "locator": "app_bridge:app_to_host:nautilo.app.video-generation.req#getTakeStatus",
    "structuralSignatures": [
      "frame.payload:{op:\"getTakeStatus\"|\"listTakes\"|\"previewTake\"|\"revalidateTake\";requestId:string;takeId?:string;type:\"nautilo.app.video-generation.req\"}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.app.bridge.app.to.host.nautilo.app.video.generation.req.importreference.1y0caag",
    "locator": "app_bridge:app_to_host:nautilo.app.video-generation.req#importReference",
    "structuralSignatures": [
      "frame.payload:{mediaKind:\"audio\"|\"image\"|\"video\";op:\"importReference\";requestId:string;type:\"nautilo.app.video-generation.req\"}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.app.bridge.app.to.host.nautilo.app.video.generation.req.listtakes.1p086ly",
    "locator": "app_bridge:app_to_host:nautilo.app.video-generation.req#listTakes",
    "structuralSignatures": [
      "frame.payload:{op:\"getTakeStatus\"|\"listTakes\"|\"previewTake\"|\"revalidateTake\";requestId:string;takeId?:string;type:\"nautilo.app.video-generation.req\"}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.app.bridge.app.to.host.nautilo.app.video.generation.req.previewtake.5sqneh",
    "locator": "app_bridge:app_to_host:nautilo.app.video-generation.req#previewTake",
    "structuralSignatures": [
      "frame.payload:{op:\"getTakeStatus\"|\"listTakes\"|\"previewTake\"|\"revalidateTake\";requestId:string;takeId?:string;type:\"nautilo.app.video-generation.req\"}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.app.bridge.app.to.host.nautilo.app.video.generation.req.revalidatetake.vuvnfy",
    "locator": "app_bridge:app_to_host:nautilo.app.video-generation.req#revalidateTake",
    "structuralSignatures": [
      "frame.payload:{op:\"getTakeStatus\"|\"listTakes\"|\"previewTake\"|\"revalidateTake\";requestId:string;takeId?:string;type:\"nautilo.app.video-generation.req\"}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.app.bridge.app.to.host.nautilo.app.video.generation.request.7ldizw",
    "locator": "app_bridge:app_to_host:nautilo.app.video-generation.request",
    "structuralSignatures": [
      "frame.payload:unresolved<Readonly>&{type:\"nautilo.app.video-generation.request\"}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.app.bridge.app.to.host.nautilo.app.video.host.layout.req.setfullwidth.1qirvsc",
    "locator": "app_bridge:app_to_host:nautilo.app.video-host-layout.req#setFullWidth",
    "structuralSignatures": [
      "frame.payload:{enabled:boolean;op:\"setFullWidth\";requestId:string;type:\"nautilo.app.video-host-layout.req\"}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.app.bridge.host.to.app.arbitrary.apps.workbench.src.apps.app.bridge.ts.appbridgeoptions.ojsugv",
    "locator": "app_bridge:host_to_app_arbitrary:apps/workbench/src/apps/app-bridge.ts#AppBridgeOptions",
    "structuralSignatures": [
      "declaration.payload:{appId:string;assetReadRaster?:true;assets?:{};documentSession?:{documentReadGeneration?:number;documentReadPromise?:unresolved<Promise>;documentTargetKey?:string;envelope:null|{baseRevision:null|number;baseSha256:null|string;content:string;localIdentity?:{canonicalPath:string;kind:\"local_file\";relayId:string};mimeType:string;path:string}};draft?:{appId:string;createActionId:null|string;roomId?:string;suggestedName:string};getLiveSession?:() => { sessionToken: string; sessionId: string; documentVersion: LiveDocumentVersion; } | null;iframe:unresolved<HTMLIFrameElement>;materialize?:(content: string, mimeType: string) => Promise<ArtifactTarget>;mediaProxy?:true;onContextUpdate?:(context: ActiveMiniAppContext) => void;onDocumentVersion?:(documentVersion: LiveDocumentVersion) => void | Promise<void>;onHumanEditUpdate?:(update: AppHumanEditUpdate) => void;onLifecycleRegistrationChange?:(registered: boolean) => void;onLiveProposalAccepted?:(result: ApplyAcceptedLiveProposalResponse) => void;onLiveProposalAcknowledged?:(input: { proposalId: string; documentVersion: LiveDocumentVersion; }) => void;onOpenPromotedVideoProject?:() => Promise<{ opened: boolean; code?: string }> | { opened: boolean; code?: string };onVideoGenerationGetTakeStatus?:(input: { takeId: string }) => Promise<VideoGenerationTakeStatusBridgeResult> | VideoGenerationTakeStatusBridgeResult;onVideoGenerationImportReference?:(input: { mediaKind: \"image\" | \"video\" | \"audio\" }) => Promise<VideoGenerationReferenceImportBridgeResult> | VideoGenerationReferenceImportBridgeResult;onVideoGenerationListTakes?:() => Promise<VideoGenerationTakeListBridgeResult> | VideoGenerationTakeListBridgeResult;onVideoGenerationPreviewTake?:(input: { takeId: string }) => Promise<VideoGenerationPreviewBridgeResult> | VideoGenerationPreviewBridgeResult;onVideoGenerationRequest?:( request: VideoGenerationBridgeRequest, ) => Promise<VideoGenerationBridgeResult> | VideoGenerationBridgeResult;onVideoGenerationRevalidateTake?:(input: { takeId: string }) => Promise<VideoGenerationRevalidationBridgeResult> | VideoGenerationRevalidationBridgeResult;onVideoHostLayout?:(input: { enabled: boolean }) => Promise<void> | void;onVideoProjectPromotion?:(input: { requestId: string; sha256: string; signal: AbortSignal; onProgress: (progress: unknown) => void }) => Promise<unknown>;onVideoWorkspaceMediaClosePreview?:(input: { revokeToken: string }) => Promise<void> | void;onVideoWorkspaceMediaExport?:(input: VideoWorkspaceMediaExportInput) => Promise<VideoWorkspaceMediaExportResult>;onVideoWorkspaceMediaImport?:() => Promise<VideoWorkspaceMediaImportBridgeResult> | VideoWorkspaceMediaImportBridgeResult;onVideoWorkspaceMediaOpenPreview?:(input: { mediaId: string; signal: AbortSignal }) => Promise< | { kind: \"ready\"; url: string; blob?: Blob; mimeType: string; sizeBytes: number; revokeToken: string; waveform?: { peaks: number[]; samplesPerSecond: number } } | { kind: \"unavailable\"; code: string } > | { kind: \"ready\"; url: string; blob?: Blob; mimeType: string; sizeBytes: number; revokeToken: string; waveform?: { peaks: number[]; samplesPerSecond: number } } | { kind: \"unavailable\"; code: string };saveCopy?:(content: string) => Promise<{ path: string }>;target?:unresolved<OpenFileTarget>;videoGeneration?:true;viewerKey?:null|string;workspaceCopyRoomLabel?:string}"
    ],
    "arbitraryPayloads": [
      {
        "path": "documentSession.documentReadPromise",
        "debtId": "debt.wire.arbitrary.1pjbi6v"
      },
      {
        "path": "iframe",
        "debtId": "debt.wire.arbitrary.e8lqi4"
      },
      {
        "path": "target",
        "debtId": "debt.wire.arbitrary.1mgxsot"
      }
    ]
  },
  {
    "observationId": "wire.app.bridge.host.to.app.arbitrary.apps.workbench.src.apps.app.bridge.ts.appbridgerequest.xxmqpw",
    "locator": "app_bridge:host_to_app_arbitrary:apps/workbench/src/apps/app-bridge.ts#AppBridgeRequest",
    "structuralSignatures": [
      "declaration.payload:unresolved<Readonly>&{type:\"nautilo.app.video-generation.request\"}|{acceptedContent:string;acceptedOperationIndexes:unknown;documentVersion:unknown;op:\"acceptProposal\";proposalId:string;requestId:string;type:\"nautilo.app.session.req\"}|{baseRevision?:null|number;baseSha256?:null|string;conflictPolicy?:\"strict\";op:\"downloadCopy\"|\"write\";requestId:string;type:\"nautilo.app.document.req\";value:unknown}|{documentVersion:unknown;op:\"invalidateProposal\";proposalId:string;proposalSessionToken:string;reason:\"human_changed\"|\"no_effective_change\"|\"remote_changed\"|\"session_closed\"|\"stale_version\";requestId:string;type:\"nautilo.app.session.req\"}|{documentVersion:unknown;op:\"resolveProposal\";outcome:\"accepted\"|\"rejected\";proposalId:string;requestId:string;type:\"nautilo.app.session.req\"}|{documentVersion:unknown;proposalId:string;type:\"nautilo.app.live-proposal.ack\"}|{enabled:boolean;op:\"setFullWidth\";requestId:string;type:\"nautilo.app.video-host-layout.req\"}|{exportSettings?:import(\"@nautilo/types\").VideoExportSettings;op:\"exportVideo\";publishToWorkspace?:boolean;requestId:string;revision:null|number;sha256:string;type:\"nautilo.app.media.req\"}|{fresh?:boolean;op:\"authoredChange\"|\"read\"|\"stat\";requestId:string;type:\"nautilo.app.document.req\"}|{key:string;op:\"get\";requestId:string;type:\"nautilo.app.state.req\"}|{key:string;op:\"set\";requestId:string;type:\"nautilo.app.state.req\";value:unknown}|{key:unresolved<AppPreferenceKey>;op:\"get\";requestId:string;type:\"nautilo.app.preferences.req\"}|{key:unresolved<AppPreferenceKey>;op:\"set\";requestId:string;type:\"nautilo.app.preferences.req\";value:unknown}|{key:unresolved<AppPreferenceKey>;type:\"nautilo.app.preferences.subscribe\"}|{mediaId:string}|{ref:string}&{op:\"openPreview\";requestId:string;type:\"nautilo.app.media.req\"}|{mediaKind:\"audio\"|\"image\"|\"video\";op:\"importReference\";requestId:string;type:\"nautilo.app.video-generation.req\"}|{op:\"closePreview\";requestId:string;revokeToken:string;type:\"nautilo.app.media.req\"}|{op:\"exportCapabilities\";requestId:string;type:\"nautilo.app.media.req\"}|{op:\"getTakeStatus\"|\"listTakes\"|\"previewTake\"|\"revalidateTake\";requestId:string;takeId?:string;type:\"nautilo.app.video-generation.req\"}|{op:\"importVideo\";requestId:string;type:\"nautilo.app.media.req\"}|{op:\"openWorkspaceCopy\";requestId:string;type:\"nautilo.app.media.req\"}|{op:\"pick\";requestId:string;type:\"nautilo.app.assets.req\"}|{op:\"read\";ref:string;requestId:string;type:\"nautilo.app.assets.req\"}|{op:\"read\";ref:string;requestId:string;type:\"nautilo.app.asset.req\"}|{op:\"saveCopy\";requestId:string;type:\"nautilo.app.document.req\";value:unknown}|{op:\"saveWorkspaceCopy\";requestId:string;sha256:string;type:\"nautilo.app.media.req\"}|{op:\"workspaceCopyCapabilities\";requestId:string;type:\"nautilo.app.media.req\"}|{requestId:string;type:\"nautilo.app.asset.cancel\"}|{requestId:string;type:\"nautilo.app.media.cancel\"}|{summary:unknown;type:\"nautilo.app.context.update\"}|{type:\"nautilo.app.human-edit.update\";update:{draftPatch?:unresolved<AnchoredTextPatch>;state:\"clean\"|\"conflict\"|\"dirty\"|\"saving\"}}|{type:\"nautilo.app.lifecycle.register\"}|{type:\"nautilo.app.lifecycle.unregister\"}"
    ],
    "arbitraryPayloads": [
      {
        "path": "acceptedOperationIndexes",
        "debtId": "debt.wire.arbitrary.rddovr"
      },
      {
        "path": "documentVersion",
        "debtId": "debt.wire.arbitrary.u5zte0"
      },
      {
        "path": "key",
        "schema": "AppPreferenceKey"
      },
      {
        "path": "summary",
        "debtId": "debt.wire.arbitrary.z2o3n7"
      },
      {
        "path": "update.draftPatch",
        "debtId": "debt.wire.arbitrary.z234jl"
      },
      {
        "path": "value",
        "debtId": "debt.wire.arbitrary.q5uskq"
      }
    ]
  },
  {
    "observationId": "wire.app.bridge.host.to.app.arbitrary.apps.workbench.src.apps.app.bridge.ts.appdocumentchangedevent.169wx4v",
    "locator": "app_bridge:host_to_app_arbitrary:apps/workbench/src/apps/app-bridge.ts#AppDocumentChangedEvent",
    "structuralSignatures": [
      "declaration.payload:{author?:unresolved<DocumentPatchAuthor>;envelope:{baseRevision:null|number;baseSha256:string;content:string;mimeType:string;path:string};patch:unresolved<AnchoredTextPatch>;patchId:string;path?:string;previousRevision:null|number;previousSha256:string;rebased?:boolean;revision:null|number;sha256:string;type:\"patch_applied\"}|{path?:string;reloadRequired?:boolean;type:\"changed\"}|{path?:string;type:\"renamed\"}|{type:\"deleted\"}|{type:\"reconnected\"}"
    ],
    "arbitraryPayloads": [
      {
        "path": "author",
        "debtId": "debt.wire.arbitrary.1tcjxjj"
      },
      {
        "path": "patch",
        "debtId": "debt.wire.arbitrary.10hcq7m"
      }
    ]
  },
  {
    "observationId": "wire.app.bridge.host.to.app.arbitrary.apps.workbench.src.apps.app.bridge.ts.videoworkspacemediaexportinput.si04q9",
    "locator": "app_bridge:host_to_app_arbitrary:apps/workbench/src/apps/app-bridge.ts#VideoWorkspaceMediaExportInput",
    "structuralSignatures": [
      "declaration.payload:{exportSettings?:import(\"@nautilo/types\").VideoExportSettings;onProgress:(progress: unknown) => void;publishToWorkspace:boolean;requestId:string;revision:null|number;sha256:string;signal:unresolved<AbortSignal>}"
    ],
    "arbitraryPayloads": [
      {
        "path": "signal",
        "schema": "DocumentMediaSignalV1"
      }
    ]
  },
  {
    "observationId": "wire.app.bridge.host.to.app.arbitrary.apps.workbench.src.apps.app.bridge.ts.videoworkspacemediaexportresult.ohkwfu",
    "locator": "app_bridge:host_to_app_arbitrary:apps/workbench/src/apps/app-bridge.ts#VideoWorkspaceMediaExportResult",
    "structuralSignatures": [
      "declaration.payload:{code:string;kind:\"unavailable\"}|{kind:\"cancelled\"}|{kind:\"succeeded\";label:string;sizeBytes:number;warnings:unknown[];workspace?:{artifactId?:string;path:string;status:\"not_published\"|\"published\"|\"unknown\"}}"
    ],
    "arbitraryPayloads": [
      {
        "path": "warnings[]",
        "schema": "DocumentMediaWarningsV1"
      }
    ]
  },
  {
    "observationId": "wire.app.bridge.host.to.app.arbitrary.apps.workbench.src.apps.app.bridge.ts.writebounddocumentopts.gpghzx",
    "locator": "app_bridge:host_to_app_arbitrary:apps/workbench/src/apps/app-bridge.ts#WriteBoundDocumentOpts",
    "structuralSignatures": [
      "declaration.payload:{allowSnapshotFallback?:boolean;baseRevision?:null|number;baseSha256?:null|string;conflictPolicy?:\"strict\";session?:{documentReadGeneration?:number;documentReadPromise?:unresolved<Promise>;documentTargetKey?:string;envelope:null|{baseRevision:null|number;baseSha256:null|string;content:string;localIdentity?:{canonicalPath:string;kind:\"local_file\";relayId:string};mimeType:string;path:string}}}"
    ],
    "arbitraryPayloads": [
      {
        "path": "session.documentReadPromise",
        "debtId": "debt.wire.arbitrary.1fb90vq"
      }
    ]
  },
  {
    "observationId": "wire.app.bridge.host.to.app.nautilo.app.media.export.progress.1yvt0pb",
    "locator": "app_bridge:host_to_app:nautilo.app.media.export-progress",
    "structuralSignatures": [],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.app.bridge.host.to.app.nautilo.app.media.promotion.progress.j9ws7k",
    "locator": "app_bridge:host_to_app:nautilo.app.media.promotion-progress",
    "structuralSignatures": [],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.video.generations.takeid.status.zjft1z",
    "locator": "http:request_response:GET /api/video-generations/:takeId/status",
    "structuralSignatures": [
      "request.params:{takeId?:string}",
      "request.query:{projectArtifactId?:string;roomId?:string}",
      "response.body:unknown",
      "response.body:{artifact?:{artifactId:string;bytes:number;mime:string;path:string;zone:\"workspace\"};dtoVersion:1;failure?:{chargeCertainty:\"charged\"|\"not_charged\"|\"refunded\"|\"unknown\";code:string;completionCertainty:\"accepted\"|\"complete\"|\"not_started\"|\"unknown\";creditsRefunded?:boolean;message:string;phase:\"cleanup\"|\"download\"|\"queue\"|\"quote\"|\"reconcile\"|\"retrieve\"|\"save\";retrySafe:boolean;stateChanged:boolean};mediaKind:\"audio\"|\"video\";modelId:string;progress?:{elapsedSeconds?:number;estimatedSeconds?:number;message?:string;phase:\"downloading\"|\"generating\"|\"queued\"|\"saving\"|\"submitting\"};recoveryActions:{actionId:string;kind:\"fresh_generation\"|\"repair_venice\"|\"retry_same_receipt\"|\"revise_prompt\"|\"switch_model\"|\"wait\";label:string;newSpend:boolean}[];revision:number;settings:{aspectRatio?:string;audioEnabled?:boolean;durationSeconds?:number;instrumental?:boolean;resolution?:string};state:\"cleanup-pending\"|\"downloading\"|\"failed\"|\"generating\"|\"needs-action\"|\"queued\"|\"ready\"|\"saving\"|\"submitting\"|\"unknown\";takeId:string}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": [
      {
        "path": "response.body",
        "schema": "DocumentMediaResponseBodyV1"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.get.api.video.generations.ulq9z3",
    "locator": "http:request_response:GET /api/video-generations",
    "structuralSignatures": [
      "request.query:{projectArtifactId?:string;roomId?:string}",
      "response.body:unknown",
      "response.body:{error:string}",
      "response.body:{takes:{documentRevision:number;shotId:string;shotLabel:string;takeId:string}[]}"
    ],
    "arbitraryPayloads": [
      {
        "path": "response.body",
        "schema": "DocumentMediaResponseBodyV1"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.get.api.workspace.artifacts.by.public.id.artifactid.kablmj",
    "locator": "http:request_response:GET /api/workspace/artifacts/by-public-id/:artifactId",
    "structuralSignatures": [
      "request.params:{artifactId:string}",
      "response.body:{artifactId:string;canWrite:boolean;createdAt:string;id:string;mimeType:string;namespaceIds:string[];path:string;revision:number;size:number;updatedAt:string}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.workspace.artifacts.id.authored.change.aj20ot",
    "locator": "http:request_response:GET /api/workspace/artifacts/:id/authored-change",
    "structuralSignatures": [
      "request.params:{id:string}",
      "request.query:{[key:string]:unknown}",
      "response.body:{after:{content:string;sha256:string};author:{displayName:\"Genie\";kind:\"agent\"};before:{content:string;sha256:string};currentSha256:string;kind:\"ready\";operationId:string}|{code:\"document_changed\"|\"history_unavailable\";kind:\"unavailable\"}|{kind:\"none\"}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": [
      {
        "path": "request.query",
        "schema": "DocumentMediaRequestQueryV1"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.get.api.workspace.shared.with.me.zhdxux",
    "locator": "http:request_response:GET /api/workspace/shared-with-me",
    "structuralSignatures": [
      "response.body:{artifacts:{artifactId:string;id:string;mimeType:string;path:string;revision:number;roomId:string;sharedAt:Date;sharedBy:string;size:number;updatedAt:Date}[]}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.apps.appid.video.host.attestation.1bswcox",
    "locator": "http:request_response:POST /api/apps/:appId/video-host-attestation",
    "structuralSignatures": [
      "request.body:{projectArtifactId?:unknown;roomId?:unknown;sourceHash?:unknown}",
      "request.params:{appId:string}",
      "response.body:{attestationToken:string;expiresAt:string}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": [
      {
        "path": "request.body.projectArtifactId",
        "schema": "DocumentMediaRequestBodyProjectArtifactIdV1"
      },
      {
        "path": "request.body.roomId",
        "schema": "DocumentMediaRequestBodyRoomIdV1"
      },
      {
        "path": "request.body.sourceHash",
        "schema": "DocumentMediaRequestBodySourceHashV1"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.post.api.apps.appid.video.host.attestation.revoke.1hjpmc8",
    "locator": "http:request_response:POST /api/apps/:appId/video-host-attestation/revoke",
    "structuralSignatures": [
      "request.body:{[key:string]:unknown}",
      "request.params:{appId:string}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": [
      {
        "path": "request.body",
        "schema": "DocumentMediaRequestBodyV1"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.post.api.video.generations.prepare.emgne9",
    "locator": "http:request_response:POST /api/video-generations/prepare",
    "structuralSignatures": [
      "response.body:unknown",
      "response.body:{approval:{digest:string;expiresAt:string;preview:{mediaKind:\"music\"|\"video\";model:\"minimax-h3-enhanced-text-to-video\"|\"minimax-music-v26\"|\"seedance-2-5-reference-to-video-basic\"|\"seedance-2-5-text-to-video-basic\"|\"sonilo-v1-1-music\";prompt:{characterCount:number;summary:string;truncated:boolean};quote:{amountMicros:number;currency:\"USD\";display:string};referenceImages?:{artifactId:string;content?:{mimeType:string;sha256:string;sizeBytes:number};index:number;label:string}[];referenceVideos?:{artifactId:string;content?:{mimeType:string;sha256:string;sizeBytes:number};durationSeconds:number;index:number;label:string}[];settings:{[key:string]:false|number|string|true};spendNotice:\"Approving starts a paid generation using this exact quote.\"};quoteDigest:string;revision:1;version:\"media-generation-approval-v1\"};reviewHandle:string;takeId:string}",
      "response.body:{code:\"already_prepared\"|\"quote_unavailable\"|\"request_invalid\";ok:false;recovery:string}|{ok:true;review:{approval:{digest:string;expiresAt:string;preview:{mediaKind:\"music\"|\"video\";model:\"minimax-h3-enhanced-text-to-video\"|\"minimax-music-v26\"|\"seedance-2-5-reference-to-video-basic\"|\"seedance-2-5-text-to-video-basic\"|\"sonilo-v1-1-music\";prompt:{characterCount:number;summary:string;truncated:boolean};quote:{amountMicros:number;currency:\"USD\";display:string};referenceImages?:{artifactId:string;content?:{mimeType:string;sha256:string;sizeBytes:number};index:number;label:string}[];referenceVideos?:{artifactId:string;content?:{mimeType:string;sha256:string;sizeBytes:number};durationSeconds:number;index:number;label:string}[];settings:{[key:string]:false|number|string|true};spendNotice:\"Approving starts a paid generation using this exact quote.\"};quoteDigest:string;revision:1;version:\"media-generation-approval-v1\"};reviewHandle:string;takeId:string}}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": [
      {
        "path": "response.body",
        "schema": "DocumentMediaResponseBodyV1"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.post.api.video.generations.takeid.submit.1qajuxf",
    "locator": "http:request_response:POST /api/video-generations/:takeId/submit",
    "structuralSignatures": [
      "request.params:{takeId?:string}",
      "response.body:unknown",
      "response.body:{error:string}",
      "response.body:{failure?:{code:string;creditsRefunded?:boolean;message:string};mediaKind:\"audio\"|\"video\";model:string;promptSummary:string;queueStarted:boolean;recoveryActions:{actionId:string;kind:\"fresh_generation\"|\"repair_venice\"|\"retry_same_receipt\"|\"revise_prompt\"|\"switch_model\"|\"wait\";label:string;newSpend:boolean}[];settings:{[key:string]:false|number|string|true};state:\"cleanup-pending\"|\"downloading\"|\"failed\"|\"generating\"|\"needs-action\"|\"queued\"|\"ready\"|\"saving\"|\"unknown\";takeId:string}"
    ],
    "arbitraryPayloads": [
      {
        "path": "response.body",
        "schema": "DocumentMediaResponseBodyV1"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.post.api.workspace.artifacts.id.share.45eghx",
    "locator": "http:request_response:POST /api/workspace/artifacts/:id/share",
    "structuralSignatures": [
      "request.body:{recipientUserId?:unknown}",
      "request.params:{id:string}",
      "response.body:{error:string}",
      "response.body:{status:\"already_shared\"|\"shared\"}"
    ],
    "arbitraryPayloads": [
      {
        "path": "request.body.recipientUserId",
        "schema": "DocumentMediaRequestBodyRecipientUserIdV1"
      }
    ]
  }
];

export const SUPERSEDED_MAIN_2026_09_09_DOCUMENTMEDIA_DTO_LOCATORS = new Set(REVIEWED_MAIN_2026_09_09_DOCUMENTMEDIA_DTO_DECLARATIONS.map((entry) => entry.locator));
