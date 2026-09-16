import type { TranscriptionInput, TranscriptionProvider, TranscriptionResult } from "./provider";

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
      throw new Error("GROQ_API_KEY is not configured");
    }

    const form = new FormData();
    form.append("model", GROQ_TRANSCRIPTION_MODEL);
    form.append(
      "file",
      new Blob([input.bytes], { type: input.mime }),
      input.filename,
    );
    if (input.language) {
      form.append("language", input.language);
    }
    if (input.timestamps) {
      form.append("response_format", "verbose_json");
      form.append("timestamp_granularities[]", "segment");
    }

    const response = await this.fetchImpl(GROQ_TRANSCRIPTION_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
      },
      body: form,
    });

    if (!response.ok) {
      // Body may be missing or non-UTF8; ignore stream errors so we still surface HTTP status.
      const detail = await response.text().catch(() => "");
      throw new Error(`Groq transcription failed: HTTP ${response.status}${detail ? ` ${detail.slice(0, 200)}` : ""}`);
    }

    const result = (await response.json()) as { text?: unknown };
    return {
      text: typeof result.text === "string" ? result.text : "",
      provider: "groq",
      model: GROQ_TRANSCRIPTION_MODEL,
    };
  }
}
