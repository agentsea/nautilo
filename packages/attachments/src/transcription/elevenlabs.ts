import type { TranscriptionInput, TranscriptionProvider, TranscriptionResult } from "./provider";

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
      throw new Error("ELEVENLABS_API_KEY is not configured");
    }

    const form = new FormData();
    form.append(
      "file",
      new Blob([input.bytes as Uint8Array<ArrayBuffer>], { type: input.mime }),
      input.filename,
    );
    form.append("model_id", ELEVENLABS_STT_MODEL);

    const response = await this.fetchImpl(ELEVENLABS_STT_URL, {
      method: "POST",
      headers: {
        "xi-api-key": this.apiKey,
      },
      body: form,
    });

    if (!response.ok) {
      // Body may be missing or non-UTF8; ignore stream errors so we still surface HTTP status.
      const detail = await response.text().catch(() => "");
      throw new Error(
        `ElevenLabs transcription failed: HTTP ${response.status}${detail ? ` ${detail.slice(0, 200)}` : ""}`,
      );
    }

    const result = (await response.json()) as { text?: unknown };
    return {
      text: typeof result.text === "string" ? result.text : "",
      provider: "elevenlabs",
      model: ELEVENLABS_STT_MODEL,
    };
  }
}
