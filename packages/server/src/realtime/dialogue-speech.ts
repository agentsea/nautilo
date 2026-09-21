
export interface DialogueSpeechRequest {
  text: string;
  voiceId: string;
  model: string;
  format: "pcm_24000" | "mp3_44100_128";
  apiKey: string;
  signal: AbortSignal;
  onSubmitted(): void;
}

/** HTTP streaming preserves receiver backpressure on supported Bun runtimes. */
export async function dialogueSpeechResponse(
  request: DialogueSpeechRequest,
  requestFetch: (input: URL, init: RequestInit) => Promise<Response> = fetch,
): Promise<Response> {
  request.signal.throwIfAborted();
  const url = new URL("https://api.elevenlabs.io/v1/text-to-dialogue/stream");
  url.searchParams.set("output_format", request.format);
  request.onSubmitted();
  return requestFetch(url, {
    method: "POST",
    headers: { "xi-api-key": request.apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      inputs: [{ text: request.text, voice_id: request.voiceId }],
      model_id: request.model,
      settings: { stability: 0.5 },
    }),
    signal: request.signal,
  });
}
