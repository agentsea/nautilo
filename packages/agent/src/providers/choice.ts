import type { TenantContext } from "../resolve-provider-key";

export type ChoiceRequestErrorCode =
  | "invalid_request" | "unsupported_model" | "missing_credentials"
  | "cancelled" | "network_error" | "provider_error" | "invalid_response" | "context_length_exceeded";

const ERROR_MESSAGES: Record<ChoiceRequestErrorCode, string> = {
  invalid_request: "Choice request is invalid or exceeds the catalogued candidate bound.",
  unsupported_model: "The selected catalog model cannot execute Choice.",
  missing_credentials: "Choice provider credentials are not configured.",
  cancelled: "Choice request was cancelled.",
  network_error: "Choice provider could not be reached.",
  provider_error: "Choice provider rejected the request.",
  context_length_exceeded: "Choice request exceeds the provider context capacity.",
  invalid_response: "Choice provider returned an invalid response.",
};

/** Never attach provider bodies, request data, credential values, or raw causes. */
export class ChoiceRequestError extends Error {
  constructor(
    readonly code: ChoiceRequestErrorCode,
    readonly status: number | null = null,
    readonly retryable = false,
  ) {
    super(ERROR_MESSAGES[code]);
    this.name = "ChoiceRequestError";
  }
}

export interface ChoiceInput {
  readonly modelId: string;
  readonly state: string | Record<string, unknown> | readonly unknown[];
  readonly instructions: string;
  readonly choices: readonly { readonly id: string; readonly description: string }[];
  readonly signal: AbortSignal;
  readonly tenantContext?: TenantContext;
}

export interface ChoiceResult {
  readonly selectedId: string;
  readonly requestedModelId: string;
  readonly resolvedModelId: string | null;
  readonly responseId?: string;
  readonly provider?: string;
  readonly confidence?: number;
  readonly probabilities?: Readonly<Record<string, number>>;
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly actualCostUsd: number | null;
  };
}

export interface ChoiceDriver {
  invoke(input: ChoiceInput): Promise<ChoiceResult>;
}
