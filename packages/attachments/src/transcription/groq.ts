import {
  TranscriptionProviderRequestError,
  transcriptionProviderFailureForStatus,
  transcriptionTransportFailure,
  type TranscriptionInput,
  type TranscriptionProvider,
  type TranscriptionResult,
} from "./provider";

const GROQ_TRANSCRIPTION_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
export const GROQ_TRANSCRIPTION_MODEL = "whisper-large-v3-turbo";

export class GroqTranscriptionProvider implements TranscriptionProvider {
  readonly id = "groq" as const;

  constructor(
    private readonly apiKey: string | undefined = process.env["GROQ_API_KEY"]?.trim(),
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  available(): Promise<boolean> {
    return Promise.resolve(!!this.apiKey);
  }

  async transcribe(input: TranscriptionInput): Promise<TranscriptionResult> {
    if (!this.apiKey) {
      throw new TranscriptionProviderRequestError("authentication_failed");
    }

    const form = new FormData();
    form.append("model", GROQ_TRANSCRIPTION_MODEL);
    form.append(
      "file",
      new Blob([input.bytes as Uint8Array<ArrayBuffer>], { type: input.mime }),
      input.filename,
    );
    if (input.language) {
      form.append("language", input.language);
    }
    if (input.timestamps) {
      form.append("response_format", "verbose_json");
      form.append("timestamp_granularities[]", "segment");
    }

    let response: Response;
    try {
      response = await this.fetchImpl(GROQ_TRANSCRIPTION_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
        },
        body: form,
        ...(input.signal ? { signal: input.signal } : {}),
      });
    } catch (error) {
      throw transcriptionTransportFailure(error, input.signal);
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new TranscriptionProviderRequestError(
        transcriptionProviderFailureForStatus(response.status),
        response.status,
      );
    }

    let result: { text?: unknown };
    try {
      result = (await response.json()) as { text?: unknown };
    } catch {
      throw new TranscriptionProviderRequestError("invalid_response", response.status);
    }
    if (typeof result.text !== "string") {
      throw new TranscriptionProviderRequestError("invalid_response", response.status);
    }
    return {
      text: result.text,
      provider: "groq",
      model: GROQ_TRANSCRIPTION_MODEL,
    };
  }
}
