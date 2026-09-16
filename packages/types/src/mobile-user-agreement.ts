/**
 * M297 — one browser-safe Mobile agreement shared by the native client and
 * Server. Changing policy text, processing disclosure, or recipient inventory
 * requires a new version rather than mutating an already accepted contract.
 */
export const MOBILE_USER_AGREEMENT_VERSION = "mobile-user-agreement-v1" as const;
export const MOBILE_USER_POLICY_VERSION = "community-rules-v1" as const;
export const MOBILE_EXTERNAL_RECIPIENT_MANIFEST_VERSION = "external-recipients-v1" as const;
export const MOBILE_USER_AGREEMENT_EFFECTIVE_DATE = "2026-08-27" as const;

export type MobileExternalRecipientCategory =
  | "AI models"
  | "Search"
  | "Document conversion"
  | "Speech"
  | "Server-configured services";

export interface MobileExternalRecipient {
  readonly name: string;
  readonly category: MobileExternalRecipientCategory;
  readonly detail?: string;
}

export const MOBILE_EXTERNAL_RECIPIENTS: readonly MobileExternalRecipient[] = [
  { name: "OpenAI", category: "AI models" },
  { name: "Anthropic", category: "AI models" },
  { name: "Google Gemini", category: "AI models" },
  { name: "xAI", category: "AI models" },
  {
    name: "OpenRouter",
    category: "AI models",
    detail: "OpenRouter may route requests to model providers available through its service.",
  },
  { name: "Fireworks AI", category: "AI models" },
  { name: "Together AI", category: "AI models" },
  { name: "Venice AI", category: "AI models" },
  { name: "Tavily", category: "Search" },
  { name: "DuckDuckGo", category: "Search" },
  { name: "CloudConvert", category: "Document conversion" },
  { name: "ElevenLabs", category: "Speech" },
  { name: "Groq", category: "Speech" },
  {
    name: "Administrator-configured external AI gateways and remote tools",
    category: "Server-configured services",
    detail: "The individual operators depend on the connected Server's configuration.",
  },
] as const;

export interface MobileUserPolicySection {
  readonly title: string;
  readonly paragraphs: readonly string[];
  readonly bullets?: readonly string[];
}

export const MOBILE_USER_POLICY_SECTIONS: readonly MobileUserPolicySection[] = [
  {
    title: "Community Rules",
    paragraphs: [
      "Use Nautilo lawfully and treat other people with respect. You are responsible for the content and instructions you submit through your connected Server.",
      "You must not create, request, upload, or distribute prohibited content, or use an Agent to do so.",
    ],
    bullets: [
      "Illegal, exploitative, or sexually abusive content, including any sexual content involving minors",
      "Threats, incitement to violence, hateful conduct, harassment, bullying, or targeted abuse",
      "Fraud, scams, spam, impersonation, deceptive behavior, or malicious interference",
      "Content that violates another person's privacy, safety, or intellectual-property rights",
    ],
  },
  {
    title: "Reports, blocking, and enforcement",
    paragraphs: [
      "Use Report and Block where available when content or another Human violates these rules. Reports go to authorized administrators of the connected self-hosted Server—not to Apple, Google, or a central Nautilo moderation service.",
      "Server administrators may review reports and take action under their own moderation practices. Contact Nautilo support if the in-app safety controls are unavailable.",
    ],
  },
] as const;

export const MOBILE_EXTERNAL_PROCESSING_PARAGRAPHS = [
  "External processing is part of Nautilo's core Mobile functionality. Content you submit—including prompts, messages, files, images, audio, and related instructions—may be sent by your connected Server to external services for AI models, search, document conversion, speech, or remote tools.",
  "Which services are used depends on the connected Server's configuration. A Server may use any recipient or category listed below even when it is not currently configured on another Server.",
  "Withdrawing acceptance stops future Mobile use until you accept again. It cannot retract content that was already sent to a Server or external service.",
] as const;

export const MOBILE_USER_AGREEMENT_VERSIONS = {
  agreementVersion: MOBILE_USER_AGREEMENT_VERSION,
  policyVersion: MOBILE_USER_POLICY_VERSION,
  recipientManifestVersion: MOBILE_EXTERNAL_RECIPIENT_MANIFEST_VERSION,
} as const;

export interface MobileUserAgreementAcceptanceDto {
  readonly agreementVersion: string;
  readonly policyVersion: string;
  readonly recipientManifestVersion: string;
  readonly acceptedAt: string;
  readonly withdrawnAt: string | null;
}

export interface MobileUserAgreementStateResponse {
  readonly current: {
    readonly agreementVersion: string;
    readonly policyVersion: string;
    readonly recipientManifestVersion: string;
  };
  readonly accepted: boolean;
  readonly acceptance: MobileUserAgreementAcceptanceDto | null;
}

export interface AcceptMobileUserAgreementRequest {
  readonly agreementVersion: string;
}

export function isCurrentMobileUserAgreementVersion(value: unknown): value is typeof MOBILE_USER_AGREEMENT_VERSION {
  return value === MOBILE_USER_AGREEMENT_VERSION;
}

export function hasCurrentMobileUserAgreementContract(state: MobileUserAgreementStateResponse): boolean {
  return state.current.agreementVersion === MOBILE_USER_AGREEMENT_VERSION &&
    state.current.policyVersion === MOBILE_USER_POLICY_VERSION &&
    state.current.recipientManifestVersion === MOBILE_EXTERNAL_RECIPIENT_MANIFEST_VERSION;
}

export function isCurrentMobileUserAgreementState(state: MobileUserAgreementStateResponse): boolean {
  return state.accepted && hasCurrentMobileUserAgreementContract(state) &&
    state.acceptance?.agreementVersion === MOBILE_USER_AGREEMENT_VERSION &&
    state.acceptance.policyVersion === MOBILE_USER_POLICY_VERSION &&
    state.acceptance.recipientManifestVersion === MOBILE_EXTERNAL_RECIPIENT_MANIFEST_VERSION &&
    state.acceptance.withdrawnAt === null;
}
