import type { DtoDeclaration } from "../src/node/dto-inventory";

/** Existing DTO declarations whose exact current structural snapshots replace older shapes. */
export const SUPERSEDED_MAIN_2026_09_12_DTO_LOCATORS = new Set<string>(
[
  "app_bridge:host_to_app_arbitrary:apps/workbench/src/apps/app-bridge.ts#AppBridgeOptions",
  "app_bridge:host_to_app_arbitrary:apps/workbench/src/apps/app-bridge.ts#AppBridgeRequest",
  "http:request_response:GET /api/admin/reflection-status",
  "http:request_response:GET /api/admin/server-models",
  "http:request_response:GET /api/apps/:appId/runtime",
  "http:request_response:GET /api/memory/:id",
  "http:request_response:GET /api/tasks/pending-attention",
  "http:request_response:GET /api/workspace/artifacts",
  "http:request_response:POST /api/admin/server-models",
  "http:request_response:POST /api/apps/:appId/disable",
  "http:request_response:POST /api/apps/:appId/enable",
  "http:request_response:POST /api/message-backfill/source",
  "http:request_response:POST /api/workspace/artifacts/:id/share"
],
);

/** Exact current shapes for existing DTOs; prior arbitrary-payload decisions are preserved. */
export const REVIEWED_MAIN_2026_09_12_DTO_REPLACEMENTS: readonly DtoDeclaration[] = [
  {
    "observationId": "wire.app.bridge.host.to.app.arbitrary.apps.workbench.src.apps.app.bridge.ts.appbridgeoptions.ojsugv",
    "locator": "app_bridge:host_to_app_arbitrary:apps/workbench/src/apps/app-bridge.ts#AppBridgeOptions",
    "structuralSignatures": [
      "declaration.payload:{appId:string;assetReadRaster?:true;assets?:{};documentSession?:{documentReadGeneration?:number;documentReadPromise?:unresolved<Promise>;documentTargetKey?:string;envelope:null|{baseRevision:null|number;baseSha256:null|string;content:string;localIdentity?:{canonicalPath:string;kind:\"local_file\";relayId:string};mimeType:string;path:string}};draft?:{appId:string;createActionId:null|string;roomId?:string;suggestedName:string};getLiveSession?:() => { sessionToken: string; sessionId: string; documentVersion: LiveDocumentVersion; } | null;iframe:unresolved<HTMLIFrameElement>;materialize?:(content: string, mimeType: string) => Promise<ArtifactTarget>;mediaProxy?:true;mode?:\"edit\"|\"preview\";onContextUpdate?:(context: ActiveMiniAppContext) => void;onDocumentVersion?:(documentVersion: LiveDocumentVersion) => void | Promise<void>;onHumanEditUpdate?:(update: AppHumanEditUpdate) => void;onLifecycleRegistrationChange?:(registered: boolean) => void;onLiveProposalAccepted?:(result: ApplyAcceptedLiveProposalResponse) => void;onLiveProposalAcknowledged?:(input: { proposalId: string; documentVersion: LiveDocumentVersion; }) => void;onOpenPromotedVideoProject?:() => Promise<{ opened: boolean; code?: string }> | { opened: boolean; code?: string };onVideoGenerationGetTakeStatus?:(input: { takeId: string }) => Promise<VideoGenerationTakeStatusBridgeResult> | VideoGenerationTakeStatusBridgeResult;onVideoGenerationImportReference?:(input: { mediaKind: \"image\" | \"video\" | \"audio\" }) => Promise<VideoGenerationReferenceImportBridgeResult> | VideoGenerationReferenceImportBridgeResult;onVideoGenerationListTakes?:() => Promise<VideoGenerationTakeListBridgeResult> | VideoGenerationTakeListBridgeResult;onVideoGenerationPreviewTake?:(input: { takeId: string }) => Promise<VideoGenerationPreviewBridgeResult> | VideoGenerationPreviewBridgeResult;onVideoGenerationRequest?:( request: VideoGenerationBridgeRequest, ) => Promise<VideoGenerationBridgeResult> | VideoGenerationBridgeResult;onVideoGenerationRevalidateTake?:(input: { takeId: string }) => Promise<VideoGenerationRevalidationBridgeResult> | VideoGenerationRevalidationBridgeResult;onVideoHostLayout?:(input: { enabled: boolean }) => Promise<void> | void;onVideoProjectPromotion?:(input: { requestId: string; sha256: string; signal: AbortSignal; onProgress: (progress: unknown) => void }) => Promise<unknown>;onVideoWorkspaceMediaClosePreview?:(input: { revokeToken: string }) => Promise<void> | void;onVideoWorkspaceMediaExport?:(input: VideoWorkspaceMediaExportInput) => Promise<VideoWorkspaceMediaExportResult>;onVideoWorkspaceMediaImport?:() => Promise<VideoWorkspaceMediaImportBridgeResult> | VideoWorkspaceMediaImportBridgeResult;onVideoWorkspaceMediaOpenPreview?:(input: { mediaId: string; signal: AbortSignal }) => Promise< | { kind: \"ready\"; url: string; blob?: Blob; mimeType: string; sizeBytes: number; revokeToken: string; waveform?: { peaks: number[]; samplesPerSecond: number } } | { kind: \"unavailable\"; code: string } > | { kind: \"ready\"; url: string; blob?: Blob; mimeType: string; sizeBytes: number; revokeToken: string; waveform?: { peaks: number[]; samplesPerSecond: number } } | { kind: \"unavailable\"; code: string };recovery?:unresolved<AppDraftRecoveryPort>;saveCopy?:(content: string) => Promise<{ path: string }>;target?:unresolved<OpenFileTarget>;templates?:unresolved<AppSlideTemplateLibrary>;videoGeneration?:true;viewerKey?:null|string;workspaceCopyRoomLabel?:string}"
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
      },
      {
        "path": "recovery",
        "schema": "AppDraftRecoveryPort"
      },
      {
        "path": "templates",
        "schema": "AppSlideTemplateLibrary"
      }
    ]
  },
  {
    "observationId": "wire.app.bridge.host.to.app.arbitrary.apps.workbench.src.apps.app.bridge.ts.appbridgerequest.xxmqpw",
    "locator": "app_bridge:host_to_app_arbitrary:apps/workbench/src/apps/app-bridge.ts#AppBridgeRequest",
    "structuralSignatures": [
      "declaration.payload:unresolved<Readonly>&{type:\"nautilo.app.video-generation.request\"}|{acceptedContent:string;acceptedOperationIndexes:unknown;documentVersion:unknown;op:\"acceptProposal\";proposalId:string;requestId:string;type:\"nautilo.app.session.req\"}|{baseRevision?:null|number;baseSha256?:null|string;conflictPolicy?:\"strict\";op:\"downloadCopy\"|\"write\";requestId:string;type:\"nautilo.app.document.req\";value:unknown}|{content:string;name:string;op:\"save\";requestId:string;type:\"nautilo.app.templates.req\"}|{op:\"list\";requestId:string;type:\"nautilo.app.templates.req\"}|{op:\"read\"|\"remove\";requestId:string;templateId:string;type:\"nautilo.app.templates.req\"}|{documentVersion:unknown;op:\"invalidateProposal\";proposalId:string;proposalSessionToken:string;reason:\"human_changed\"|\"no_effective_change\"|\"remote_changed\"|\"session_closed\"|\"stale_version\";requestId:string;type:\"nautilo.app.session.req\"}|{documentVersion:unknown;op:\"resolveProposal\";outcome:\"accepted\"|\"rejected\";proposalId:string;requestId:string;type:\"nautilo.app.session.req\"}|{documentVersion:unknown;proposalId:string;type:\"nautilo.app.live-proposal.ack\"}|{enabled:boolean;op:\"setFullWidth\";requestId:string;type:\"nautilo.app.video-host-layout.req\"}|{exportSettings?:import(\"@nautilo/types\").VideoExportSettings;op:\"exportVideo\";publishToWorkspace?:boolean;requestId:string;revision:null|number;sha256:string;type:\"nautilo.app.media.req\"}|{fresh?:boolean;op:\"authoredChange\"|\"read\"|\"stat\";requestId:string;type:\"nautilo.app.document.req\"}|{input:unresolved<AppRecoveryWrite>;op:\"write\";requestId:string;type:\"nautilo.app.recovery.req\"}|{op:\"read\";requestId:string;type:\"nautilo.app.recovery.req\"}|{key:string;op:\"get\";requestId:string;type:\"nautilo.app.state.req\"}|{key:string;op:\"set\";requestId:string;type:\"nautilo.app.state.req\";value:unknown}|{key:unresolved<AppPreferenceKey>;op:\"get\";requestId:string;type:\"nautilo.app.preferences.req\"}|{key:unresolved<AppPreferenceKey>;op:\"set\";requestId:string;type:\"nautilo.app.preferences.req\";value:unknown}|{key:unresolved<AppPreferenceKey>;type:\"nautilo.app.preferences.subscribe\"}|{mediaId:string}|{ref:string}&{op:\"openPreview\";requestId:string;type:\"nautilo.app.media.req\"}|{mediaKind:\"audio\"|\"image\"|\"video\";op:\"importReference\";requestId:string;type:\"nautilo.app.video-generation.req\"}|{op:\"closePreview\";requestId:string;revokeToken:string;type:\"nautilo.app.media.req\"}|{op:\"exportCapabilities\";requestId:string;type:\"nautilo.app.media.req\"}|{op:\"getTakeStatus\"|\"listTakes\"|\"previewTake\"|\"revalidateTake\";requestId:string;takeId?:string;type:\"nautilo.app.video-generation.req\"}|{op:\"importVideo\";requestId:string;type:\"nautilo.app.media.req\"}|{op:\"openWorkspaceCopy\";requestId:string;type:\"nautilo.app.media.req\"}|{op:\"pick\";requestId:string;type:\"nautilo.app.assets.req\"}|{op:\"read\";ref:string;requestId:string;type:\"nautilo.app.assets.req\"}|{op:\"read\";ref:string;requestId:string;type:\"nautilo.app.asset.req\"}|{op:\"saveCopy\";requestId:string;type:\"nautilo.app.document.req\";value:unknown}|{op:\"saveWorkspaceCopy\";requestId:string;sha256:string;type:\"nautilo.app.media.req\"}|{op:\"workspaceCopyCapabilities\";requestId:string;type:\"nautilo.app.media.req\"}|{requestId:string;type:\"nautilo.app.asset.cancel\"}|{requestId:string;type:\"nautilo.app.media.cancel\"}|{summary:unknown;type:\"nautilo.app.context.update\"}|{type:\"nautilo.app.human-edit.update\";update:{draftPatch?:unresolved<AnchoredTextPatch>;state:\"clean\"|\"conflict\"|\"dirty\"|\"saving\"}}|{type:\"nautilo.app.lifecycle.register\"}|{type:\"nautilo.app.lifecycle.unregister\"}"
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
      },
      {
        "path": "input",
        "schema": "AppRecoveryWrite"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.get.api.admin.reflection.status.eqtoyg",
    "locator": "http:request_response:GET /api/admin/reflection-status",
    "structuralSignatures": [
      "response.body:{current:{backlog:number;checkpointed:number;claimed:number;complete:number;currentParentViolations:number;deferred:number;due:number;maximumAttempts:number;maximumRecoveryRound:number;oldestOverdueMs:number;quarantined:number;recoveryEligible:number;staleLeases:number;totalRecords:number};currentFailures:{attemptCount:number;errorCode:\"authority_unavailable\"|\"candidate_unavailable\"|\"embedding_unavailable\"|\"invalid_model_output\"|\"projection_unavailable\"|\"publication_unavailable\"|\"record_unavailable\"|\"retry_exhausted\"|\"unexpected_failure\";occurredAt:string;stage:\"authority_projection\"|\"organization\"|\"search_projection\"}[];generatedAt:string;health:\"degraded\"|\"delayed\"|\"healthy\";last24h:{completedWork:number;syntheticParentsCreated:number};lastCompletedAt?:string;nextRecoveryAt?:string;projections:{availableRecords:number;current:number;incompatible:number;pending:number};protectedAuthority?:{current:{awaitingEligibleDeviceAndKeys:string;awaitingRecipient:string;readyOrRunning:string;reconciliationPending:string;retirementPending:string;terminalOrStale:string;verifiedAuthority:string};dtoVersion:1;last24h:{terminalOrStale:string;verifiedAuthority:string};scope:\"authority_maintenance_only\"};scheduler:{amplification:\"normal\"|\"pressure\"|\"watch\";backlog:{oldestAgeMs:number;size:number};lastPoll?:{authorityElapsedMs:number;candidateElapsedMs:number;candidatesOpened:number;capacityOutcomes:number;claims:number;crossRoomCompletions:number;crossRoomPlans:number;databaseWork:number;deterministicNoChanges:number;elapsedMs:number;modelCalls:number;modelElapsedMs:number;modelFailures:number;noEffectiveAudience:number;protectedExecutionUnavailable:number;publicationElapsedMs:number;sameRoomCompletions:number;sameRoomPlans:number;searchProjectionElapsedMs:number;stalePlans:number;unsupportedAuthorityShapes:number};latency:{crossRoom:{candidate:{maximumMs:number;p50Ms:number;p90Ms:number;samples:number};endToEnd:{maximumMs:number;p50Ms:number;p90Ms:number;samples:number};model:{maximumMs:number;p50Ms:number;p90Ms:number;samples:number};publication:{maximumMs:number;p50Ms:number;p90Ms:number;samples:number};queue:{maximumMs:number;p50Ms:number;p90Ms:number;samples:number}};sameRoom:{candidate:{maximumMs:number;p50Ms:number;p90Ms:number;samples:number};endToEnd:{maximumMs:number;p50Ms:number;p90Ms:number;samples:number};model:{maximumMs:number;p50Ms:number;p90Ms:number;samples:number};publication:{maximumMs:number;p50Ms:number;p90Ms:number;samples:number};queue:{maximumMs:number;p50Ms:number;p90Ms:number;samples:number}}};nextEligiblePollAt?:string;pauseReason?:\"backlog_growth\"|\"elapsed_budget\"|\"recursive_amplification\"|\"repeated_failure\";recoveryIntervalMs:number;state:\"cooldown\"|\"disabled\"|\"pressure_paused\"|\"running\";window:{admitted:number;completed:number;created:number;polls:number}};stages:{authorityProjection:number;organization:number;searchProjection:number};window:{since:string;until:string}}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.admin.server.models.1k8b8za",
    "locator": "http:request_response:GET /api/admin/server-models",
    "structuralSignatures": [
      "response.body:{conductorModel:string;defaultChatModel:string;effectiveEmbeddingModel:string;effectiveImageModel:string;effectiveMusicModel:string;effectiveVideoModel:string;embeddingModel:string;embeddingModels:{available:boolean;displayName:string;id:string}[];embeddingSelectionPending:boolean;fallbackChain:string[];imageModel:string;imageModels:{available:boolean;displayName:string;id:string;provider:string;unavailableReason?:string}[];memoryReviewModel:string;musicModel:string;musicModels:{available:boolean;displayName:string;id:string;provider:string;unavailableReason?:string}[];reasoningOutput:{[key:string]:boolean};reasoningPolicy:{defaultEffort:\"high\"|\"low\"|\"max\"|\"medium\"|\"minimal\"|\"off\"|\"xhigh\";overrides:{[key:string]:\"high\"|\"low\"|\"max\"|\"medium\"|\"minimal\"|\"off\"|\"xhigh\"}};reflectionModel:string;stenographerModel:string;videoModel:string;videoModels:{available:boolean;displayName:string;id:string;provider:string;unavailableReason?:string}[]}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.apps.appid.runtime.rsa41g",
    "locator": "http:request_response:GET /api/apps/:appId/runtime",
    "structuralSignatures": [
      "request.params:{appId:string}",
      "response.body:{agentToolsBuild:{message:string;status:\"failed\"}|{outputFile:\"agent-tools.mjs\";status:\"ok\";toolCount:number;toolNames:string[]}|{status:\"none\"};appId:string;hostCapabilities?:{assetReadRaster?:true;assets?:true;mediaProxy?:true;videoGeneration?:true};manifest:{agent?:{contextProvider?:string;instructions?:string;tools?:{approvalMode?:\"hybrid\"|\"static\";description:string;handler:string;id:string;impact:\"destructive\"|\"high\"|\"low\"|\"read-only\";inputSchema:unknown;module:string;officeTransform?:{format:\"docx\"|\"xlsx\";operation:\"export\"|\"import\"|\"inspect\"|\"mutate\"};requiredCapability?:string;resultScanPolicy?:\"always\"|\"never\"|\"on-suspicious\";runtime:\"server\";title?:string}[]};capabilities:{document?:{artifact?:\"none\"|\"read\"|\"readwrite\";currentFolder?:\"none\"|\"read\"|\"readwrite\"};office?:\"convert\"|\"none\";state?:\"none\"|\"read\"|\"readwrite\"};conversions?:{export?:{id:string;label:string;prepareInApp?:boolean;selectWorkspaceDestination?:boolean;targetSurfaces:\"currentFolder\"|\"workspace\"[];to:{extension:string;mimeType:string};tool:string}[];import?:{from:{extensions?:string[];mimeTypes?:string[]};id:string;label:string;openAfterImport?:boolean;sourceSurfaces:\"currentFolder\"|\"workspace\"[];target:{extension:string;surface:\"currentFolder\"|\"workspace\"};tool:string}[]};fileAssociations:{extensions?:string[];mimeTypes?:string[]};id:string;liveReview?:{enabled:true};name:string;version:string};sourceHash:string;srcDoc:string}",
      "response.body:{error:string;message:any;status:any}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": [
      {
        "path": "response.body.manifest.agent.tools[].inputSchema",
        "debtId": "debt.wire.arbitrary.19gu260"
      },
      {
        "path": "response.body.message",
        "debtId": "debt.wire.arbitrary.16onp1h"
      },
      {
        "path": "response.body.status",
        "debtId": "debt.wire.arbitrary.9plc14"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.get.api.memory.id.1d5thzp",
    "locator": "http:request_response:GET /api/memory/:id",
    "structuralSignatures": [
      "request.params:{id:string}",
      "response.body:{accessContext?:{label:string;roomId:string};actionAuthority:{canArchive:boolean;canEdit:boolean;canHardDelete:boolean;canManageAccess:boolean};memory:{accessList:{displayName:string;userHandle:string}[];content:string;createdAt:Date;demotedAt:Date;demotedFrom:number;id:string;importance:number;namespaceIds:string[];tier:number;type:string;updatedAt:Date};memoryMode:\"namespace\"}",
      "response.body:{actionAuthority:{canArchive:boolean;canEdit:boolean;canHardDelete:boolean;canManageAccess:boolean};memory:{content:string;createdAt:Date;demotedAt:Date;demotedFrom:number;id:string;importance:number;namespaceIds:string[];tier:number;type:string;updatedAt:Date};memoryMode:\"scope\"}",
      "response.body:{actionAuthority:{canArchive:boolean;canEdit:boolean;canManageAccess:boolean};dtoVersion:1;memory:{dtoVersion:1;ordinaryFallback?:{payload:{content:string;formatVersion:1;type:string};policyRevision:number};projection:{accessList?:{displayName:string;userHandle:string}[];contentRevision:number;createdAt:string;cryptoAccessRevision:number;demotedAt?:string;demotedFrom?:number;importance:number;memoryId:string;mutationAuthorities?:{currentGeneration:number;namespaceId:string;retainedGenerations:{accessRevision:number;audienceFingerprintBase64url:string;generation:number;headDigestBase64url:string;publicationDigestBase64url:string;publicationSetDigestBase64url:string}[];sourceRoomId:string}[];namespaceIds:string[];readAuthorities:{currentGeneration:number;namespaceId:string;retainedGenerations:{accessRevision:number;audienceFingerprintBase64url:string;generation:number;headDigestBase64url:string;publicationDigestBase64url:string;publicationSetDigestBase64url:string}[];sourceRoomId:string}[];representationRepair?:\"ordinary_to_protected\"|\"protected_to_ordinary\";requiredNamespaceIds:string[];scopeOrigin?:\"scope\"|\"seed\";tier:number;updatedAt:string};protectedPayload?:{accessManifestBytesBase64url:string;accessManifestProofBytesBase64url?:string[];accessSignerEvidence:{committerDeviceId:string;hostAuthorizationRevision:number;kind:\"human_device\";signingPublicKeyBase64url:string;subjectHumanId:string}|{deviceId:string;hostAuthorizationRevision:number;kind:\"evidence_issuer_human_device\";signingPublicKeyBase64url:string;subjectHumanId:string}|{evidenceBytesBase64url:string;kind:\"agent_runtime_publication\"|\"processor_authorization\"}|{kind:\"foreground_agent_accepted_execution\";planBytesBase64url:string;planDigestBase64url:string}[];cryptoObjectId:string;encryptedPayloadBytesBase64url:string;namespaceEnvelopes:{envelopeBytesBase64url:string;namespaceId:string}[];payloadVersion:1;status:\"encrypted\"}|{cryptoObjectId?:string;reason?:\"authorization_required\"|\"corrupt\"|\"deleted\"|\"embedding_unavailable\"|\"encryption_pending\"|\"incomplete_access_set\"|\"integrity_failure\"|\"legacy_plaintext\"|\"lost_key_material\"|\"missing_mapping\"|\"protected_representation_missing\"|\"stale_revision\"|\"target_encryption_not_ready\"|\"text_search_unsupported\"|\"unsupported_version\";status:\"unavailable\"}|{reason:\"backfill_pending\"|\"shadow_pending\";status:\"pending\"};readObservationAdmission?:{expiresAt:number;issuedAt:number;policyRevision:number;tokenBase64url:string};shadowComparison?:{algorithm:\"sha256-memory-payload-v1\";digestBase64url:string}};memoryMode:\"namespace\"|\"scope\";ordinaryFallbackAuthorization?:{policyRevision:number}}|{dtoVersion:1;reason:\"authorization_required\"|\"deleted\"|\"embedding_unavailable\"|\"encryption_pending\"|\"incomplete_access_set\"|\"integrity_failure\"|\"legacy_plaintext\"|\"missing_mapping\"|\"protected_representation_missing\"|\"stale_revision\"|\"target_encryption_not_ready\"|\"text_search_unsupported\";status:\"unavailable\"}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.tasks.pending.attention.113t48v",
    "locator": "http:request_response:GET /api/tasks/pending-attention",
    "structuralSignatures": [
      "response.body:{activity?:{appendResult?:boolean;appendResultSeparator?:\"\"|\"\\n\";args:{[key:string]:unknown};endedAt?:number;id:string;kind:\"command\"|\"file_change\"|\"status\"|\"tool\";name:string;result?:string;startedAt:number;status:\"completed\"|\"failed\"|\"running\"|\"waiting\"};detail:string;ownerId:string;preparation?:{activity?:\"checkpoint_saved\"|\"coverage_saved\"|\"evidence_saved\"|\"finding_saved\"|\"hypothesis_saved\"|\"loading_research\"|\"mapping_repository\"|\"reading_source\"|\"recovering_context\"|\"review_saved\"|\"saving_research\"|\"searching_source\"|\"validating_report\";contextPage?:{endByte:number;startByte:number;totalBytes:number};contextRecovery?:{pendingInputs:number;phase?:\"consolidation_required\"|\"inactive\"|\"reading\";recoveredInputBytes?:number;retainedUnconsolidatedPages?:number};directoriesObserved?:number;filesObserved?:number;probe?:\"gitleaks\"|\"osv_scanner\"|\"semgrep\"|\"trivy\";research?:{filesAssigned:number;filesTotal:number;unitsCompleted:number;unitsPending:number;unitsTotal:number};researchWork?:{reviewDecision?:\"accepted\"|\"follow_up\";role:\"coordinator\"|\"investigator\"|\"reviewer\";subject?:string};stage:\"inventory_progress\"|\"model_responding\"|\"preparing_model\"|\"preparing_scanners\"|\"recording_evidence\"|\"research_ready\"|\"scanner_finished\"|\"scanner_started\"|\"using_tools\"|\"waiting_model\"};taskId:string;taskRunId:string;type:\"task.progress\"}|{actor?:{agentId:string;kind:\"agent\"}|{humanId:string;kind:\"human\"};after?:{backendVersion:{kind:\"artifact_revision\";revision:number};identity:{artifactId:string;kind:\"workspace_artifact\";logicalPath:string};sha256:string}|{backendVersion:{kind:\"local_sha\";sha256:string};identity:{canonicalPath:string;kind:\"local_file\";relayId:string};sha256:string};before?:{backendVersion:{kind:\"artifact_revision\";revision:number};identity:{artifactId:string;kind:\"workspace_artifact\";logicalPath:string};sha256:string}|{backendVersion:{kind:\"local_sha\";sha256:string};identity:{canonicalPath:string;kind:\"local_file\";relayId:string};sha256:string};destinationBefore?:{backendVersion:{kind:\"artifact_revision\";revision:number};identity:{artifactId:string;kind:\"workspace_artifact\";logicalPath:string};sha256:string}|{backendVersion:{kind:\"local_sha\";sha256:string};identity:{canonicalPath:string;kind:\"local_file\";relayId:string};sha256:string};mutation:\"move\";operationId:string;outcome:\"applied\"|\"rebased\";overwrite:true;path:{after?:{artifactId:string;kind:\"workspace_artifact\";logicalPath:string}|{canonicalPath:string;kind:\"local_file\";relayId:string};before?:{artifactId:string;kind:\"workspace_artifact\";logicalPath:string}|{canonicalPath:string;kind:\"local_file\";relayId:string};destinationBefore?:{artifactId:string;kind:\"workspace_artifact\";logicalPath:string}|{canonicalPath:string;kind:\"local_file\";relayId:string};kind:\"move\";overwrite:true};revisionGroupId:string;sequence:number;type:\"document.mutation.committed\"}|{actor?:{agentId:string;kind:\"agent\"}|{humanId:string;kind:\"human\"};after?:{backendVersion:{kind:\"artifact_revision\";revision:number};identity:{artifactId:string;kind:\"workspace_artifact\";logicalPath:string};sha256:string}|{backendVersion:{kind:\"local_sha\";sha256:string};identity:{canonicalPath:string;kind:\"local_file\";relayId:string};sha256:string};before?:{backendVersion:{kind:\"artifact_revision\";revision:number};identity:{artifactId:string;kind:\"workspace_artifact\";logicalPath:string};sha256:string}|{backendVersion:{kind:\"local_sha\";sha256:string};identity:{canonicalPath:string;kind:\"local_file\";relayId:string};sha256:string};editorSave?:{anchoredPatch?:{kind:\"anchored_text\";newString:string;oldString:string;replaceAll?:boolean;scope?:{from:number;to:number}};checkpoint:boolean;clientMutationId?:string;requestId?:string};mutation:\"update\";operationId:string;outcome:\"applied\"|\"rebased\";path:{after?:{artifactId:string;kind:\"workspace_artifact\";logicalPath:string}|{canonicalPath:string;kind:\"local_file\";relayId:string};before?:{artifactId:string;kind:\"workspace_artifact\";logicalPath:string}|{canonicalPath:string;kind:\"local_file\";relayId:string};kind:\"update\"};revisionGroupId:string;sequence:number;type:\"document.mutation.committed\";workspaceArtifactMetadata?:{afterMimeType:string;beforeMimeType:string}}|{actor?:{agentId:string;kind:\"agent\"}|{humanId:string;kind:\"human\"};after?:{backendVersion:{kind:\"artifact_revision\";revision:number};identity:{artifactId:string;kind:\"workspace_artifact\";logicalPath:string};sha256:string}|{backendVersion:{kind:\"local_sha\";sha256:string};identity:{canonicalPath:string;kind:\"local_file\";relayId:string};sha256:string};before?:{backendVersion:{kind:\"artifact_revision\";revision:number};identity:{artifactId:string;kind:\"workspace_artifact\";logicalPath:string};sha256:string}|{backendVersion:{kind:\"local_sha\";sha256:string};identity:{canonicalPath:string;kind:\"local_file\";relayId:string};sha256:string};mutation:\"move\";operationId:string;outcome:\"applied\"|\"rebased\";overwrite:false;path:{after?:{artifactId:string;kind:\"workspace_artifact\";logicalPath:string}|{canonicalPath:string;kind:\"local_file\";relayId:string};before?:{artifactId:string;kind:\"workspace_artifact\";logicalPath:string}|{canonicalPath:string;kind:\"local_file\";relayId:string};kind:\"move\";overwrite:false};revisionGroupId:string;sequence:number;type:\"document.mutation.committed\"}|{actor?:{agentId:string;kind:\"agent\"}|{humanId:string;kind:\"human\"};after?:{backendVersion:{kind:\"artifact_revision\";revision:number};identity:{artifactId:string;kind:\"workspace_artifact\";logicalPath:string};sha256:string}|{backendVersion:{kind:\"local_sha\";sha256:string};identity:{canonicalPath:string;kind:\"local_file\";relayId:string};sha256:string};mutation:\"create\";operationId:string;outcome:\"applied\"|\"rebased\";path:{after?:{artifactId:string;kind:\"workspace_artifact\";logicalPath:string}|{canonicalPath:string;kind:\"local_file\";relayId:string};kind:\"create\"};revisionGroupId:string;sequence:number;type:\"document.mutation.committed\"}|{actor?:{agentId:string;kind:\"agent\"}|{humanId:string;kind:\"human\"};before?:{backendVersion:{kind:\"artifact_revision\";revision:number};identity:{artifactId:string;kind:\"workspace_artifact\";logicalPath:string};sha256:string}|{backendVersion:{kind:\"local_sha\";sha256:string};identity:{canonicalPath:string;kind:\"local_file\";relayId:string};sha256:string};mutation:\"delete\";operationId:string;outcome:\"applied\"|\"rebased\";path:{before?:{artifactId:string;kind:\"workspace_artifact\";logicalPath:string}|{canonicalPath:string;kind:\"local_file\";relayId:string};kind:\"delete\"};revisionGroupId:string;sequence:number;type:\"document.mutation.committed\"}|{actorId:string;createdAt:string;emoji:string;laneKey:string;messageId:number;type:\"reaction.added\"}|{actorId:string;emoji:string;laneKey:string;messageId:number;type:\"reaction.removed\"}|{agentId:string;availableRevisions:number;latest:{createdAt:string;operation:string;pinned:boolean;redoEligible:boolean;revisionId:string;summary:string;turnId:string};path:string;type:\"revisions.state_changed\"}|{agentId?:string;final:boolean;index:number;lang?:string;roomId?:string;text:string;type:\"voice.sentence\";userId?:string}|{agentId?:string;language:string;type:\"voice.suggestion\";userId?:string}|{allowedVerbs:\"always\"|\"deny\"|\"once\"|\"room\"[];approvalId:string;laneKey:string;localMcpInstall?:{digest:string;preview:{availabilitySummary:string;digest:string;environment:{name:string;present:boolean}[];human:string;machine:string;mayDownloadOnFirstRun:boolean;name:string;package:{name:string;version?:string};relayId:string;source:{label:string;url?:string};subprocessSandboxed:false;transport:{args:string[];command:string;kind:\"stdio\"}|{kind:\"streamable-http\";url:string};unpinnedPackage:boolean;version:\"local-mcp-install-v1\"};version:\"local-mcp-install-v1\"};mediaGeneration?:{digest:string;expiresAt:string;preview:{mediaKind:\"music\"|\"video\";model:\"minimax-h3-enhanced-text-to-video\"|\"minimax-music-v26\"|\"seedance-2-5-reference-to-video-basic\"|\"seedance-2-5-text-to-video-basic\"|\"sonilo-v1-1-music\";prompt:{characterCount:number;summary:string;truncated:boolean};quote:{amountMicros:number;currency:\"USD\";display:string};referenceImages?:{artifactId:string;content?:{mimeType:string;sha256:string;sizeBytes:number};index:number;label:string}[];referenceVideos?:{artifactId:string;content?:{mimeType:string;sha256:string;sizeBytes:number};durationSeconds:number;index:number;label:string}[];settings:{[key:string]:false|number|string|true};spendNotice:\"Approving starts a paid generation using this exact quote.\"};quoteDigest:string;revision:1;version:\"media-generation-approval-v1\"};network?:{host:string;port:number;reason:string;suggestedRule:{cidr?:string;host?:string;ports?:number[];suffix?:string;type:\"cidr\"|\"domain\"|\"wildcard\"}};origin?:\"task\";reason:string;reasonCode:\"command-scanner-high\"|\"command-scanner-medium\"|\"destructive-tool\"|\"external-binary\"|\"network-egress-denied\"|\"tier-bump\";requiresExplicitReview?:boolean;scopeInfo?:{approvalKind?:\"capability\"|\"tool\";capabilitySlug?:string;generalizedDisplay:string;onceDisplay:string;sameAsOnce:boolean}[];structuredSsh?:{approvedRequestDigest:string;argv?:string[];host:string;hostKeyFingerprint:string;hostTrust:\"changed\"|\"trusted\"|\"unknown\";localPath?:string;operation:\"auth\"|\"copy-download\"|\"copy-upload\"|\"exec\";port:number;preparationId:string;previousHostKeyFingerprint?:string;program?:string;remotePath?:string;remoteUser:string;timeoutReason?:string;timeoutSeconds?:number;toolCallId:string;version:\"structured-ssh-v1\"};taskId?:string;taskRunId?:string;threadId:string;tools:{args:{[key:string]:unknown};id?:string;name:string;runShellTimeout?:{reason:string;timeoutSeconds:number};shareArtifactPreview?:{artifactPathSnippet:string;mimeType:string;roomLabel:string;sensitivity:\"normal\"|\"sensitive\";size:number;targetDisplayName:string;targetHandle:string;wouldCreate:boolean};shareMemoryPreview?:{memoryContentSnippet:string;memoryType:string;projection?:{audienceWarning:string;content:string;expiresAt?:number;memberCount:number;mode:\"project\";roomKind:\"access\"|\"group\"|\"multi_agent\"|\"open\"|\"private\"|\"subthread\"|\"task\";roomLabel:string};protectedApprovalDigest?:string;roomLabel:string;sensitivity:\"normal\"|\"sensitive\";targetDisplayName:string;targetHandle:string;wouldCreate:boolean}}[];type:\"approval.ask\";userId?:string}|{anchorMessageId:number;laneKey:string;lastReplyAt:string;replyCount:number;summaryRevision:number;type:\"thread.summary.changed\"}|{approvalId:string;laneKey?:string;origin?:\"task\";resolution:\"approved\"|\"cancelled\"|\"denied\"|\"expired\";taskId?:string;taskRunId?:string;threadId:string;type:\"approval.resolved\";userId:string;verb?:\"always\"|\"deny\"|\"once\"|\"room\"}|{argsSummary?:string;authorAgentId?:string;laneKey?:string;toolCallId:string;toolName:string;turnId?:string;type:\"tool.start\"}|{artifactId:string;clientMutationId?:string;id:string;path:string;reloadRequired?:boolean;type:\"workspace.artifact.changed\"}|{artifactId:string;id:string;namespaceIds:string[];type:\"workspace.artifact.deleted\"}|{artifactId:string;id:string;newPath:string;oldPath:string;type:\"workspace.artifact.renamed\"}|{artifacts?:{artifactInternalId:string;basename:string;mimeType:string;roomId:string;sizeBytes:number}[];assistantMessageKey?:string;authorAgentId?:string;authorHarnessId?:string;content:string;createdAt?:string;editRevision?:number;laneKey:string;logicalMessageKey?:string;messageId:string;replyToMessageId?:number;role:\"ai\"|\"human\"|\"system\"|\"user\";senderUserId?:string;sourceUserId?:string;type:\"message.new\";workcardContinuation?:{kind:\"advanced_video\";referenceCount:number}}|{assistantMessageKey?:string;authorAgentId?:string;chunkSequence:number;content:string;done:boolean;laneKey:string;tokenUsage?:{inputTokens:number;outputTokens:number;totalTokens:number};turnId?:string;type:\"message.tokens\"}|{at:string;deploymentMode:\"desktop-locked\"|\"desktop-permissive\"|\"server\";networkPolicy:{allow:{cidr:string;ports?:number[];type:\"cidr\"}|{host:string;ports?:number[];type:\"domain\"}|{ports?:number[];suffix:string;type:\"wildcard\"}[];defaultPort?:443;mode:\"proxy-allowlist\"}|{mode:\"host\"}|{mode:\"isolated\"};securityLevel:\"cautious\"|\"paranoid\"|\"permissive\"|\"standard\"|\"yolo\";type:\"policy.changed\"}|{author:{displayName:string;kind:\"agent\"|\"app_tool\"|\"human\"};clientMutationId?:string;patch:{kind:\"anchored_text\";newString:string;oldString:string;replaceAll?:boolean;scope?:{from:number;to:number}};patchId:string;previousRevision:number;previousSha256:string;rebased?:boolean;requestId?:string;revision:number;sha256:string;target:{artifactInternalId:string;kind:\"artifact\";mimeType?:string;path:string;roomId?:string}|{currentFolderRef:string;kind:\"currentFile\";relativePath:string;relayOwnerUserId?:string};type:\"document.patch.applied\"}|{authorAgentId?:string;done:true;laneKey:`room:${string}`;protection:\"protected\";streaming:\"suppressed\";turnId?:string;type:\"message.tokens\";wireVersion:2}|{authorAgentId?:string;droppedBytes?:number;elapsedMs:number;endOffsetBytes:number;kind:\"exec-output\";laneKey?:string;offsetBytes:number;operation:\"exec\";phase:\"running\";sequence:number;stream:\"stderr\"|\"stdout\";text:string;toolCallId:string;turnId?:string;type:\"tool.structured_ssh.progress\";version:1}|{authorAgentId?:string;droppedBytes?:number;elapsedMs:number;endOffsetBytes:number;laneKey?:string;offsetBytes:number;phase:\"running\";sequence:number;stream:\"stderr\"|\"stdout\";text:string;toolCallId:string;turnId?:string;type:\"tool.run_shell.progress\";version:1}|{authorAgentId?:string;duration:number;error?:string;laneKey?:string;result?:string;resultTruncated?:boolean;runShellOutcome?:\"unknown\";status:\"error\"|\"success\";toolCallId:string;toolName:string;turnId?:string;type:\"tool.end\"}|{authorAgentId?:string;elapsedMs:number;kind:\"transfer\";laneKey?:string;operation:\"copy-download\"|\"copy-upload\";phase:\"starting\"|\"transferring\";sequence:number;toolCallId:string;totalBytes?:number;transferredBytes:number;turnId?:string;type:\"tool.structured_ssh.progress\";version:1}|{authorAgentId?:string;errorCategory?:\"auth\"|\"bad_request\"|\"context_exceeded\"|\"provider_unavailable\"|\"rate_limit\"|\"timeout\"|\"unknown\";jobId:string;laneKey?:string;message?:string;status:\"cancelled\"|\"completed\"|\"failed\"|\"queued\"|\"running\"|\"timed_out\";turnId?:string;type:\"job.status\"}|{authorAgentId?:string;laneKey:string;phase:\"post_model\"|\"preparing_tool\"|\"thinking\";turnId:string;type:\"agent.progress\"}|{authorizationPlanBytesBase64url:string;authorizationScheme:\"runtime_foreground_v1\";clientActionSessionId:string;deadlineAt:number;invocationId:string;laneKey:string;recipientPublicKeyBase64url:string;roomId:string;sourceHumanPlanBytesBase64url:string;type:\"message.runtime_invocation_authorization_required\";userId:string;wireVersion:1}|{authorizationPlanBytesBase64url?:string;authorizationScheme?:\"runtime_foreground_v1\";clientActionSessionId:string;deadlineAt:number;executionId:string;laneKey:string;ordinaryPayloadBytesBase64url?:string;planBytesBase64url?:string;recipientPublicKeyBase64url?:string;roomId:string;sourceHumanPlanBytesBase64url?:string;type:\"message.shared_agent_authorization_required\";userId:string;wireVersion:1}|{awaitingFromUserIds:string[];laneKey?:string;ownerId:string;targetRoomId:string;taskId?:string;taskRunId?:string;threadId?:string;type:\"task.awaiting_reply\"}|{botActorId:string;change:\"cleared\"|\"extended\"|\"opened\";laneKey:string;reason:string;roomId:string;source:\"inferred\"|\"mention\"|\"reply\"|\"ui\";type:\"conductor.focus_changed\";userActorId:string}|{cancelRecovery:\"available\"|\"unavailable\";laneKey:string;threadId:string;toolCallId:string;type:\"connected_web.action_resume_failed\";userId:string}|{challengeId:string;expiresAt:string;laneKey:string;mode?:\"enrollPin\"|\"verify\";origin?:\"task\";taskId?:string;taskRunId?:string;threadId:string;type:\"identity.challenge\";userId?:string}|{challengeId?:string;laneKey:string;origin?:\"task\";taskId?:string;taskRunId?:string;threadId:string;tools:{args:{[key:string]:unknown};id?:string;name:string;runShellTimeout?:{reason:string;timeoutSeconds:number};shareArtifactPreview?:{artifactPathSnippet:string;mimeType:string;roomLabel:string;sensitivity:\"normal\"|\"sensitive\";size:number;targetDisplayName:string;targetHandle:string;wouldCreate:boolean};shareMemoryPreview?:{memoryContentSnippet:string;memoryType:string;projection?:{audienceWarning:string;content:string;expiresAt?:number;memberCount:number;mode:\"project\";roomKind:\"access\"|\"group\"|\"multi_agent\"|\"open\"|\"private\"|\"subthread\"|\"task\";roomLabel:string};protectedApprovalDigest?:string;roomLabel:string;sensitivity:\"normal\"|\"sensitive\";targetDisplayName:string;targetHandle:string;wouldCreate:boolean}}[];type:\"prove_it.challenge\";userId?:string}|{choiceId:string;laneKey:string;options:{label:string;selector:string}[];threadId:string;toolCallId:string;toolName:string;type:\"host.choice\";userId?:string}|{chunkIndex:number;data:string;final:boolean;roomId?:string;sentenceIndex:number;type:\"voice.audio\";userId?:string}|{conductorMode:\"advanced\"|\"standard\";laneKey:string;roomId:string;type:\"room.conductor_mode.changed\"}|{content:string;editRevision:number;editedAt:string;laneKey:string;logicalMessageKey:string;type:\"message.updated\"}|{cursor:{sequence:number;snapshotRevision:number;streamId:string};hosts:{connected:boolean;label:string;lastSeenAt:string;readiness:\"compatible_online\"|\"identity_conflict\"|\"incompatible_online\"|\"offline\"|\"stale\"|\"unknown\";remoteHostId:string}[];type:\"remote.host.snapshot\"}|{detail?:string;jobId:string;kind?:\"deep-research\"|\"foreground-context\";laneKey?:string;phase:string;type:\"job.progress\"}|{displayName:string;roomId:string;type:\"typing.ping\";userId:string}|{displayReason:string;humanTurnId?:string;laneKey:string;messageId:string;options?:{botActorId:string;handle:string}[];outcome:\"ask_user\"|\"error\"|\"silent\"|\"wake\";reasonCode:\"ask_ambiguous_direct\"|\"ask_ambiguous_history\"|\"ask_router\"|\"redirect_rejected_duplicate\"|\"redirect_rejected_enqueue_failed\"|\"redirect_rejected_explicitly_selected\"|\"redirect_rejected_ineligible_target\"|\"redirect_rejected_no_target\"|\"redirect_rejected_same_source\"|\"redirect_rejected_visible_output\"|\"redirected\"|\"routing_error\"|\"silent_human_addressed\"|\"silent_no_route\"|\"silent_no_wakeable\"|\"silent_not_addressed\"|\"silent_router\"|\"silent_router_unresolved\"|\"wake_active_focus\"|\"wake_history\"|\"wake_mention\"|\"wake_reply\"|\"wake_router\"|\"wake_ui\"|\"wake_vocative\";roomId:string;selectedHandles?:string[];type:\"conductor.decision\";userActorId:string;userId:string}|{done:boolean;frameBytesBase64url:string;laneKey:string;operationId:string;ordinaryChunk:string;transcriptOrdinal:number;type:\"message.shadow_stream_frame\";wireVersion:1}|{done:boolean;frameBytesBase64url:string;laneKey:string;operationId:string;ordinaryChunk:string;transcriptOrdinal:number;type:\"message.shared_agent_stream_frame\";wireVersion:1}|{done:boolean;frameBytesBase64url:string;laneKey:string;operationId:string;transcriptOrdinal:number;type:\"message.shadow_stream_frame\";wireVersion:2}|{done:boolean;frameBytesBase64url:string;laneKey:string;operationId:string;transcriptOrdinal:number;type:\"message.shared_agent_stream_frame\";wireVersion:2}|{droppedCount:number;errorCode:string;sessionId:string;threadId:string;type:\"session.persistence_failed\"}|{durableEventDigestBase64url:string;laneKey:string;logicalMessageKey:string;operationId:string;ordinaryPayloadBytesBase64url:string;planBytesBase64url:string;policyRevision:number;protectedMessage:{dtoVersion:2;projection:{authorAgentId?:string;createdAt:string;deliveredAt?:string;editRevision:number;editedAt?:string;lastReplyAt?:string;logicalMessageKey?:string;messageId:string;namespaceId:string;readAt?:string;replyCount?:number;replyToMessageId?:string;role:\"assistant\"|\"system\"|\"tool\"|\"user\";roomId:string;sessionId:string;sourceUserId?:string;subthreadRoomId?:string;summaryRevision?:number};protectedPayload?:{accessManifestBytesBase64url:string;cryptoObjectId:string;encryptedPayloadBytesBase64url:string;keyClass:\"ai\"|\"human\";namespaceEnvelopeBytesBase64url:string;payloadVersion:2;status:\"encrypted\"}|{cryptoObjectId?:string;reason:\"corrupt\"|\"lost_key_material\"|\"missing_grant\"|\"removed\"|\"stale_grant\"|\"unauthorized\"|\"unsupported_version\";status:\"unavailable\"}|{reason:\"backfill_pending\"|\"shadow_pending\";status:\"pending\"}};protectedMessageDigestBase64url:string;requestBytesBase64url:string;senderDeviceSigningPublicKeyBase64url:string;transcriptOrdinal:number;type:\"message.human_peer_shadow\";wireVersion:1}|{durableEventDigestBase64url:string;laneKey:string;logicalMessageKey:string;operationId:string;ordinaryPayloadBytesBase64url:string;planBytesBase64url:string;policyRevision:number;protectedMessage:{dtoVersion:2;projection:{authorAgentId?:string;createdAt:string;deliveredAt?:string;editRevision:number;editedAt?:string;lastReplyAt?:string;logicalMessageKey?:string;messageId:string;namespaceId:string;readAt?:string;replyCount?:number;replyToMessageId?:string;role:\"assistant\"|\"system\"|\"tool\"|\"user\";roomId:string;sessionId:string;sourceUserId?:string;subthreadRoomId?:string;summaryRevision?:number};protectedPayload?:{accessManifestBytesBase64url:string;cryptoObjectId:string;encryptedPayloadBytesBase64url:string;keyClass:\"ai\"|\"human\";namespaceEnvelopeBytesBase64url:string;payloadVersion:2;status:\"encrypted\"}|{cryptoObjectId?:string;reason:\"corrupt\"|\"lost_key_material\"|\"missing_grant\"|\"removed\"|\"stale_grant\"|\"unauthorized\"|\"unsupported_version\";status:\"unavailable\"}|{reason:\"backfill_pending\"|\"shadow_pending\";status:\"pending\"}};protectedMessageDigestBase64url:string;requestBytesBase64url:string;senderDeviceSigningPublicKeyBase64url:string;transcriptOrdinal:number;type:\"message.shared_agent_shadow\";wireVersion:1}|{durableEventDigestBase64url:string;laneKey:string;logicalMessageKey:string;operationId:string;planBytesBase64url:string;policyRevision:number;protectedMessage:{dtoVersion:2;projection:{authorAgentId?:string;createdAt:string;deliveredAt?:string;editRevision:number;editedAt?:string;lastReplyAt?:string;logicalMessageKey?:string;messageId:string;namespaceId:string;readAt?:string;replyCount?:number;replyToMessageId?:string;role:\"assistant\"|\"system\"|\"tool\"|\"user\";roomId:string;sessionId:string;sourceUserId?:string;subthreadRoomId?:string;summaryRevision?:number};protectedPayload?:{accessManifestBytesBase64url:string;cryptoObjectId:string;encryptedPayloadBytesBase64url:string;keyClass:\"ai\"|\"human\";namespaceEnvelopeBytesBase64url:string;payloadVersion:2;status:\"encrypted\"}|{cryptoObjectId?:string;reason:\"corrupt\"|\"lost_key_material\"|\"missing_grant\"|\"removed\"|\"stale_grant\"|\"unauthorized\"|\"unsupported_version\";status:\"unavailable\"}|{reason:\"backfill_pending\"|\"shadow_pending\";status:\"pending\"}};protectedMessageDigestBase64url:string;requestBytesBase64url:string;senderDeviceSigningPublicKeyBase64url:string;transcriptOrdinal:number;type:\"message.human_peer_shadow\";wireVersion:2}|{durableEventDigestBase64url:string;laneKey:string;logicalMessageKey:string;operationId:string;planBytesBase64url:string;policyRevision:number;protectedMessage:{dtoVersion:2;projection:{authorAgentId?:string;createdAt:string;deliveredAt?:string;editRevision:number;editedAt?:string;lastReplyAt?:string;logicalMessageKey?:string;messageId:string;namespaceId:string;readAt?:string;replyCount?:number;replyToMessageId?:string;role:\"assistant\"|\"system\"|\"tool\"|\"user\";roomId:string;sessionId:string;sourceUserId?:string;subthreadRoomId?:string;summaryRevision?:number};protectedPayload?:{accessManifestBytesBase64url:string;cryptoObjectId:string;encryptedPayloadBytesBase64url:string;keyClass:\"ai\"|\"human\";namespaceEnvelopeBytesBase64url:string;payloadVersion:2;status:\"encrypted\"}|{cryptoObjectId?:string;reason:\"corrupt\"|\"lost_key_material\"|\"missing_grant\"|\"removed\"|\"stale_grant\"|\"unauthorized\"|\"unsupported_version\";status:\"unavailable\"}|{reason:\"backfill_pending\"|\"shadow_pending\";status:\"pending\"}};protectedMessageDigestBase64url:string;requestBytesBase64url:string;senderDeviceSigningPublicKeyBase64url:string;transcriptOrdinal:number;type:\"message.shared_agent_shadow\";wireVersion:2}|{durableEventDigestBase64url:string;laneKey:string;operationId:string;ordinaryPayloadBytesBase64url:string;planBytesBase64url:string;policyRevision:number;protectedMessage:{dtoVersion:2;projection:{authorAgentId?:string;createdAt:string;deliveredAt?:string;editRevision:number;editedAt?:string;lastReplyAt?:string;logicalMessageKey?:string;messageId:string;namespaceId:string;readAt?:string;replyCount?:number;replyToMessageId?:string;role:\"assistant\"|\"system\"|\"tool\"|\"user\";roomId:string;sessionId:string;sourceUserId?:string;subthreadRoomId?:string;summaryRevision?:number};protectedPayload?:{accessManifestBytesBase64url:string;cryptoObjectId:string;encryptedPayloadBytesBase64url:string;keyClass:\"ai\"|\"human\";namespaceEnvelopeBytesBase64url:string;payloadVersion:2;status:\"encrypted\"}|{cryptoObjectId?:string;reason:\"corrupt\"|\"lost_key_material\"|\"missing_grant\"|\"removed\"|\"stale_grant\"|\"unauthorized\"|\"unsupported_version\";status:\"unavailable\"}|{reason:\"backfill_pending\"|\"shadow_pending\";status:\"pending\"}};transcriptOrdinal:number;type:\"message.shared_agent_output_shadow\";wireVersion:1}|{durableEventDigestBase64url:string;laneKey:string;operationId:string;ordinaryPayloadBytesBase64url:string;policyRevision:number;protectedMessage:{dtoVersion:2;projection:{authorAgentId?:string;createdAt:string;deliveredAt?:string;editRevision:number;editedAt?:string;lastReplyAt?:string;logicalMessageKey?:string;messageId:string;namespaceId:string;readAt?:string;replyCount?:number;replyToMessageId?:string;role:\"assistant\"|\"system\"|\"tool\"|\"user\";roomId:string;sessionId:string;sourceUserId?:string;subthreadRoomId?:string;summaryRevision?:number};protectedPayload?:{accessManifestBytesBase64url:string;cryptoObjectId:string;encryptedPayloadBytesBase64url:string;keyClass:\"ai\"|\"human\";namespaceEnvelopeBytesBase64url:string;payloadVersion:2;status:\"encrypted\"}|{cryptoObjectId?:string;reason:\"corrupt\"|\"lost_key_material\"|\"missing_grant\"|\"removed\"|\"stale_grant\"|\"unauthorized\"|\"unsupported_version\";status:\"unavailable\"}|{reason:\"backfill_pending\"|\"shadow_pending\";status:\"pending\"}};transcriptOrdinal:number;type:\"message.shadow_durable\";wireVersion:1}|{durableEventDigestBase64url:string;laneKey:string;operationId:string;planBytesBase64url:string;policyRevision:number;protectedMessage:{dtoVersion:2;projection:{authorAgentId?:string;createdAt:string;deliveredAt?:string;editRevision:number;editedAt?:string;lastReplyAt?:string;logicalMessageKey?:string;messageId:string;namespaceId:string;readAt?:string;replyCount?:number;replyToMessageId?:string;role:\"assistant\"|\"system\"|\"tool\"|\"user\";roomId:string;sessionId:string;sourceUserId?:string;subthreadRoomId?:string;summaryRevision?:number};protectedPayload?:{accessManifestBytesBase64url:string;cryptoObjectId:string;encryptedPayloadBytesBase64url:string;keyClass:\"ai\"|\"human\";namespaceEnvelopeBytesBase64url:string;payloadVersion:2;status:\"encrypted\"}|{cryptoObjectId?:string;reason:\"corrupt\"|\"lost_key_material\"|\"missing_grant\"|\"removed\"|\"stale_grant\"|\"unauthorized\"|\"unsupported_version\";status:\"unavailable\"}|{reason:\"backfill_pending\"|\"shadow_pending\";status:\"pending\"}};transcriptOrdinal:number;type:\"message.shared_agent_output_shadow\";wireVersion:2}|{durableEventDigestBase64url:string;laneKey:string;operationId:string;policyRevision:number;protectedMessage:{dtoVersion:2;projection:{authorAgentId?:string;createdAt:string;deliveredAt?:string;editRevision:number;editedAt?:string;lastReplyAt?:string;logicalMessageKey?:string;messageId:string;namespaceId:string;readAt?:string;replyCount?:number;replyToMessageId?:string;role:\"assistant\"|\"system\"|\"tool\"|\"user\";roomId:string;sessionId:string;sourceUserId?:string;subthreadRoomId?:string;summaryRevision?:number};protectedPayload?:{accessManifestBytesBase64url:string;cryptoObjectId:string;encryptedPayloadBytesBase64url:string;keyClass:\"ai\"|\"human\";namespaceEnvelopeBytesBase64url:string;payloadVersion:2;status:\"encrypted\"}|{cryptoObjectId?:string;reason:\"corrupt\"|\"lost_key_material\"|\"missing_grant\"|\"removed\"|\"stale_grant\"|\"unauthorized\"|\"unsupported_version\";status:\"unavailable\"}|{reason:\"backfill_pending\"|\"shadow_pending\";status:\"pending\"}};transcriptOrdinal:number;type:\"message.shadow_durable\";wireVersion:2}|{editRevision:number;laneKey:`room:${string}`;logicalMessageKey:string;message:{dtoVersion:2;projection:{authorAgentId?:string;createdAt:string;deliveredAt?:string;editRevision:number;editedAt?:string;lastReplyAt?:string;logicalMessageKey?:string;messageId:string;namespaceId:string;readAt?:string;replyCount?:number;replyToMessageId?:string;role:\"assistant\"|\"system\"|\"tool\"|\"user\";roomId:string;sessionId:string;sourceUserId?:string;subthreadRoomId?:string;summaryRevision?:number};protectedPayload?:{accessManifestBytesBase64url:string;cryptoObjectId:string;encryptedPayloadBytesBase64url:string;keyClass:\"ai\"|\"human\";namespaceEnvelopeBytesBase64url:string;payloadVersion:2;status:\"encrypted\"}|{cryptoObjectId?:string;reason:\"corrupt\"|\"lost_key_material\"|\"missing_grant\"|\"removed\"|\"stale_grant\"|\"unauthorized\"|\"unsupported_version\";status:\"unavailable\"}|{reason:\"backfill_pending\"|\"shadow_pending\";status:\"pending\"}};protection:\"protected\";type:\"message.updated\";wireVersion:2}|{event:{actorId:string;actorKind:\"agent\"|\"user\";displayName:string;kind:\"member_added\"|\"member_removed\"};recipientSyncNamespaceId?:string;roomId:string;type:\"room_members_changed\"}|{eventId:string;host:{connected:boolean;label:string;lastSeenAt:string;readiness:\"compatible_online\"|\"identity_conflict\"|\"incompatible_online\"|\"offline\"|\"stale\"|\"unknown\";remoteHostId:string};remoteHostId:string;sequence:number;snapshotRevision:number;streamId:string;type:\"remote.host.connected\"}|{eventId:string;host:{connected:boolean;label:string;lastSeenAt:string;readiness:\"compatible_online\"|\"identity_conflict\"|\"incompatible_online\"|\"offline\"|\"stale\"|\"unknown\";remoteHostId:string};remoteHostId:string;sequence:number;snapshotRevision:number;streamId:string;type:\"remote.host.updated\"}|{eventId:string;remoteHostId:string;sequence:number;snapshotRevision:number;streamId:string;terminalReason:\"identity_conflict\"|\"offline\";type:\"remote.host.disconnected\"}|{eventId:string;remoteHostId:string;sequence:number;snapshotRevision:number;streamId:string;terminalReason:\"revoked\";type:\"remote.host.revoked\"}|{expiresAt?:string;jobId:string;ownerId:string;request?:{autoResolutionMs?:number;kind:\"user_input_required\";questions:{allowOther:boolean;header:string;id:string;multiSelect?:boolean;options?:{description?:string;id:string;label:string}[];prompt:string;secret:boolean}[]}|{command:{actionKinds:\"list_files\"|\"read\"|\"search\"|\"unknown\"[];detail:\"host_local_only\"|\"not_provided\"};kind:\"command_approval_required\";options:\"approve\"|\"approve_for_session\"|\"cancel\"|\"deny\"[];reason:\"host_local_only\"|\"not_provided\"}|{detail?:{reason:\"frame_limit\"|\"incompatible\"|\"invalid\"|\"sensitive\"|\"unsupported\";state:\"withheld\"}|{state:\"shown\";text:string};kind:\"permission_selection_required\";options:{id:string;label:string;semanticHint?:string}[];tool:{kind?:string;title?:string}}|{grantRoot:\"host_local_only\"|\"not_provided\";kind:\"file_change_approval_required\";options:\"approve\"|\"approve_for_session\"|\"cancel\"|\"deny\"[];reason:\"host_local_only\"|\"not_provided\"}|{kind:\"network_approval_required\";network:{host:string;protocol:\"http\"|\"https\"|\"socks5Tcp\"|\"socks5Udp\"};options:\"approve\"|\"approve_for_session\"|\"cancel\"|\"deny\"[];reason:\"host_local_only\"|\"not_provided\"}|{kind:\"permissions_approval_required\";permissions:{fileSystem?:{entryCount:number;pathDetail:\"host_local_only\"|\"not_provided\";readPathCount:number;writePathCount:number};network?:{enabled?:boolean}};reason:\"host_local_only\"|\"not_provided\"};requestId:string;roomId:string;taskId:string;type:\"codex.request\"}|{forkThreadId:string;jobId:string;laneKey:string;parentJobId?:string;parentThreadId:string;sequence:number;syntheticNoteCount:number;type:\"job.forked\";virtualJobIds:string[]}|{forkThreadId:string;jobId:string;laneKey:string;parentThreadId:string;sequence:number;splicedMessageCount:number;type:\"fork.spliced\"}|{from:string;laneKey:string;reason:\"auth\"|\"bad_request\"|\"context_exceeded\"|\"provider_unavailable\"|\"rate_limit\"|\"timeout\"|\"unknown\";to:string;turnId:string;type:\"model.fallback\"}|{hardExpiresAt:string;leaseExpiresAt:string;operationId:string;state:\"applying\"|\"draining\"|\"normal\";type:\"maintenance.status\"}|{humanTurnId?:string;laneKey:string;messageId:string;options:{botActorId:string;handle:string}[];reason:string;roomId:string;type:\"conductor.ask_user\";userActorId:string;userId:string}|{intervention:{account:{id:string;label:string;origin:string;service:string};kind:\"authentication_required\";mode:\"reconnect\";reason:\"captcha\"|\"mfa\"|\"reconnect\"|\"sign_in\"}|{kind:\"authentication_required\";mode:\"connect\";reason:\"not_connected\";target:{selector:string}};laneKey:string;threadId:string;toolCallId:string;type:\"connected_web.action_attention\";userId:string}|{jobId:string;laneKey:string;type:\"job.dispatched\";virtualJobIds:string[]}|{jobId:string;result:\"failed\"|\"success\"|\"timed_out\";type:\"worker.complete\"}|{keyClass:\"ai\"|\"human\";laneKey:string;namespaceId:string;roomId:string;type:\"crypto.domain_key_catch_up_delivered\"|\"crypto.domain_key_catch_up_requested\"}|{laneKey:`room:${string}`;message:{dtoVersion:2;projection:{authorAgentId?:string;createdAt:string;deliveredAt?:string;editRevision:number;editedAt?:string;lastReplyAt?:string;logicalMessageKey?:string;messageId:string;namespaceId:string;readAt?:string;replyCount?:number;replyToMessageId?:string;role:\"assistant\"|\"system\"|\"tool\"|\"user\";roomId:string;sessionId:string;sourceUserId?:string;subthreadRoomId?:string;summaryRevision?:number};protectedPayload?:{accessManifestBytesBase64url:string;cryptoObjectId:string;encryptedPayloadBytesBase64url:string;keyClass:\"ai\"|\"human\";namespaceEnvelopeBytesBase64url:string;payloadVersion:2;status:\"encrypted\"}|{cryptoObjectId?:string;reason:\"corrupt\"|\"lost_key_material\"|\"missing_grant\"|\"removed\"|\"stale_grant\"|\"unauthorized\"|\"unsupported_version\";status:\"unavailable\"}|{reason:\"backfill_pending\"|\"shadow_pending\";status:\"pending\"}};protection:\"protected\";type:\"message.new\";wireVersion:2}|{laneKey:string;messageId:number;type:\"message.deleted\"}|{laneKey:string;operationId:string;planBytesBase64url:string;streamStartBytesBase64url:string;transcriptOrdinal:number;type:\"message.shared_agent_stream_start\";wireVersion:1}|{laneKey:string;operationId:string;planBytesBase64url:string;streamStartBytesBase64url:string;transcriptOrdinal:number;type:\"message.shared_agent_stream_start\";wireVersion:2}|{laneKey:string;operationId:string;streamStartBytesBase64url:string;transcriptOrdinal:number;type:\"message.shadow_stream_start\";wireVersion:1}|{laneKey:string;operationId:string;streamStartBytesBase64url:string;transcriptOrdinal:number;type:\"message.shadow_stream_start\";wireVersion:2}|{laneKey:string;ownerId:string;taskId:string;taskRunId:string;type:\"task.fired\"}|{laneKey:string;roomId:string;silence:{botActorId:string;botDisplayName:string;expiresAt:string;id:string;kind:\"deaf\"|\"mute\";setByDisplayName:string};type:\"room.silence.changed\"}|{laneKey:string;roomId:string;state:\"deciding\"|\"settled\";type:\"conductor.routing\";userActorId:string}|{laneKey:string;type:\"job.coalesced\";virtualJobId:string}|{messageId:string;occurredAt:string;parentRoomLabel?:string;roomId:string;roomLabel:string;senderActorId:string;senderDisplayName:string;topLevelRoomId:string;type:\"notification.message.important\";userId:string}|{name:string;onboardingCompleted:boolean;profileId:string;type:\"profile.updated\";userId?:string}|{ownerId:string;requestId:string;type:\"codex.request.resolved\"}|{ownerId:string;status:string;taskId:string;taskRunId:string;type:\"task.completed\"}|{ownerId:string;status:string;taskId:string;taskRunId:string;type:\"task.errored\"}|{ownerId:string;status:string;taskId:string;type:\"task.status\"}|{policyRevision:number;type:\"encryption.policy.changed\"}|{roomId:string;roomOwnImportantUnreadCount:number;roomOwnUnreadCount:number;topLevelImportantUnreadCount:number;topLevelRoomId:string;topLevelUnreadCount:number;type:\"room.notification.changed\";userId:string}|{speaking:boolean;type:\"voice.status\";voice:\"off\"|\"on\"}|{type:\"crypto.background_authorization_requested\"}|{type:\"event_feed.changed\"}|{type:\"room.catalog.changed\"}|{type:\"voice.stop\"}[]",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": [
      {
        "path": "response.body[].activity.args",
        "schema": "TaskAttentionToolArgumentsV1"
      },
      {
        "path": "response.body[].tools[].args",
        "schema": "TaskAttentionToolArgumentsV1"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.get.api.workspace.artifacts.14geo7n",
    "locator": "http:request_response:GET /api/workspace/artifacts",
    "structuralSignatures": [
      "request.query:{cursor?:string;limit?:string;pagination?:string;pathPrefix?:string}",
      "response.body:{code:string;error:string}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.admin.server.models.1nyrg5s",
    "locator": "http:request_response:POST /api/admin/server-models",
    "structuralSignatures": [
      "response.body:{conductorModel:string;defaultChatModel:string;effectiveEmbeddingModel:string;effectiveImageModel:string;effectiveMusicModel:string;effectiveVideoModel:string;embeddingModel:string;embeddingModels:{available:boolean;displayName:string;id:string}[];embeddingSelectionPending:boolean;fallbackChain:string[];imageModel:string;imageModels:{available:boolean;displayName:string;id:string;provider:string;unavailableReason?:string}[];memoryReviewModel:string;musicModel:string;musicModels:{available:boolean;displayName:string;id:string;provider:string;unavailableReason?:string}[];reasoningOutput:{[key:string]:boolean};reasoningPolicy:{defaultEffort:\"high\"|\"low\"|\"max\"|\"medium\"|\"minimal\"|\"off\"|\"xhigh\";overrides:{[key:string]:\"high\"|\"low\"|\"max\"|\"medium\"|\"minimal\"|\"off\"|\"xhigh\"}};reflectionModel:string;stenographerModel:string;videoModel:string;videoModels:{available:boolean;displayName:string;id:string;provider:string;unavailableReason?:string}[]}",
      "response.body:{error:any}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": [
      {
        "path": "response.body.error",
        "debtId": "debt.wire.arbitrary.zogb98"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.post.api.apps.appid.disable.138gxqe",
    "locator": "http:request_response:POST /api/apps/:appId/disable",
    "structuralSignatures": [
      "request.params:{appId:string}",
      "response.body:{agentToolsDeclared:boolean;canEditSource:boolean;contentAssociations:{id:string;kind:\"html-script-json\";match:{[key:string]:false|number|string|true};scriptId:string;scriptType:string}[];conversions:{export?:{id:string;label:string;prepareInApp?:boolean;selectWorkspaceDestination?:boolean;targetSurfaces:\"currentFolder\"|\"workspace\"[];to:{extension:string;mimeType:string};tool:string}[];import?:{from:{extensions?:string[];mimeTypes?:string[]};id:string;label:string;openAfterImport?:boolean;sourceSurfaces:\"currentFolder\"|\"workspace\"[];target:{extension:string;surface:\"currentFolder\"|\"workspace\"};tool:string}[]};createActions:{defaultFilename:string;id:string;label:string;mimeType:string;openAfterCreate?:boolean;targetSurfaces:\"currentFolder\"|\"workspace\"[];template:{kind:\"file\";path:string}}[];description:string;display:{appOrder?:number;defaultCollapsed?:boolean;groupId?:string;groupName?:string;groupOrder?:number};enabled:boolean;fileAssociations:{extensions?:string[];mimeTypes?:string[]};id:string;installedAt:string;name:string;sourceHash:string;status:\"invalid_manifest\"|\"needs_dependencies\"|\"ready\";version:string}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.apps.appid.enable.dlo6od",
    "locator": "http:request_response:POST /api/apps/:appId/enable",
    "structuralSignatures": [
      "request.params:{appId:string}",
      "response.body:{agentToolsDeclared:boolean;canEditSource:boolean;contentAssociations:{id:string;kind:\"html-script-json\";match:{[key:string]:false|number|string|true};scriptId:string;scriptType:string}[];conversions:{export?:{id:string;label:string;prepareInApp?:boolean;selectWorkspaceDestination?:boolean;targetSurfaces:\"currentFolder\"|\"workspace\"[];to:{extension:string;mimeType:string};tool:string}[];import?:{from:{extensions?:string[];mimeTypes?:string[]};id:string;label:string;openAfterImport?:boolean;sourceSurfaces:\"currentFolder\"|\"workspace\"[];target:{extension:string;surface:\"currentFolder\"|\"workspace\"};tool:string}[]};createActions:{defaultFilename:string;id:string;label:string;mimeType:string;openAfterCreate?:boolean;targetSurfaces:\"currentFolder\"|\"workspace\"[];template:{kind:\"file\";path:string}}[];description:string;display:{appOrder?:number;defaultCollapsed?:boolean;groupId?:string;groupName?:string;groupOrder?:number};enabled:boolean;fileAssociations:{extensions?:string[];mimeTypes?:string[]};id:string;installedAt:string;name:string;sourceHash:string;status:\"invalid_manifest\"|\"needs_dependencies\"|\"ready\";version:string}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.message.backfill.source.4ie5xo",
    "locator": "http:request_response:POST /api/message-backfill/source",
    "structuralSignatures": [
      "response.body:{claim:{action:\"encrypt\"|\"restore\"|\"verify\";authorHumanTurnId?:string;claimId:string;coordinate:{logicalMessageKey:string;messageId:number;namespaceId:string;revision:number;role:\"assistant\"|\"system\"|\"tool\"|\"user\";roomId:string;sessionId:string};createdAt:number;cryptoObjectId:string;deviceGeneration:number;deviceId:string;domainAuthorizationRevision:number;domainGeneration:number;domainHeadDigestBase64url:string;domainId:string;expiresAt:number;hostAuthorizationRevision:number;issuedAt:number;keyClass:\"ai\"|\"human\";lineageGeneration:number;membershipEpoch:number;membershipHeadDigestBase64url:string;membershipSecurityRevision:number;namespaceAccessRevision:number;namespaceBundleDigestBase64url:string;namespaceBundleRevision:number;namespaceHeadDigestBase64url:string;namespaceKeyGeneration:number;operationId:string;policyRevision:number;repairIdentityDigestBase64url:string;serverInstanceId:string;sessionAgentId?:string;sourceRevision?:number;subjectHumanId:string;version:1};history?:{acknowledgement?:{expiresAt:string;issuedAt:string;status:\"required\";tokenBase64url:string}|{status:\"already_recorded\"};authorities?:{domainAuthorizationRevision:number;domainHeadDigestBase64url:string;domainId:string;domainKeyGeneration:number;hostAuthorizationRevision:number;keyClass:\"ai\"|\"human\";namespaceAccessRevision:number;namespaceBundleDigestBase64url:string;namespaceBundleRevision:number;namespaceCurrentGeneration:number;namespaceHeadDigestBase64url:string;namespaceId:string;policyRevision:number;readerDeviceId:string;readerDeviceSigningKeyGeneration:number;roomId:string;scheme:\"domain_key_v2\";subjectHumanId:string}[];authority:{domainAuthorizationRevision:number;domainHeadDigestBase64url:string;domainId:string;domainKeyGeneration:number;hostAuthorizationRevision:number;keyClass:\"ai\"|\"human\";namespaceAccessRevision:number;namespaceBundleDigestBase64url:string;namespaceBundleRevision:number;namespaceCurrentGeneration:number;namespaceHeadDigestBase64url:string;namespaceId:string;policyRevision:number;readerDeviceId:string;readerDeviceSigningKeyGeneration:number;roomId:string;scheme:\"domain_key_v2\";subjectHumanId:string};clientRequestKey:string;eligibleCount:number;operationId:string;records:{authorHumanId:string;committerDeviceSigningPublicKeyBase64url:string;coordinate:{editRevision:number;logicalMessageKey:string;messageId:number;role:\"assistant\"|\"system\"|\"tool\"|\"user\";sessionId:string};kind:\"human_edited_representation\";ordinaryPayloadBytesBase64url:string;protectedMessage:{dtoVersion:2;projection:{authorAgentId?:string;createdAt:string;deliveredAt?:string;editRevision:number;editedAt?:string;lastReplyAt?:string;logicalMessageKey?:string;messageId:string;namespaceId:string;readAt?:string;replyCount?:number;replyToMessageId?:string;role:\"assistant\"|\"system\"|\"tool\"|\"user\";roomId:string;sessionId:string;sourceUserId?:string;subthreadRoomId?:string;summaryRevision?:number};protectedPayload?:{accessManifestBytesBase64url:string;cryptoObjectId:string;encryptedPayloadBytesBase64url:string;keyClass:\"ai\"|\"human\";namespaceEnvelopeBytesBase64url:string;payloadVersion:2;status:\"encrypted\"}|{cryptoObjectId?:string;reason:\"corrupt\"|\"lost_key_material\"|\"missing_grant\"|\"removed\"|\"stale_grant\"|\"unauthorized\"|\"unsupported_version\";status:\"unavailable\"}|{reason:\"backfill_pending\"|\"shadow_pending\";status:\"pending\"}};representationMode:\"ordinary-and-protected\";retainedGeneration:{accessRevision:number;audienceFingerprintBase64url:string;headDigestBase64url:string;namespaceGeneration:number;publicationDigestBase64url:string;publicationSetDigestBase64url:string}}|{authorHumanId:string;committerDeviceSigningPublicKeyBase64url:string;coordinate:{editRevision:number;logicalMessageKey:string;messageId:number;role:\"assistant\"|\"system\"|\"tool\"|\"user\";sessionId:string};kind:\"human_edited_representation\";protectedMessage:{dtoVersion:2;projection:{authorAgentId?:string;createdAt:string;deliveredAt?:string;editRevision:number;editedAt?:string;lastReplyAt?:string;logicalMessageKey?:string;messageId:string;namespaceId:string;readAt?:string;replyCount?:number;replyToMessageId?:string;role:\"assistant\"|\"system\"|\"tool\"|\"user\";roomId:string;sessionId:string;sourceUserId?:string;subthreadRoomId?:string;summaryRevision?:number};protectedPayload?:{accessManifestBytesBase64url:string;cryptoObjectId:string;encryptedPayloadBytesBase64url:string;keyClass:\"ai\"|\"human\";namespaceEnvelopeBytesBase64url:string;payloadVersion:2;status:\"encrypted\"}|{cryptoObjectId?:string;reason:\"corrupt\"|\"lost_key_material\"|\"missing_grant\"|\"removed\"|\"stale_grant\"|\"unauthorized\"|\"unsupported_version\";status:\"unavailable\"}|{reason:\"backfill_pending\"|\"shadow_pending\";status:\"pending\"}};representationMode:\"protected-only\";retainedGeneration:{accessRevision:number;audienceFingerprintBase64url:string;headDigestBase64url:string;namespaceGeneration:number;publicationDigestBase64url:string;publicationSetDigestBase64url:string};selectedSource:{authorAgentId?:string;logicalMessageKey?:string;role:\"assistant\"|\"system\"|\"tool\"|\"user\";sourceUserId?:string}}|{coordinate:{editRevision:number;logicalMessageKey:string;messageId:number;role:\"assistant\"|\"system\"|\"tool\"|\"user\";sessionId:string};kind:\"existing_representation\";ordinaryPayloadBytesBase64url?:string;protectedMessage:{dtoVersion:2;projection:{authorAgentId?:string;createdAt:string;deliveredAt?:string;editRevision:number;editedAt?:string;lastReplyAt?:string;logicalMessageKey?:string;messageId:string;namespaceId:string;readAt?:string;replyCount?:number;replyToMessageId?:string;role:\"assistant\"|\"system\"|\"tool\"|\"user\";roomId:string;sessionId:string;sourceUserId?:string;subthreadRoomId?:string;summaryRevision?:number};protectedPayload?:{accessManifestBytesBase64url:string;cryptoObjectId:string;encryptedPayloadBytesBase64url:string;keyClass:\"ai\"|\"human\";namespaceEnvelopeBytesBase64url:string;payloadVersion:2;status:\"encrypted\"}|{cryptoObjectId?:string;reason:\"corrupt\"|\"lost_key_material\"|\"missing_grant\"|\"removed\"|\"stale_grant\"|\"unauthorized\"|\"unsupported_version\";status:\"unavailable\"}|{reason:\"backfill_pending\"|\"shadow_pending\";status:\"pending\"}};repair:{allocationDigestBase64url:string;attestationDigestBase64url:string;identityDigestBase64url:string;publisherHumanId:string;publisherKind:\"human_device\";publisherSignerKeyId:string;publisherSigningPublicKeyBase64url:string};retainedGeneration:{accessRevision:number;audienceFingerprintBase64url:string;headDigestBase64url:string;namespaceGeneration:number;publicationDigestBase64url:string;publicationSetDigestBase64url:string}}|{coordinate:{editRevision:number;logicalMessageKey:string;messageId:number;role:\"assistant\"|\"system\"|\"tool\"|\"user\";sessionId:string};kind:\"existing_representation\";ordinaryPayloadBytesBase64url?:string;protectedMessage:{dtoVersion:2;projection:{authorAgentId?:string;createdAt:string;deliveredAt?:string;editRevision:number;editedAt?:string;lastReplyAt?:string;logicalMessageKey?:string;messageId:string;namespaceId:string;readAt?:string;replyCount?:number;replyToMessageId?:string;role:\"assistant\"|\"system\"|\"tool\"|\"user\";roomId:string;sessionId:string;sourceUserId?:string;subthreadRoomId?:string;summaryRevision?:number};protectedPayload?:{accessManifestBytesBase64url:string;cryptoObjectId:string;encryptedPayloadBytesBase64url:string;keyClass:\"ai\"|\"human\";namespaceEnvelopeBytesBase64url:string;payloadVersion:2;status:\"encrypted\"}|{cryptoObjectId?:string;reason:\"corrupt\"|\"lost_key_material\"|\"missing_grant\"|\"removed\"|\"stale_grant\"|\"unauthorized\"|\"unsupported_version\";status:\"unavailable\"}|{reason:\"backfill_pending\"|\"shadow_pending\";status:\"pending\"}};repair:{allocationDigestBase64url:string;attestationDigestBase64url:string;identityDigestBase64url:string;publisherKind?:\"foreground_runtime\";publisherSignerKeyId:string;publisherSigningPublicKeyBase64url:string};retainedGeneration?:{accessRevision:number;audienceFingerprintBase64url:string;headDigestBase64url:string;namespaceGeneration:number;publicationDigestBase64url:string;publicationSetDigestBase64url:string}}|{coordinate:{editRevision:number;logicalMessageKey:string;messageId:number;role:\"assistant\"|\"system\"|\"tool\"|\"user\";sessionId:string};kind:\"existing_representation\";protectedMessage:{dtoVersion:2;projection:{authorAgentId?:string;createdAt:string;deliveredAt?:string;editRevision:number;editedAt?:string;lastReplyAt?:string;logicalMessageKey?:string;messageId:string;namespaceId:string;readAt?:string;replyCount?:number;replyToMessageId?:string;role:\"assistant\"|\"system\"|\"tool\"|\"user\";roomId:string;sessionId:string;sourceUserId?:string;subthreadRoomId?:string;summaryRevision?:number};protectedPayload?:{accessManifestBytesBase64url:string;cryptoObjectId:string;encryptedPayloadBytesBase64url:string;keyClass:\"ai\"|\"human\";namespaceEnvelopeBytesBase64url:string;payloadVersion:2;status:\"encrypted\"}|{cryptoObjectId?:string;reason:\"corrupt\"|\"lost_key_material\"|\"missing_grant\"|\"removed\"|\"stale_grant\"|\"unauthorized\"|\"unsupported_version\";status:\"unavailable\"}|{reason:\"backfill_pending\"|\"shadow_pending\";status:\"pending\"}};repair:{allocationDigestBase64url:string;attestationDigestBase64url:string;identityDigestBase64url:string;publisherHumanId:string;publisherKind:\"human_device\";publisherSignerKeyId:string;publisherSigningPublicKeyBase64url:string};representationMode:\"protected-only\";retainedGeneration:{accessRevision:number;audienceFingerprintBase64url:string;headDigestBase64url:string;namespaceGeneration:number;publicationDigestBase64url:string;publicationSetDigestBase64url:string};selectedSource:{authorAgentId?:string;logicalMessageKey?:string;role:\"assistant\"|\"system\"|\"tool\"|\"user\";sourceUserId?:string}}|{coordinate:{editRevision:number;logicalMessageKey:string;messageId:number;role:\"assistant\"|\"system\"|\"tool\"|\"user\";sessionId:string};kind:\"existing_representation\";protectedMessage:{dtoVersion:2;projection:{authorAgentId?:string;createdAt:string;deliveredAt?:string;editRevision:number;editedAt?:string;lastReplyAt?:string;logicalMessageKey?:string;messageId:string;namespaceId:string;readAt?:string;replyCount?:number;replyToMessageId?:string;role:\"assistant\"|\"system\"|\"tool\"|\"user\";roomId:string;sessionId:string;sourceUserId?:string;subthreadRoomId?:string;summaryRevision?:number};protectedPayload?:{accessManifestBytesBase64url:string;cryptoObjectId:string;encryptedPayloadBytesBase64url:string;keyClass:\"ai\"|\"human\";namespaceEnvelopeBytesBase64url:string;payloadVersion:2;status:\"encrypted\"}|{cryptoObjectId?:string;reason:\"corrupt\"|\"lost_key_material\"|\"missing_grant\"|\"removed\"|\"stale_grant\"|\"unauthorized\"|\"unsupported_version\";status:\"unavailable\"}|{reason:\"backfill_pending\"|\"shadow_pending\";status:\"pending\"}};repair:{allocationDigestBase64url:string;attestationDigestBase64url:string;identityDigestBase64url:string;publisherKind?:\"foreground_runtime\";publisherSignerKeyId:string;publisherSigningPublicKeyBase64url:string};representationMode:\"protected-only\";retainedGeneration?:{accessRevision:number;audienceFingerprintBase64url:string;headDigestBase64url:string;namespaceGeneration:number;publicationDigestBase64url:string;publicationSetDigestBase64url:string};selectedSource:{authorAgentId?:string;logicalMessageKey?:string;role:\"assistant\"|\"system\"|\"tool\"|\"user\";sourceUserId?:string}}|{coordinate:{editRevision:number;logicalMessageKey:string;messageId:number;role:\"assistant\"|\"system\"|\"tool\"|\"user\";sessionId:string};kind?:\"live_shadow\";ordinaryPayloadBytesBase64url:string;protectedMessage:{dtoVersion:2;projection:{authorAgentId?:string;createdAt:string;deliveredAt?:string;editRevision:number;editedAt?:string;lastReplyAt?:string;logicalMessageKey?:string;messageId:string;namespaceId:string;readAt?:string;replyCount?:number;replyToMessageId?:string;role:\"assistant\"|\"system\"|\"tool\"|\"user\";roomId:string;sessionId:string;sourceUserId?:string;subthreadRoomId?:string;summaryRevision?:number};protectedPayload?:{accessManifestBytesBase64url:string;cryptoObjectId:string;encryptedPayloadBytesBase64url:string;keyClass:\"ai\"|\"human\";namespaceEnvelopeBytesBase64url:string;payloadVersion:2;status:\"encrypted\"}|{cryptoObjectId?:string;reason:\"corrupt\"|\"lost_key_material\"|\"missing_grant\"|\"removed\"|\"stale_grant\"|\"unauthorized\"|\"unsupported_version\";status:\"unavailable\"}|{reason:\"backfill_pending\"|\"shadow_pending\";status:\"pending\"}};retainedGeneration:{accessRevision:number;audienceFingerprintBase64url:string;headDigestBase64url:string;namespaceGeneration:number;publicationDigestBase64url:string;publicationSetDigestBase64url:string};shadowOperationFamily?:\"shared_execution\"|\"shared_human\";shadowOperationId:string;shadowTranscriptOrdinal:number}|{coordinate:{editRevision:number;logicalMessageKey:string;messageId:number;role:\"assistant\"|\"system\"|\"tool\"|\"user\";sessionId:string};kind?:\"live_shadow\";protectedMessage:{dtoVersion:2;projection:{authorAgentId?:string;createdAt:string;deliveredAt?:string;editRevision:number;editedAt?:string;lastReplyAt?:string;logicalMessageKey?:string;messageId:string;namespaceId:string;readAt?:string;replyCount?:number;replyToMessageId?:string;role:\"assistant\"|\"system\"|\"tool\"|\"user\";roomId:string;sessionId:string;sourceUserId?:string;subthreadRoomId?:string;summaryRevision?:number};protectedPayload?:{accessManifestBytesBase64url:string;cryptoObjectId:string;encryptedPayloadBytesBase64url:string;keyClass:\"ai\"|\"human\";namespaceEnvelopeBytesBase64url:string;payloadVersion:2;status:\"encrypted\"}|{cryptoObjectId?:string;reason:\"corrupt\"|\"lost_key_material\"|\"missing_grant\"|\"removed\"|\"stale_grant\"|\"unauthorized\"|\"unsupported_version\";status:\"unavailable\"}|{reason:\"backfill_pending\"|\"shadow_pending\";status:\"pending\"}};representationMode:\"protected-only\";retainedGeneration:{accessRevision:number;audienceFingerprintBase64url:string;headDigestBase64url:string;namespaceGeneration:number;publicationDigestBase64url:string;publicationSetDigestBase64url:string};selectedSource:{authorAgentId?:string;logicalMessageKey?:string;role:\"assistant\"|\"system\"|\"tool\"|\"user\";sourceUserId?:string};shadowOperationFamily?:\"shared_execution\"|\"shared_human\";shadowOperationId:string;shadowTranscriptOrdinal:number}[];responseVersion:1;selectedCoordinateDigestBase64url:string;selectedCoordinates:{editRevision:number;logicalMessageKey:string;messageId:number;role:\"assistant\"|\"system\"|\"tool\"|\"user\";sessionId:string}[];selectedCount:number;signerEvidence:{committerDeviceSigningPublicKeyBase64url?:string;kind:\"human_ai_readable_live_shadow_request_v1\"|\"human_ai_readable_live_shadow_request_v2\";operationId:string;planBytesBase64url:string;requestBytesBase64url:string;requestDigestBase64url:string}|{evidenceBytesBase64url:string;kind:\"agent_runtime_publication\"|\"processor_authorization\"}|{kind:\"human_live_shadow_request_v3\"|\"human_live_shadow_request_v4\";operationId:string;planBytesBase64url:string;requestBytesBase64url:string;requestDigestBase64url:string}|{kind:\"human_peer_live_shadow_request_v1\";operationId:string;planBytesBase64url:string;requestBytesBase64url:string;requestDigestBase64url:string;senderDeviceId:string;senderDeviceSigningKeyGeneration:number;senderDeviceSigningPublicKeyBase64url:string}|{kind:\"shared_agent_execution_plan_v4\";operationId:string;planBytesBase64url:string;planDigestBase64url:string}[];status:\"ready\"}|{clientRequestKey:string;eligibleCount:number;operationId:string;policyRevision:number;reason:\"client_crypto_unavailable\"|\"current_read_authority_unavailable\"|\"projection_corrupt\"|\"selection_changed\";responseVersion:1;selectedCoordinateDigestBase64url:string;selectedCount:number;status:\"unavailable\"}|{eligibleCount:0;responseVersion:1;selectedCount:number;status:\"ineligible\"}|{mode:\"plaintext_only\";responseVersion:1;status:\"disabled\"};ordinaryPayloadBytesBase64url?:string;sourceDigestBase64url?:string;status:\"protected\"}|{claim:{action:\"encrypt\"|\"restore\"|\"verify\";authorHumanTurnId?:string;claimId:string;coordinate:{logicalMessageKey:string;messageId:number;namespaceId:string;revision:number;role:\"assistant\"|\"system\"|\"tool\"|\"user\";roomId:string;sessionId:string};createdAt:number;cryptoObjectId:string;deviceGeneration:number;deviceId:string;domainAuthorizationRevision:number;domainGeneration:number;domainHeadDigestBase64url:string;domainId:string;expiresAt:number;hostAuthorizationRevision:number;issuedAt:number;keyClass:\"ai\"|\"human\";lineageGeneration:number;membershipEpoch:number;membershipHeadDigestBase64url:string;membershipSecurityRevision:number;namespaceAccessRevision:number;namespaceBundleDigestBase64url:string;namespaceBundleRevision:number;namespaceHeadDigestBase64url:string;namespaceKeyGeneration:number;operationId:string;policyRevision:number;repairIdentityDigestBase64url:string;serverInstanceId:string;sessionAgentId?:string;sourceRevision?:number;subjectHumanId:string;version:1};payloadBytesBase64url:string;sourceDigestBase64url:string;status:\"ordinary\"}|{resumeAt:number;status:\"integrity_failure\"|\"stale\"|\"unsupported\"|\"waiting_for_authority\"}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.workspace.artifacts.id.share.45eghx",
    "locator": "http:request_response:POST /api/workspace/artifacts/:id/share",
    "structuralSignatures": [
      "request.body:{recipientUserId?:unknown}",
      "request.params:{id:string}",
      "response.body:{error:string;outcome:\"already_applied\"|\"applied\"|\"denied\"|\"failed\"|\"partial\"|\"stale\";receiptPersisted:boolean;stateChanged:boolean}",
      "response.body:{error:string;outcome:\"denied\"|\"failed\"|\"stale\";receiptPersisted:false;recovery:\"prepare_again\"|\"retry_operation\"|\"retry_receipt\";stateChanged:\"unknown\"|false}",
      "response.body:{error:string;outcome:string;stateChanged:boolean}",
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

/** Newly observed current-main DTOs. */
export const REVIEWED_MAIN_2026_09_12_NEW_DTO_DECLARATIONS: readonly DtoDeclaration[] = [
  {
    "observationId": "wire.app.bridge.app.to.host.nautilo.app.recovery.req.read.1o2g1yb",
    "locator": "app_bridge:app_to_host:nautilo.app.recovery.req#read",
    "structuralSignatures": [
      "frame.payload:{input:unresolved<AppRecoveryWrite>;op:\"write\";requestId:string;type:\"nautilo.app.recovery.req\"}|{op:\"read\";requestId:string;type:\"nautilo.app.recovery.req\"}"
    ],
    "arbitraryPayloads": [
      {
        "path": "input",
        "schema": "AppRecoveryWrite"
      }
    ]
  },
  {
    "observationId": "wire.app.bridge.app.to.host.nautilo.app.templates.req.list.1snxbyp",
    "locator": "app_bridge:app_to_host:nautilo.app.templates.req#list",
    "structuralSignatures": [
      "frame.payload:{content:string;name:string;op:\"save\";requestId:string;type:\"nautilo.app.templates.req\"}|{op:\"list\";requestId:string;type:\"nautilo.app.templates.req\"}|{op:\"read\"|\"remove\";requestId:string;templateId:string;type:\"nautilo.app.templates.req\"}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.app.bridge.app.to.host.arbitrary.apps.workbench.src.apps.app.bridge.ts.apprecoveryrequest.33enuo",
    "locator": "app_bridge:app_to_host_arbitrary:apps/workbench/src/apps/app-bridge.ts#AppRecoveryRequest",
    "structuralSignatures": [
      "declaration.payload:{input:unresolved<AppRecoveryWrite>;op:\"write\";requestId:string;type:\"nautilo.app.recovery.req\"}|{op:\"read\";requestId:string;type:\"nautilo.app.recovery.req\"}"
    ],
    "arbitraryPayloads": [
      {
        "path": "input",
        "schema": "AppRecoveryWrite"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.delete.api.apps.nautilo.presentation.slide.templates.templateid.38pmep",
    "locator": "http:request_response:DELETE /api/apps/nautilo-presentation/slide-templates/:templateId",
    "structuralSignatures": [
      "request.params:{templateId:string}",
      "response.body:{error:string}",
      "response.body:{ok:boolean}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.admin.stenographer.status.protection.mo3gpv",
    "locator": "http:request_response:GET /api/admin/stenographer-status/protection",
    "structuralSignatures": [
      "response.body:{authorityWait:{compactionRooms:string;extractionRooms:string;oldestAt?:string};dtoVersion:1;generatedAt:string;plaintextFallback:{last24h:{compaction:{authority:string;device:string};extraction:{authority:string;device:string}};missingProtection:{compactionRollups:string;extractionBatches:string;oldestAt?:string}};queue:{current:{awaitingRecipient:string;claimed:string;grantReady:string;oldestWaitingAt?:string;publicationReconciliation:string;running:string;waitingForDevice:string};last24h:{cancelled:string;outputRepairCompleted:string;protectedCompleted:string;terminalFailures:string}};window:{since:string;until:string}}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.apps.nautilo.presentation.slide.templates.1cabuvu",
    "locator": "http:request_response:GET /api/apps/nautilo-presentation/slide-templates",
    "structuralSignatures": [
      "request.query:{cursor?:unknown}",
      "response.body:{error:string}",
      "response.body:{nextCursor:string;templates:{id:string;name:string}[]}"
    ],
    "arbitraryPayloads": [
      {
        "path": "request.query.cursor",
        "schema": "SlideTemplateCursorV1"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.get.api.apps.nautilo.presentation.slide.templates.templateid.1ud8ibc",
    "locator": "http:request_response:GET /api/apps/nautilo-presentation/slide-templates/:templateId",
    "structuralSignatures": [
      "request.params:{templateId:string}",
      "response.body:{content:string}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.content.access.hv32fk",
    "locator": "http:request_response:GET /api/content-access",
    "structuralSignatures": [
      "response.body:{error:string}",
      "response.body:{object:{id:string;kind:\"artifact\"|\"memory\"};otherAccessCount:number;people:{actorId:string;canRemove:boolean;displayName:string;sources:{boundaryCount:number;kind:\"immutable\";label?:undefined;publicRoom?:undefined;roomId?:undefined}|{boundaryCount?:undefined;kind:\"room\";label:string;publicRoom:boolean;roomId:string}[];userHandle:string}[];rooms:{canDetach:boolean;label:string;publicRoom:boolean;roomId:string}[]}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.event.feed.11jrf51",
    "locator": "http:request_response:GET /api/event-feed",
    "structuralSignatures": [
      "request.query:{[key:string]:unknown;cursor?:unknown;limit?:unknown;types?:unknown;unreadOnly?:unknown}",
      "response.body:{code:\"invalid_cursor\"|\"invalid_input\"|\"not_found\";error:\"event_feed_error\"}",
      "response.body:{code:string;error:string}",
      "response.body:{error:string}",
      "response.body:{events:{actorDisplayName:string;actorId?:string;actorKind:\"agent\"|\"human\";createdAt:string;data:{artifactId:string;destination?:{kind:\"person\";userId?:string}|{kind:\"room\";roomId?:string}};id?:string;readAt?:string;type:\"artifact.shared\"}|{actorDisplayName:string;actorId?:string;actorKind:\"agent\"|\"human\";createdAt:string;data:{artifactId:string;roomId?:string};id?:string;readAt?:string;type:\"artifact.added\"}|{actorDisplayName:string;actorId?:string;actorKind:\"agent\"|\"human\";createdAt:string;data:{roomId?:string;userId?:string};id?:string;readAt?:string;type:\"room.member_joined\"}|{actorDisplayName:string;actorId?:string;actorKind:\"agent\"|\"human\";createdAt:string;data:{roomId?:string;userId?:string};id?:string;readAt?:string;type:\"room.member_left\"}|{actorId:any;actorKind:any;createdAt:string;data:__object;id:string;readAt:string;type:\"unknown\"}[];nextCursor?:string}",
      "response.body:{events:{actorDisplayName?:string;actorId?:string;actorKind:\"agent\"|\"human\";createdAt:string;data:{artifactId:string;destination?:{kind:\"person\";userId?:string}|{kind:\"room\";roomId?:string}};id?:string;readAt?:string;type:\"artifact.shared\"}|{actorDisplayName?:string;actorId?:string;actorKind:\"agent\"|\"human\";createdAt:string;data:{artifactId:string;roomId?:string};id?:string;readAt?:string;type:\"artifact.added\"}|{actorDisplayName?:string;actorId?:string;actorKind:\"agent\"|\"human\";createdAt:string;data:{roomId?:string;userId?:string};id?:string;readAt?:string;type:\"room.member_joined\"}|{actorDisplayName?:string;actorId?:string;actorKind:\"agent\"|\"human\";createdAt:string;data:{roomId?:string;userId?:string};id?:string;readAt?:string;type:\"room.member_left\"}|{actorId:any;actorKind:any;createdAt:string;data:__object;id:string;readAt:string;type:\"unknown\"}[];nextCursor?:string}"
    ],
    "arbitraryPayloads": [
      {
        "path": "request.query",
        "schema": "EventFeedHttpListQueryV1"
      },
      {
        "path": "response.body.events[].actorId",
        "schema": "EventFeedItemActorIdV1"
      },
      {
        "path": "response.body.events[].actorKind",
        "schema": "EventFeedItemActorKindV1"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.get.api.event.feed.unread.count.ha3z9r",
    "locator": "http:request_response:GET /api/event-feed/unread-count",
    "structuralSignatures": [
      "response.body:{error:string}",
      "response.body:{unreadCount:number}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.rooms.roomid.content.access.recovery.1wfee50",
    "locator": "http:request_response:GET /api/rooms/:roomId/content-access-recovery",
    "structuralSignatures": [
      "request.body:unknown",
      "request.params:{roomId:string}",
      "request.query:{cursor?:string}",
      "response.body:void",
      "response.body:{error:string;restartDiscovery:boolean}",
      "response.body:{error:string}",
      "response.body:{nextCursor:null;recoveries:undefined[]}|{outcome:string}",
      "response.body:{nextCursor:string;recoveries:{agentId:string;checkpointId:string;originalJobId:string;toolCallId:string;turnId:string}[]}|{outcome:string}",
      "response.body:{outcome:\"busy\"|\"completed\"|\"unavailable\"}",
      "response.body:{outcome:string}"
    ],
    "arbitraryPayloads": [
      {
        "path": "request.body",
        "schema": "FastifyBodylessGetRequest"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.get.api.tasks.id.content.access.recovery.1qr9f3h",
    "locator": "http:request_response:GET /api/tasks/:id/content-access-recovery",
    "structuralSignatures": [
      "request.body:unknown",
      "request.params:{id:string}",
      "response.body:void",
      "response.body:{capability:\"approve_destructive_actions\"|\"approve_spending\"|\"control_browser\"|\"control_desktop\"|\"control_home\"|\"create_invites\"|\"create_rooms\"|\"invoke_agents\"|\"manage_agents\"|\"manage_billing\"|\"manage_connection_providers\"|\"manage_groups\"|\"manage_members\"|\"manage_memories\"|\"manage_roles\"|\"manage_rooms\"|\"manage_server_operations\"|\"manage_server_security\"|\"manage_server_settings\"|\"manage_standing_approvals\"|\"manage_uncontained_host_commands\"|\"manage_workstation_profiles\"|\"moderate_content_reports\"|\"read_memories\"|\"read_server_settings\"|\"use_connections\"|\"use_google_workspace\"|\"use_image_generation\"|\"use_media_generation\"|\"use_project_content\"|\"use_project_execution\"|\"use_remote_hosts\"|\"use_research_tools\"|\"use_share_artifact\"|\"use_transcription\"|\"use_workstation\"|\"view_audit_log\"|\"write_artifacts\";code:\"invoke_agents_required\"|\"write_artifacts_required\";error:\"invoke_agents_required\"|\"write_artifacts_required\"}",
      "response.body:{error:string}",
      "response.body:{outcome:\"busy\"|\"completed\"|\"retry_required\"|\"unavailable\"}",
      "response.body:{outcome:string}|{recovery:null}",
      "response.body:{recovery:{checkpointId:string;taskId:string;taskRunId:string;toolCallId:string}}"
    ],
    "arbitraryPayloads": [
      {
        "path": "request.body",
        "schema": "FastifyBodylessGetRequest"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.post.api.apps.nautilo.presentation.slide.templates.1oyjhn8",
    "locator": "http:request_response:POST /api/apps/nautilo-presentation/slide-templates",
    "structuralSignatures": [
      "response.body:{error:string}",
      "response.body:{id:string;name:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.background.authorization.requests.list.1ak8tzo",
    "locator": "http:request_response:POST /api/background-authorization/requests/list",
    "structuralSignatures": [
      "response.body:{continuation?:string;requests:{requestBytesBase64url:string}[];responseVersion:1}",
      "response.body:{error:string}",
      "response.body:{responseVersion:1;status:\"accepted\"|\"duplicate\"|\"malformed\"|\"stale\"|\"superseded\"|\"unauthorized\"}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.background.authorization.respond.y4mx5a",
    "locator": "http:request_response:POST /api/background-authorization/respond",
    "structuralSignatures": [
      "response.body:{responseVersion:1;status:\"accepted\"|\"duplicate\"|\"malformed\"|\"stale\"|\"superseded\"|\"unauthorized\"}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.content.access.commit.og5dbe",
    "locator": "http:request_response:POST /api/content-access/commit",
    "structuralSignatures": [
      "request.body:unknown",
      "request.query:unknown",
      "response.body:{attachedCount:number;detachedCount:number;operationId:string;originalStateChanged:boolean;outcome:\"already_applied\"|\"applied\"|\"denied\"|\"failed\"|\"partial\"|\"stale\";replayed:boolean;skippedCount:number;stateChanged:boolean}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": [
      {
        "path": "request.body",
        "schema": "ContentAccessCommitRequestV1"
      },
      {
        "path": "request.query",
        "schema": "ContentAccessSourceQueryV1"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.post.api.content.access.prepare.g0egvq",
    "locator": "http:request_response:POST /api/content-access/prepare",
    "structuralSignatures": [
      "request.body:unknown",
      "request.query:unknown",
      "response.body:{command:{change:{actorId:string;kind:\"remove_person\"}|{kind:\"detach_room\";targetRoomId:string}|{kind:\"grant_people\";selectedActorIds:string[]}|{kind:\"grant_room\";targetRoomId:string}|{kind:\"make_private\"};object:{id:string;kind:\"artifact\"|\"memory\"};operationId:string};expiresAt:number;outcome:\"prepared\";preview:{humanActorIds:string[];people:{actorId:string;displayName:string;userHandle:string}[];publicRoom:boolean;skippedAttachmentCount:number;targetRoomId?:string;targetRoomLabel?:string};previewToken:string}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": [
      {
        "path": "request.body",
        "schema": "ContentAccessPrepareRequestV1"
      },
      {
        "path": "request.query",
        "schema": "ContentAccessSourceQueryV1"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.post.api.event.feed.mark.all.read.1f5kfwu",
    "locator": "http:request_response:POST /api/event-feed/mark-all-read",
    "structuralSignatures": [
      "response.body:{error:string}",
      "response.body:{updatedCount:number}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.rooms.roomid.content.access.recovery.fzqmve",
    "locator": "http:request_response:POST /api/rooms/:roomId/content-access-recovery",
    "structuralSignatures": [
      "request.body:unknown",
      "request.params:{roomId:string}",
      "request.query:{cursor?:string}",
      "response.body:void",
      "response.body:{error:string;restartDiscovery:boolean}",
      "response.body:{error:string}",
      "response.body:{nextCursor:null;recoveries:undefined[]}|{outcome:string}",
      "response.body:{nextCursor:string;recoveries:{agentId:string;checkpointId:string;originalJobId:string;toolCallId:string;turnId:string}[]}|{outcome:string}",
      "response.body:{outcome:\"busy\"|\"completed\"|\"unavailable\"}",
      "response.body:{outcome:string}"
    ],
    "arbitraryPayloads": [
      {
        "path": "request.body",
        "schema": "OrdinaryContentAccessRecoveryCoordinateV1"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.post.api.tasks.id.content.access.recovery.zmzh8b",
    "locator": "http:request_response:POST /api/tasks/:id/content-access-recovery",
    "structuralSignatures": [
      "request.body:unknown",
      "request.params:{id:string}",
      "response.body:void",
      "response.body:{capability:\"approve_destructive_actions\"|\"approve_spending\"|\"control_browser\"|\"control_desktop\"|\"control_home\"|\"create_invites\"|\"create_rooms\"|\"invoke_agents\"|\"manage_agents\"|\"manage_billing\"|\"manage_connection_providers\"|\"manage_groups\"|\"manage_members\"|\"manage_memories\"|\"manage_roles\"|\"manage_rooms\"|\"manage_server_operations\"|\"manage_server_security\"|\"manage_server_settings\"|\"manage_standing_approvals\"|\"manage_uncontained_host_commands\"|\"manage_workstation_profiles\"|\"moderate_content_reports\"|\"read_memories\"|\"read_server_settings\"|\"use_connections\"|\"use_google_workspace\"|\"use_image_generation\"|\"use_media_generation\"|\"use_project_content\"|\"use_project_execution\"|\"use_remote_hosts\"|\"use_research_tools\"|\"use_share_artifact\"|\"use_transcription\"|\"use_workstation\"|\"view_audit_log\"|\"write_artifacts\";code:\"invoke_agents_required\"|\"write_artifacts_required\";error:\"invoke_agents_required\"|\"write_artifacts_required\"}",
      "response.body:{error:string}",
      "response.body:{outcome:\"busy\"|\"completed\"|\"retry_required\"|\"unavailable\"}",
      "response.body:{outcome:string}|{recovery:null}",
      "response.body:{recovery:{checkpointId:string;taskId:string;taskRunId:string;toolCallId:string}}"
    ],
    "arbitraryPayloads": [
      {
        "path": "request.body",
        "schema": "TaskContentAccessRecoveryCoordinateV1"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.put.api.event.feed.eventid.read.1jiqot3",
    "locator": "http:request_response:PUT /api/event-feed/:eventId/read",
    "structuralSignatures": [
      "request.body:unknown",
      "request.params:{eventId:string}",
      "response.body:{changed:boolean;eventId?:string;readAt?:string}",
      "response.body:{code:\"invalid_cursor\"|\"invalid_input\"|\"not_found\";error:\"event_feed_error\"}",
      "response.body:{code:string;error:string}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": [
      {
        "path": "request.body",
        "schema": "EventFeedSetReadRequest"
      }
    ]
  },
  {
    "observationId": "wire.ws.server.to.client.crypto.background.authorization.requested.15fmeac",
    "locator": "ws:server_to_client:crypto.background_authorization_requested",
    "structuralSignatures": [],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.ws.server.to.client.event.feed.changed.1bw0yzf",
    "locator": "ws:server_to_client:event_feed.changed",
    "structuralSignatures": [],
    "arbitraryPayloads": []
  }
];
