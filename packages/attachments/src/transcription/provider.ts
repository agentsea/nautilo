export type TranscriptionProviderId = "groq" | "openai" | "whisper-cpp" | "elevenlabs";

export type TranscriptionInput = {
  bytes: Uint8Array;
  filename: string;
  mime: string;
  language?: string;
  timestamps?: boolean;
  signal?: AbortSignal;
};

export type TranscriptionResult = {
  text: string;
  provider: string;
  model: string;
};

export interface TranscriptionProvider {
  id: TranscriptionProviderId;
  available(): Promise<boolean>;
  transcribe(input: TranscriptionInput): Promise<TranscriptionResult>;
}

export class TranscriptionProviderUnavailableError extends Error {
  constructor(message = "No transcription provider configured") {
    super(message);
    this.name = "TranscriptionProviderUnavailableError";
  }
}

export type TranscriptionProviderFailureCode =
  | "request_cancelled"
  | "authentication_failed"
  | "payment_required"
  | "access_denied"
  | "request_too_large"
  | "rate_limited"
  | "request_rejected"
  | "provider_unavailable"
  | "invalid_response"
  | "transport_unavailable";

/** Safe provider failure that deliberately carries no response-body detail. */
export class TranscriptionProviderRequestError extends Error {
  constructor(
    readonly code: TranscriptionProviderFailureCode,
    readonly status: number | null = null,
  ) {
    super(
      status === null
        ? `Transcription provider request failed (${code}).`
        : `Transcription provider request failed (${code}, HTTP ${status}).`,
    );
    this.name = "TranscriptionProviderRequestError";
  }
}

export function transcriptionProviderFailureForStatus(
  status: number,
): TranscriptionProviderFailureCode {
  if (status === 401) return "authentication_failed";
  if (status === 402) return "payment_required";
  if (status === 403) return "access_denied";
  if (status === 413) return "request_too_large";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "provider_unavailable";
  return "request_rejected";
}

export function transcriptionTransportFailure(
  error: unknown,
  signal?: AbortSignal,
): TranscriptionProviderRequestError {
  const cancelled = signal?.aborted === true ||
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError");
  return new TranscriptionProviderRequestError(
    cancelled ? "request_cancelled" : "transport_unavailable",
  );
}
