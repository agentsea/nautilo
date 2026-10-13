import {
  TranscriptionProviderRequestError,
  transcriptionProviderFailureForStatus,
  transcriptionTransportFailure,
  type TranscriptionInput,
  type TranscriptionProvider,
  type TranscriptionResult,
} from "./provider";

const ELEVENLABS_STT_URL = "https://api.elevenlabs.io/v1/speech-to-text";
/** ElevenLabs Speech-to-Text model id (matches legacy `/api/stt` wiring). */
export const ELEVENLABS_STT_MODEL = "scribe_v2";

export class ElevenLabsTranscriptionProvider implements TranscriptionProvider {
  readonly id = "elevenlabs" as const;

  constructor(
    private readonly apiKey: string | undefined = process.env["ELEVENLABS_API_KEY"]?.trim(),
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
    form.append(
      "file",
      new Blob([input.bytes as Uint8Array<ArrayBuffer>], { type: input.mime }),
      input.filename,
    );
    form.append("model_id", ELEVENLABS_STT_MODEL);

    let response: Response;
    try {
      response = await this.fetchImpl(ELEVENLABS_STT_URL, {
        method: "POST",
        headers: {
          "xi-api-key": this.apiKey,
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
      provider: "elevenlabs",
      model: ELEVENLABS_STT_MODEL,
    };
  }
}
