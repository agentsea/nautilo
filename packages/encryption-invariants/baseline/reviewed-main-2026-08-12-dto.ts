import type { DtoDeclaration } from "../src/node/dto-inventory";

const appBridgeOptionsSignature = "declaration.payload:{appId:string;documentSession?:{documentReadGeneration?:number;documentReadPromise?:unresolved<Promise>;documentTargetKey?:string;envelope:null|{baseRevision:null|number;baseSha256:null|string;content:string;localIdentity?:{canonicalPath:string;kind:\"local_file\";relayId:string};mimeType:string;path:string}};draft?:{appId:string;createActionId:null|string;roomId?:string;suggestedName:string};getLiveSession?:() => { sessionToken: string; sessionId: string; documentVersion: LiveDocumentVersion; } | null;iframe:unresolved<HTMLIFrameElement>;materialize?:(content: string, mimeType: string) => Promise<ArtifactTarget>;onContextUpdate?:(context: ActiveMiniAppContext) => void;onDocumentVersion?:(documentVersion: LiveDocumentVersion) => void;onHumanEditUpdate?:(update: AppHumanEditUpdate) => void;onLiveProposalAccepted?:(result: ApplyAcceptedLiveProposalResponse) => void;target?:unresolved<OpenFileTarget>;viewerKey?:null|string}";
const appBridgeRequestSignature = "declaration.payload:{acceptedContent:string;acceptedOperationIndexes:unknown;documentVersion:unknown;op:\"acceptProposal\";proposalId:string;requestId:string;type:\"nautilo.app.session.req\"}|{baseRevision?:null|number;baseSha256?:null|string;op:\"write\";requestId:string;type:\"nautilo.app.document.req\";value:unknown}|{key:string;op:\"get\";requestId:string;type:\"nautilo.app.state.req\"}|{key:string;op:\"set\";requestId:string;type:\"nautilo.app.state.req\";value:unknown}|{key:unresolved<AppPreferenceKey>;op:\"get\";requestId:string;type:\"nautilo.app.preferences.req\"}|{key:unresolved<AppPreferenceKey>;op:\"set\";requestId:string;type:\"nautilo.app.preferences.req\";value:unknown}|{key:unresolved<AppPreferenceKey>;type:\"nautilo.app.preferences.subscribe\"}|{op:\"read\"|\"stat\";requestId:string;type:\"nautilo.app.document.req\"}|{summary:unknown;type:\"nautilo.app.context.update\"}|{type:\"nautilo.app.human-edit.update\";update:{draftPatch?:unresolved<AnchoredTextPatch>;state:\"clean\"|\"conflict\"|\"dirty\"|\"saving\"}}";

export const REVIEWED_MAIN_2026_08_12_DTO_DECLARATIONS: readonly DtoDeclaration[] = [
  {
    observationId: "wire.app.bridge.app.to.host.arbitrary.apps.workbench.src.apps.app.bridge.ts.apppreferencegetrequest.19xjv08",
    locator: "app_bridge:app_to_host_arbitrary:apps/workbench/src/apps/app-bridge.ts#AppPreferenceGetRequest",
    structuralSignatures: ["declaration.payload:{key:unresolved<AppPreferenceKey>;op:\"get\";requestId:string;type:\"nautilo.app.preferences.req\"}"],
    arbitraryPayloads: [{ path: "key", schema: "AppPreferenceKey" }],
  },
  {
    observationId: "wire.app.bridge.app.to.host.arbitrary.apps.workbench.src.apps.app.bridge.ts.apppreferencesetrequest.19f92i4",
    locator: "app_bridge:app_to_host_arbitrary:apps/workbench/src/apps/app-bridge.ts#AppPreferenceSetRequest",
    structuralSignatures: ["declaration.payload:{key:unresolved<AppPreferenceKey>;op:\"set\";requestId:string;type:\"nautilo.app.preferences.req\";value:unknown}"],
    arbitraryPayloads: [
      { path: "key", schema: "AppPreferenceKey" },
      { path: "value", schema: "WriterSpellPreference" },
    ],
  },
  {
    observationId: "wire.app.bridge.app.to.host.arbitrary.apps.workbench.src.apps.app.bridge.ts.apppreferencesubscribemessage.1mg9fui",
    locator: "app_bridge:app_to_host_arbitrary:apps/workbench/src/apps/app-bridge.ts#AppPreferenceSubscribeMessage",
    structuralSignatures: ["declaration.payload:{key:unresolved<AppPreferenceKey>;type:\"nautilo.app.preferences.subscribe\"}"],
    arbitraryPayloads: [{ path: "key", schema: "AppPreferenceKey" }],
  },
  {
    observationId: "wire.app.bridge.app.to.host.nautilo.app.preferences.req.get.3ol792",
    locator: "app_bridge:app_to_host:nautilo.app.preferences.req#get",
    structuralSignatures: ["frame.payload:{key:unresolved<AppPreferenceKey>;op:\"get\";requestId:string;type:\"nautilo.app.preferences.req\"}"],
    arbitraryPayloads: [{ path: "key", schema: "AppPreferenceKey" }],
  },
  {
    observationId: "wire.app.bridge.app.to.host.nautilo.app.preferences.req.set.173hd4q",
    locator: "app_bridge:app_to_host:nautilo.app.preferences.req#set",
    structuralSignatures: ["frame.payload:{key:unresolved<AppPreferenceKey>;op:\"set\";requestId:string;type:\"nautilo.app.preferences.req\";value:unknown}"],
    arbitraryPayloads: [
      { path: "key", schema: "AppPreferenceKey" },
      { path: "value", schema: "WriterSpellPreference" },
    ],
  },
  {
    observationId: "wire.app.bridge.app.to.host.nautilo.app.preferences.subscribe.2yx25l",
    locator: "app_bridge:app_to_host:nautilo.app.preferences.subscribe",
    structuralSignatures: ["frame.payload:{key:unresolved<AppPreferenceKey>;type:\"nautilo.app.preferences.subscribe\"}"],
    arbitraryPayloads: [{ path: "key", schema: "AppPreferenceKey" }],
  },
  {
    observationId: "wire.app.bridge.host.to.app.arbitrary.apps.workbench.src.apps.app.bridge.ts.appbridgeoptions.ojsugv",
    locator: "app_bridge:host_to_app_arbitrary:apps/workbench/src/apps/app-bridge.ts#AppBridgeOptions",
    structuralSignatures: [appBridgeOptionsSignature],
    arbitraryPayloads: [
      { path: "documentSession.documentReadPromise", debtId: "debt.wire.arbitrary.1pjbi6v" },
      { path: "iframe", debtId: "debt.wire.arbitrary.e8lqi4" },
      { path: "target", debtId: "debt.wire.arbitrary.1mgxsot" },
    ],
  },
  {
    observationId: "wire.app.bridge.host.to.app.arbitrary.apps.workbench.src.apps.app.bridge.ts.appbridgerequest.xxmqpw",
    locator: "app_bridge:host_to_app_arbitrary:apps/workbench/src/apps/app-bridge.ts#AppBridgeRequest",
    structuralSignatures: [appBridgeRequestSignature],
    arbitraryPayloads: [
      { path: "acceptedOperationIndexes", debtId: "debt.wire.arbitrary.rddovr" },
      { path: "documentVersion", debtId: "debt.wire.arbitrary.u5zte0" },
      { path: "key", schema: "AppPreferenceKey" },
      { path: "summary", debtId: "debt.wire.arbitrary.z2o3n7" },
      { path: "update.draftPatch", debtId: "debt.wire.arbitrary.z234jl" },
      { path: "value", debtId: "debt.wire.arbitrary.q5uskq" },
    ],
  },
  {
    observationId: "wire.app.bridge.host.to.app.nautilo.app.preferences.changed.45yu8r",
    locator: "app_bridge:host_to_app:nautilo.app.preferences.changed",
    structuralSignatures: [],
    arbitraryPayloads: [],
  },
  {
    observationId: "wire.http.request.response.post.api.remote.host.files.list.iy1sd8",
    locator: "http:request_response:POST /api/remote/host-files/list",
    structuralSignatures: [
      "response.body:{entries:{isDirectory:boolean;isFile:boolean;isSymbolicLink:boolean;name:string;path:string}[];nextCursor:string}",
      "response.body:{entries:{isDirectory:true;isFile:false;isSymbolicLink:false;name:string;path:string}[];nextCursor:string}",
      "response.body:{error:string}",
    ],
    arbitraryPayloads: [],
  },
];

export const REVIEWED_MAIN_2026_08_12_SUPERSEDED_DTO_LOCATORS: ReadonlySet<string> = new Set([
  "app_bridge:host_to_app_arbitrary:apps/workbench/src/apps/app-bridge.ts#AppBridgeOptions",
  "app_bridge:host_to_app_arbitrary:apps/workbench/src/apps/app-bridge.ts#AppBridgeRequest",
  "http:request_response:POST /api/remote/host-files/list",
]);
