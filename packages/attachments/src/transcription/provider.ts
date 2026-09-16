export type TranscriptionProviderId = "groq" | "openai" | "whisper-cpp" | "elevenlabs";

export type TranscriptionInput = {
  bytes: Uint8Array;
  filename: string;
  mime: string;
  language?: string;
  timestamps?: boolean;
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
