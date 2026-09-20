import { expect, test } from "bun:test";
import { splitSpeechText } from "../../src/realtime/speech-text";
test("provider-sized chunks preserve all Unicode text and prefer word boundaries", () => {
  const text = "Hello 🌊. A longer sentence. ".repeat(300);
  const chunks = splitSpeechText(text, 2000);
  expect(chunks.join("")).toBe(text);
  expect(chunks.every(chunk => Array.from(chunk).length <= 2000)).toBe(true);
  expect(chunks[0]!.endsWith(" ")).toBe(true);
  expect(splitSpeechText("🌊".repeat(9), 2).join("")).toBe("🌊".repeat(9));
});
