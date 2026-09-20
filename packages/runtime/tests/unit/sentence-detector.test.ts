import { describe, expect, test } from "bun:test";
import {
  SentenceDetector,
  parseVoiceTaggedText,
  splitAtIncompleteVoiceTag,
} from "../../src/utils/sentence-detector";

//  lead-coalescing (default-on in production) holds a short *opening*
// chunk and merges following text into it. Tests that exercise the raw
// splitting / min-length / streaming mechanics disable it with
// `leadMinChars: 0` so they assert the splitter in isolation; the dedicated
// "lead coalescing" block below covers the feature itself, and the
// idempotency tests keep the default to prove coalescing leaves them intact.
describe("SentenceDetector", () => {
  test("detects sentence ending with period followed by space", () => {
    const detector = new SentenceDetector({ partialTimeoutMs: 0, leadMinChars: 0 });
    detector.addToken("Hello world. ");
    detector.addToken("Next sentence.");
    const events = detector.drain();
    expect(events.length).toBe(1);
    expect(events[0]!.type).toBe("voice.sentence");
    expect(events[0]!.text).toBe("Hello world.");
    expect(events[0]!.index).toBe(0);
    expect(events[0]!.final).toBe(false);
  });

  test("detects exclamation and question marks", () => {
    const detector = new SentenceDetector({ partialTimeoutMs: 0, leadMinChars: 0 });
    detector.addToken("That is amazing! Is that real? It sure is. ");
    const events = detector.drain();
    expect(events.length).toBe(3);
    expect(events[0]!.text).toBe("That is amazing!");
    expect(events[1]!.text).toBe("Is that real?");
    expect(events[2]!.text).toBe("It sure is.");
  });

  test("increments sentence index for each sentence", () => {
    const detector = new SentenceDetector({ partialTimeoutMs: 0, leadMinChars: 0 });
    detector.addToken("First sentence. Second sentence. ");
    const events = detector.drain();
    expect(events[0]!.index).toBe(0);
    expect(events[1]!.index).toBe(1);
  });

  test("complete() flushes remaining buffer as final sentence", () => {
    const detector = new SentenceDetector({ partialTimeoutMs: 0, leadMinChars: 0 });
    detector.addToken("Hello world. This is partial");
    detector.drain();
    detector.complete();
    const events = detector.drain();
    expect(events.length).toBe(1);
    expect(events[0]!.text).toBe("This is partial");
    expect(events[0]!.final).toBe(true);
  });

  test("skips sentences shorter than minimum length", () => {
    const detector = new SentenceDetector({ partialTimeoutMs: 0, leadMinChars: 0 });
    detector.addToken("Hi. Hello world. ");
    const events = detector.drain();
    expect(events.length).toBe(1);
    expect(events[0]!.text).toBe("Hello world.");
  });

  test("handles streaming tokens one character at a time", () => {
    const detector = new SentenceDetector({ partialTimeoutMs: 0, leadMinChars: 0 });
    const text = "Hello world. Next one. ";
    for (const char of text) {
      detector.addToken(char);
    }
    const events = detector.drain();
    expect(events.length).toBe(2);
    expect(events[0]!.text).toBe("Hello world.");
    expect(events[1]!.text).toBe("Next one.");
  });

  test("does not split on period without trailing space", () => {
    const detector = new SentenceDetector({ partialTimeoutMs: 0, leadMinChars: 0 });
    detector.addToken("Visit example.com for details. ");
    const events = detector.drain();
    expect(events.length).toBe(1);
    expect(events[0]!.text).toBe("Visit example.com for details.");
  });

  test("reset clears all state", () => {
    const detector = new SentenceDetector({ partialTimeoutMs: 0, leadMinChars: 0 });
    detector.addToken("Hello world. ");
    detector.drain();
    detector.addToken("More text");
    detector.reset();
    detector.complete();
    const events = detector.drain();
    expect(events.length).toBe(0);
  });

  test("drain returns events and clears internal queue", () => {
    const detector = new SentenceDetector({ partialTimeoutMs: 0, leadMinChars: 0 });
    detector.addToken("Hello world. ");
    const first = detector.drain();
    expect(first.length).toBe(1);
    const second = detector.drain();
    expect(second.length).toBe(0);
  });

  test("complete() with empty buffer produces no events", () => {
    const detector = new SentenceDetector({ partialTimeoutMs: 0 });
    detector.complete();
    const events = detector.drain();
    expect(events.length).toBe(0);
  });

  test("multiple complete() calls are idempotent", () => {
    const detector = new SentenceDetector({ partialTimeoutMs: 0 });
    detector.addToken("Remaining text");
    detector.complete();
    detector.complete();
    const events = detector.drain();
    expect(events.length).toBe(1);
  });

  test("multilingual turn emits three fragments with per-span lang", () => {
    const agentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const roomId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const detector = new SentenceDetector({ partialTimeoutMs: 0, agentId, roomId });
    detector.addToken('Hello. <voice lang="es">¿Cómo estás?</voice> I asked in Spanish.');
    detector.complete();
    const events = detector.drain();
    expect(events.length).toBe(3);
    expect(events[0]!.text).toBe("Hello.");
    expect(events[0]!.lang).toBeUndefined();
    expect(events[0]!.agentId).toBe(agentId);
    expect(events.every((event) => event.roomId === roomId)).toBe(true);
    expect(events[1]!.text).toBe("¿Cómo estás?");
    expect(events[1]!.lang).toBe("es");
    expect(events[2]!.text).toBe("I asked in Spanish.");
    expect(events[2]!.lang).toBeUndefined();
    expect(events.every((e) => !e.text.includes("<voice"))).toBe(true);
  });

  test("survives token splits mid voice tag", () => {
    const detector = new SentenceDetector({ partialTimeoutMs: 0 });
    const parts = ["<voi", 'ce lang="es">', "Hola amigo.", "</voice>"];
    for (const part of parts) {
      detector.addToken(part);
    }
    detector.complete();
    const events = detector.drain();
    expect(events.some((e) => e.lang === "es" && e.text.includes("Hola amigo"))).toBe(true);
    expect(events.every((e) => !e.text.includes("<voice"))).toBe(true);
  });

  test("preserves an entirely tagged turn across every streaming boundary", () => {
    const body = "Synthetic English sentence one. Synthetic English sentence two.";
    const tagged = `<voice lang="en">${body}</voice>`;

    const assertTagged = (parts: string[]) => {
      const detector = new SentenceDetector({ partialTimeoutMs: 0 });
      for (const part of parts) detector.addToken(part);
      detector.complete();
      const events = detector.drain();

      expect(events.length).toBeGreaterThan(0);
      expect(events.map((event) => event.text).join(" ")).toBe(body);
      expect(events.every((event) => event.lang === "en")).toBe(true);
      expect(events.every((event) => !event.text.includes("<voice"))).toBe(true);
      expect(events.every((event) => !event.text.includes("</voice"))).toBe(true);
    };

    for (let split = 1; split < tagged.length; split += 1) {
      assertTagged([tagged.slice(0, split), tagged.slice(split)]);
    }
    assertTagged([...tagged]);
  });

  test("completed malformed tags remain literal instead of being held", () => {
    const detector = new SentenceDetector({ partialTimeoutMs: 0, leadMinChars: 0 });
    detector.addToken("Before <voice nope>literal content</voice> after. ");
    const events = detector.drain();

    expect(events).toHaveLength(1);
    expect(events[0]!.text).toContain("<voice nope>literal content</voice>");
    expect(events[0]!.lang).toBeUndefined();
  });

  test("nested voice tag stays literal", () => {
    const segments = parseVoiceTaggedText(
      '<voice lang="es">outer <voice lang="fr">inner</voice> end</voice>',
    );
    expect(segments.length).toBe(1);
    expect(segments[0]!.lang).toBe("es");
    expect(segments[0]!.text).toContain('<voice lang="fr">');
  });

  test("malformed voice tag is literal text", () => {
    const segments = parseVoiceTaggedText("before <voice>broken</voice> after");
    expect(segments.length).toBe(1);
    expect(segments[0]!.text).toContain("<voice>broken</voice>");
  });

  test("splitAtIncompleteVoiceTag holds partial open tag", () => {
    const { safe, hold } = splitAtIncompleteVoiceTag('Hi <voice lang="es');
    expect(safe).toBe("Hi ");
    expect(hold).toBe('<voice lang="es');
  });

  test("works with processStreamEvent integration pattern", () => {
    const detector = new SentenceDetector({ partialTimeoutMs: 0, leadMinChars: 0 });

    detector.addToken("The quick brown fox jumps. ");
    detector.addToken("Over the lazy dog. ");
    detector.addToken("The end");
    detector.complete();

    const events = detector.drain();
    expect(events.length).toBe(3);
    expect(events[0]!.text).toBe("The quick brown fox jumps.");
    expect(events[0]!.final).toBe(false);
    expect(events[1]!.text).toBe("Over the lazy dog.");
    expect(events[1]!.final).toBe(false);
    expect(events[2]!.text).toBe("The end");
    expect(events[2]!.final).toBe(true);
  });
});

describe("SentenceDetector —  lead coalescing", () => {
  test("merges a short opening sentence forward into the first chunk", () => {
    const detector = new SentenceDetector({ partialTimeoutMs: 0 });
    detector.addToken("Good idea. I'll go ahead and open up the file and take a look. ");
    const events = detector.drain();

    expect(events.length).toBe(1);
    expect(events[0]!.index).toBe(0);
    expect(events[0]!.text).toBe(
      "Good idea. I'll go ahead and open up the file and take a look.",
    );
  });

  test("does not coalesce a long opening sentence", () => {
    const detector = new SentenceDetector({ partialTimeoutMs: 0 });
    detector.addToken(
      "This is a sufficiently long opening sentence already. Next part here. ",
    );
    const events = detector.drain();

    expect(events.length).toBe(2);
    expect(events[0]!.text).toBe("This is a sufficiently long opening sentence already.");
    expect(events[0]!.index).toBe(0);
    expect(events[1]!.text).toBe("Next part here.");
    expect(events[1]!.index).toBe(1);
  });

  test("only the opener is coalesced; later short sentences stream normally", () => {
    const detector = new SentenceDetector({ partialTimeoutMs: 0 });
    // First chunk must clear the lead target, then short sentences flow.
    detector.addToken("Sure. Let me check the configuration for you now. ");
    detector.addToken("Yes. No. Maybe. ");
    const events = detector.drain();

    expect(events[0]!.text).toBe("Sure. Let me check the configuration for you now.");
    expect(events[0]!.index).toBe(0);
    // "Yes." / "No." / "Maybe." are each below MIN_SENTENCE_LENGTH and drop,
    // exactly as they would mid-stream — coalescing does not touch index > 0.
    expect(events.every((e) => e.index === 0 || e.text.length >= 6)).toBe(true);
  });

  test("never drops a whole-turn-short opener; flushes it at complete()", () => {
    const detector = new SentenceDetector({ partialTimeoutMs: 0 });
    detector.addToken("Good idea. ");
    detector.complete();
    const events = detector.drain();

    expect(events.length).toBe(1);
    expect(events[0]!.text).toBe("Good idea.");
    expect(events[0]!.index).toBe(0);
    expect(events[0]!.final).toBe(true);
  });

  test("preserves order and does not merge across a language boundary", () => {
    const agentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const detector = new SentenceDetector({ partialTimeoutMs: 0, agentId });
    // Short English opener, then a Spanish span — the held opener must flush
    // on its own rather than merge with the other-language text.
    detector.addToken('Hello. <voice lang="es">¿Cómo estás?</voice> Done. ');
    detector.complete();
    const events = detector.drain();

    expect(events[0]!.text).toBe("Hello.");
    expect(events[0]!.lang).toBeUndefined();
    expect(events[1]!.text).toBe("¿Cómo estás?");
    expect(events[1]!.lang).toBe("es");
    expect(events.every((e) => !e.text.includes("<voice"))).toBe(true);
  });
});

test("idle flush publishes parsed text without another token and preserves incomplete voice tags", async () => {
  const published: import("@nautilo/types").VoiceSentenceEvent[] = [];
  const detector = new SentenceDetector({ partialTimeoutMs: 5, leadMinChars: 0, onIdleEvents: events => published.push(...events) });
  detector.addToken('Hello there <voice lang="');
  await Bun.sleep(15);
  expect(published.map(event => event.text)).toEqual(["Hello there"]);
  expect(detector.drain()).toEqual([]);
  detector.addToken('es">Buenos días.</voice>'); detector.complete();
  expect(detector.drain().map(event => [event.text, event.lang])).toEqual([["Buenos días.", "es"]]);
  detector.reset();
});
test("reset cancels idle publication and held short openers flush without later text", async () => {
  const published: import("@nautilo/types").VoiceSentenceEvent[] = [];
  const detector = new SentenceDetector({ partialTimeoutMs: 5, onIdleEvents: events => published.push(...events) });
  detector.addToken("Okay. "); await Bun.sleep(15);
  expect(published.map(event => event.text)).toEqual(["Okay."]);
  detector.addToken("This must never escape after cancellation"); detector.reset(); await Bun.sleep(15);
  expect(published).toHaveLength(1);
});
