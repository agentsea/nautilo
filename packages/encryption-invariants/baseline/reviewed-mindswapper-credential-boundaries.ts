import type { EncryptionCoverageEntry } from "../src/model";
import type { DtoDeclaration } from "../src/node/dto-inventory";
import type { SourceAlarmReview } from "../src/node/source-alarm-review";
import type { SourceDeclaration } from "../src/node/source-inventory";
import type { ReviewedDebtLink } from "../src/registry";

const routeFile = "packages/server/src/routes/setup.ts";
const routeTest = "packages/server/tests/unit-isolated/setup-keys.test.ts";
const clientFile = "packages/api-client/src/client.ts";
const catalogueFile = "packages/server/src/lib/mindswapper-catalog.ts";
const completionsFile = "packages/agent/src/providers/mindswapper-completions.ts";
const connectionPath = "/api/setup/keys/mindswapper/connection";

export const MINDSWAPPER_CREDENTIAL_COVERAGE: readonly EncryptionCoverageEntry[] = [
  {
    id: "mindswapper.admin.connection-metadata",
    surface: "wire",
    locator: `http:request_response:GET ${connectionPath}`,
    owner: "packages/server",
    readers: [clientFile],
    writers: [routeFile],
    migrationState: "not_applicable",
    retention: "The connection settings response exists only for the authenticated request.",
    testEvidence: [routeTest],
    classification: "bounded_metadata",
    metadataAllowlist: ["baseUrl", "approvedDestinations", "error"],
    plaintextReason: "The response contains normalized API destinations and fixed errors. Only administrators with provider management authority can read it.",
  },
  {
    id: "mindswapper.admin.connection-credential",
    surface: "wire",
    locator: `http:request_response:PUT ${connectionPath}`,
    owner: "packages/server",
    readers: [routeFile],
    writers: [clientFile],
    migrationState: "not_applicable",
    retention: "The submitted server API key exists in authenticated request memory during validation and persists in existing operator configuration until replaced or deleted.",
    testEvidence: [routeTest, "packages/config-guard/tests/unit/mindswapper.test.ts"],
    classification: "operator_secret",
    secretStoreLocation: "The existing server provider configuration transaction stores the key in operator-controlled instance.env. The route does not return the key. Validation sends it only to the submitted HTTPS MindSwapper API root with redirects disabled.",
    backupProcedure: "Server provider configuration and its rollback snapshots follow the existing operator-controlled config-guard storage and backup process. Request memory is not backed up.",
    excludedFromAgentGrants: true,
  },
  {
    id: "mindswapper.processor.model-discovery",
    surface: "processor",
    locator: `${catalogueFile}#createMindSwapperCatalogue`,
    owner: "packages/server",
    readers: [catalogueFile],
    writers: [catalogueFile],
    migrationState: "not_applicable",
    retention: "Only validated model metadata is retained in the expiring connection-scoped cache.",
    testEvidence: ["packages/server/tests/unit/mindswapper-catalog.test.ts"],
    classification: "operator_secret",
    secretStoreLocation: "The selected connection key exists transiently in request memory and the Authorization header for the fixed models operation on its admitted API root. The request has no prompt, tool payload, or request body. Redirects are refused.",
    backupProcedure: "The transient request and the bounded metadata cache are rebuilt from the configured connection and are excluded from backup. The server key and personal encrypted credential follow their existing backup contracts.",
    excludedFromAgentGrants: true,
  },
];

export const MINDSWAPPER_CREDENTIAL_SOURCE_DECLARATIONS: readonly SourceDeclaration[] = [
  {
    id: "source.processor.mindswapper-model-discovery",
    surface: "processor",
    role: "processor",
    locator: `${catalogueFile}#createMindSwapperCatalogue`,
    evidence: [{ path: catalogueFile, symbols: ["createMindSwapperCatalogue", '"/models"', 'redirect: "error"'] }],
  },
  {
    id: "source.processor.mindswapper-chat-completions",
    surface: "processor",
    role: "processor",
    locator: `${completionsFile}#createMindSwapperFetch`,
    evidence: [{ path: completionsFile, symbols: ["createMindSwapperFetch", "assertWireOffer", 'redirect: "error"'] }],
  },
];

export const MINDSWAPPER_CHAT_PROCESSOR_DEBT_LINK: ReviewedDebtLink = {
  id: "mindswapper.processor.chat-completions",
  surface: "processor",
  locator: `${completionsFile}#createMindSwapperFetch`,
  owner: "packages/agent",
  targetDebtIds: ["debt.source.processor.chat-model-factory"],
  reason: "This adapter carries the same authorized conversation and tool payload as the existing chat-model provider processor. Endpoint and credential checks add dispatch fences without changing the plaintext processing class or claiming operator-blind or provider-blind inference.",
  testEvidence: ["packages/agent/tests/unit/mindswapper-chat.test.ts"],
};

export const MINDSWAPPER_CREDENTIAL_SOURCE_ALARMS: readonly SourceAlarmReview[] = [
  {
    locator: `${catalogueFile}#network_processor:91f3683baad865e9:1`,
    owner: "packages/server",
    closure: "declaration",
    declarationId: "source.processor.mindswapper-model-discovery",
    reason: "This fetch adapter performs the fixed GET /models request under the selected server or personal connection. It sends only the connection bearer and closed request headers, refuses redirects, and retains validated model metadata within that connection's cache.",
  },
  {
    locator: `${completionsFile}#network_processor:33b5ad5a844c5da2:1`,
    owner: "packages/agent",
    closure: "declaration",
    declarationId: "source.processor.mindswapper-chat-completions",
    reason: "This is the accepted plaintext model-processing boundary. Existing execution and disclosure authority supplies the exact funding-bound connection. The adapter checks the endpoint, method, upstream model and offer before dispatching the admitted conversation and tools. It refuses redirects and does not forward provider error bodies.",
  },
];

const signaturesByLocator: Readonly<Record<string, readonly string[]>> = {
  "http:request_response:GET /api/account/provider-credentials": [
    "request.query:{includeMindSwapper?:string}",
    "response.body:unknown",
    "response.body:{allowPersonalProviderKeys:boolean;credentials:{createdAt:string;destination:string;id:string;masked:any;provider:\"anthropic\"|\"browser-use\"|\"cloudconvert\"|\"elevenlabs\"|\"fireworks\"|\"gateway\"|\"google\"|\"groq\"|\"mindswapper\"|\"nautilo-gateway\"|\"openai\"|\"openrouter\"|\"surplus\"|\"tavily\"|\"together\"|\"typesafe\"|\"venice\"|\"xai\";receiptReadStatus:\"available\"|\"unavailable\"|\"unknown\";requiresReplacement:boolean;revision:number;updatedAt:string;validatedAt:string;validationStatus:\"accepted\"|\"rejected\"|\"unavailable\"|\"unverified\"}[];providers:{approvedDestinations?:string[];formatHint?:string;id:string;name:string;personalCapabilities:\"browsing\"|\"chat\"|\"conversion\"|\"decision\"|\"images\"|\"media\"|\"research\"|\"transcription\"|\"voice\"[];purpose:string;signupUrl?:string}[]}",
    "response.body:{allowPersonalProviderKeys:boolean;credentials:{createdAt:string;destination:string;id:string;masked:string;provider:\"anthropic\"|\"browser-use\"|\"cloudconvert\"|\"elevenlabs\"|\"fireworks\"|\"gateway\"|\"google\"|\"groq\"|\"mindswapper\"|\"nautilo-gateway\"|\"openai\"|\"openrouter\"|\"surplus\"|\"tavily\"|\"together\"|\"typesafe\"|\"venice\"|\"xai\";receiptReadStatus:\"available\"|\"unavailable\"|\"unknown\";requiresReplacement:boolean;revision:number;updatedAt:string;validatedAt:string;validationStatus:\"accepted\"|\"rejected\"|\"unavailable\"|\"unverified\"}[];providers:{approvedDestinations?:string[];formatHint?:string;id:string;name:string;personalCapabilities:\"browsing\"|\"chat\"|\"conversion\"|\"decision\"|\"images\"|\"media\"|\"research\"|\"transcription\"|\"voice\"[];purpose:string;signupUrl?:string}[]}"
  ],
  "http:request_response:POST /api/account/provider-credentials/:provider/validate": [
    "response.body:unknown",
    "response.body:{committed:boolean;credential:{createdAt:string;destination:string;id:string;masked:string;provider:\"anthropic\"|\"browser-use\"|\"cloudconvert\"|\"elevenlabs\"|\"fireworks\"|\"gateway\"|\"google\"|\"groq\"|\"mindswapper\"|\"nautilo-gateway\"|\"openai\"|\"openrouter\"|\"surplus\"|\"tavily\"|\"together\"|\"typesafe\"|\"venice\"|\"xai\";receiptReadStatus:\"available\"|\"unavailable\"|\"unknown\";requiresReplacement:boolean;revision:number;updatedAt:string;validatedAt:string;validationStatus:\"accepted\"|\"rejected\"|\"unavailable\"|\"unverified\"}}",
    "response.body:{committed:boolean;error:\"authentication_required\"|\"credential_conflict\"|\"credential_custody_unavailable\"|\"credential_destination_changed\"|\"credential_destination_unavailable\"|\"credential_not_found\"|\"credential_reenrollment_required\"|\"invalid_credential_request\"|\"invalid_provider\"|\"personal_credentials_disabled\"|\"personal_credentials_forbidden\"|\"personal_credentials_unavailable\";repair:string;retryable:boolean}"
  ],
  "http:request_response:PUT /api/account/provider-credentials/:provider": [
    "request.body:{apiKey:string;destination?:string;expectedRevision?:number}",
    "response.body:unknown",
    "response.body:{committed:boolean;credential:{createdAt:string;destination:string;id:string;masked:string;provider:\"anthropic\"|\"browser-use\"|\"cloudconvert\"|\"elevenlabs\"|\"fireworks\"|\"gateway\"|\"google\"|\"groq\"|\"mindswapper\"|\"nautilo-gateway\"|\"openai\"|\"openrouter\"|\"surplus\"|\"tavily\"|\"together\"|\"typesafe\"|\"venice\"|\"xai\";receiptReadStatus:\"available\"|\"unavailable\"|\"unknown\";requiresReplacement:boolean;revision:number;updatedAt:string;validatedAt:string;validationStatus:\"accepted\"|\"rejected\"|\"unavailable\"|\"unverified\"}}",
    "response.body:{committed:boolean;error:\"authentication_required\"|\"credential_conflict\"|\"credential_custody_unavailable\"|\"credential_destination_changed\"|\"credential_destination_unavailable\"|\"credential_not_found\"|\"credential_reenrollment_required\"|\"invalid_credential_request\"|\"invalid_provider\"|\"personal_credentials_disabled\"|\"personal_credentials_forbidden\"|\"personal_credentials_unavailable\";repair:string;retryable:boolean}"
  ]
};

const newRoutes: readonly DtoDeclaration[] = [
  {
    "observationId": "wire.http.request.response.get.api.setup.keys.mindswapper.connection.15ap4xi",
    "locator": "http:request_response:GET /api/setup/keys/mindswapper/connection",
    "structuralSignatures": [
      "response.body:{approvedDestinations:string[];baseUrl:string}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.put.api.setup.keys.mindswapper.connection.124sgt1",
    "locator": "http:request_response:PUT /api/setup/keys/mindswapper/connection",
    "structuralSignatures": [
      "request.body:{apiKey?:string;approvedDestinations?:string[];baseUrl?:string}",
      "response.body:{approvedDestinations:string[];baseUrl:string}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  }
];

/** Replace exact account credential signatures while retaining their closed leaf declarations. */
export function reviewedMindSwapperCredentialDtoReplacements(
  previous: readonly DtoDeclaration[],
): readonly DtoDeclaration[] {
  return [
    ...previous.map((entry) => {
      const structuralSignatures = signaturesByLocator[entry.locator];
      return structuralSignatures ? { ...entry, structuralSignatures } : entry;
    }),
    ...newRoutes,
  ];
}
