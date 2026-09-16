import { ElevenLabsTranscriptionProvider } from "./elevenlabs";
import { GroqTranscriptionProvider } from "./groq";
import type { TranscriptionProvider } from "./provider";

/**
 * Returns the first configured hosted STT provider: ElevenLabs if `ELEVENLABS_API_KEY` is set,
 * otherwise Groq if `GROQ_API_KEY` is set (same key as TTS — avoids invalid Groq blocking STT).
 */
export function createConfiguredTranscriptionProvider(): TranscriptionProvider | null {
  const elevenKey = process.env["ELEVENLABS_API_KEY"]?.trim();
  if (elevenKey) {
    return new ElevenLabsTranscriptionProvider(elevenKey);
  }
  const groqKey = process.env["GROQ_API_KEY"]?.trim();
  if (groqKey) {
    return new GroqTranscriptionProvider(groqKey);
  }
  return null;
}
