import { describe, expect, test } from "bun:test";
import {
  MESSAGE_PAYLOAD_FORMAT_VERSION_V2,
  MESSAGE_PAYLOAD_MAX_ATTACHMENTS_V2,
  MESSAGE_PAYLOAD_MAX_BYTES_V2,
  decodeMessagePayloadV2,
  encodeMessagePayloadV2,
  type MessagePayloadV2,
} from "../../src/index.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function completePayload(): MessagePayloadV2 {
  return {
    role: "assistant",
    content: "Done — the report is ready.",
    toolCalls: [
      {
        id: "call_01",
        name: "write_report",
        args: {
          title: "Quarterly report",
          sections: ["summary", "results"],
          dryRun: false,
          confidence: 0.75,
        },
      },
    ],
    toolName: "write_report",
    sensitiveMetadata: {
      provider: "private-provider",
      nested: { attempts: 2, nullable: null },
    },
    attachmentRefs: [
      {
        kind: "message_attachment",
        referenceId: "7c29c527-98e4-47ab-ab10-f79dcc411ca4",
        name: "private-results.pdf",
        mimeType: "application/pdf",
        sizeBytes: 4_096,
        caption: "The private report",
      },
      {
        kind: "artifact",
        referenceId: "c53a21a6-1011-4d7a-8756-76c93129dbbf",
        name: "analysis.md",
        mimeType: "text/markdown",
        sizeBytes: 2_048,
      },
    ],
  };
}

describe("MessagePayloadV2 canonical codec", () => {
  test.each(["user", "assistant", "tool", "system"] as const)(
    "keeps %s content confidential without role-based inference",
    (role) => {
      const payload: MessagePayloadV2 = {
        role,
        content: `${role}-secret`,
      };
      expect(decodeMessagePayloadV2(
        encodeMessagePayloadV2(payload),
      )).toEqual(payload);
    },
  );

  test("round-trips every confidential message family through canonical bytes", () => {
    const payload = completePayload();
    const bytes = encodeMessagePayloadV2(payload);
    const wire = decoder.decode(bytes);

    expect(bytes.length).toBeLessThanOrEqual(MESSAGE_PAYLOAD_MAX_BYTES_V2);
    expect(wire).toStartWith(
      `{"attachmentRefs":[{"caption":"The private report"`,
    );
    expect(wire).toContain(
      `"payloadVersion":${MESSAGE_PAYLOAD_FORMAT_VERSION_V2}`,
    );
    expect(decodeMessagePayloadV2(bytes)).toEqual(payload);
    expect(Object.isFrozen(decodeMessagePayloadV2(bytes))).toBe(true);
  });

  test("is deterministic across object insertion order", () => {
    const left = completePayload();
    const right: MessagePayloadV2 = {
      sensitiveMetadata: {
        nested: { nullable: null, attempts: 2 },
        provider: "private-provider",
      },
      attachmentRefs: left.attachmentRefs!,
      toolName: left.toolName!,
      toolCalls: left.toolCalls!,
      content: left.content,
      role: left.role,
    };

    expect(encodeMessagePayloadV2(left)).toEqual(
      encodeMessagePayloadV2(right),
    );
  });

  test.each([
    [
      "unknown top-level field",
      `{"content":"hello","payloadVersion":2,"role":"user","surprise":true}`,
    ],
    [
      "unsupported version",
      `{"content":"hello","payloadVersion":3,"role":"user"}`,
    ],
    [
      "non-canonical whitespace",
      `{"content":"hello", "payloadVersion":2,"role":"user"}`,
    ],
    [
      "non-canonical field order",
      `{"role":"user","payloadVersion":2,"content":"hello"}`,
    ],
    [
      "duplicate key",
      `{"content":"hello","content":"again","payloadVersion":2,"role":"user"}`,
    ],
    [
      "malformed tool arguments",
      `{"content":"","payloadVersion":2,"role":"assistant","toolCalls":[{"args":"not-an-object","name":"tool"}]}`,
    ],
    [
      "unknown tool-call field",
      `{"content":"","payloadVersion":2,"role":"assistant","toolCalls":[{"args":{},"name":"tool","providerData":"leak"}]}`,
    ],
    [
      "unknown attachment field",
      `{"attachmentRefs":[{"kind":"artifact","name":"x","referenceId":"artifact-1","secret":"leak","sizeBytes":1}],"content":"","payloadVersion":2,"role":"user"}`,
    ],
  ])("rejects %s", (_label, wire) => {
    expect(() => decodeMessagePayloadV2(encoder.encode(wire))).toThrow();
  });

  test("rejects duplicate tool-call identities and invalid JSON values", () => {
    const duplicateToolIds: MessagePayloadV2 = {
      role: "assistant",
      content: "",
      toolCalls: [
        { id: "same", name: "first", args: {} },
        { id: "same", name: "second", args: {} },
      ],
    };
    expect(() => encodeMessagePayloadV2(duplicateToolIds)).toThrow(
      /duplicate/i,
    );

    expect(() =>
      encodeMessagePayloadV2({
        role: "system",
        content: "secret",
        sensitiveMetadata: { invalid: Number.NaN },
      })
    ).toThrow();

    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    expect(() =>
      encodeMessagePayloadV2({
        role: "user",
        content: "",
        sensitiveMetadata: cyclic as never,
      })
    ).toThrow();

    const sparse: unknown[] = [];
    sparse.length = 2;
    sparse[1] = "present";
    expect(() =>
      encodeMessagePayloadV2({
        role: "system",
        content: "",
        sensitiveMetadata: { sparse } as never,
      })
    ).toThrow(/holes/i);

    const getterMetadata = {};
    Object.defineProperty(getterMetadata, "secret", {
      enumerable: true,
      get: () => "must-not-run",
    });
    expect(() =>
      encodeMessagePayloadV2({
        role: "system",
        content: "",
        sensitiveMetadata: getterMetadata as never,
      })
    ).toThrow(/non-data/i);
  });

  test("enforces aggregate, collection, and Unicode bounds before encryption", () => {
    expect(() =>
      encodeMessagePayloadV2({
        role: "user",
        content: "x".repeat(MESSAGE_PAYLOAD_MAX_BYTES_V2 + 1),
      })
    ).toThrow();

    expect(() =>
      encodeMessagePayloadV2({
        role: "user",
        content: "",
        attachmentRefs: Array.from(
          { length: MESSAGE_PAYLOAD_MAX_ATTACHMENTS_V2 + 1 },
          (_, index) => ({
            kind: "message_attachment" as const,
            referenceId: `attachment-${index}`,
            name: "file.txt",
            mimeType: "text/plain",
            sizeBytes: 1,
          }),
        ),
      })
    ).toThrow();

    expect(() =>
      encodeMessagePayloadV2({
        role: "user",
        content: "\ud800",
      })
    ).toThrow(/Unicode/i);

    expect(() =>
      encodeMessagePayloadV2({
        role: "user",
        content: "\u0000".repeat(180_000),
      })
    ).toThrow(/bounds/i);

    expect(() =>
      encodeMessagePayloadV2({
        role: "user",
        content: "",
        sensitiveMetadata: {
          repeated: Array.from(
            { length: 4_093 },
            () => "x".repeat(300),
          ),
        },
      })
    ).toThrow(/aggregate|bounds/i);
  });

  test("rejects collection-owned fields and accessors without invoking them", () => {
    const toolCalls = [
      { id: "call-1", name: "tool", args: {} },
    ] as Array<{ id: string; name: string; args: Record<string, never> }> & {
      surprise?: string;
    };
    toolCalls.surprise = "must-not-be-dropped";
    expect(() =>
      encodeMessagePayloadV2({
        role: "assistant",
        content: "",
        toolCalls,
      })
    ).toThrow(/extra field/i);

    let attachmentGetterCalled = false;
    const attachmentRefs = new Array(1);
    Object.defineProperty(attachmentRefs, "0", {
      enumerable: true,
      get() {
        attachmentGetterCalled = true;
        return {
          kind: "artifact",
          referenceId: "artifact-1",
          name: "secret.txt",
          sizeBytes: 1,
        };
      },
    });
    expect(() =>
      encodeMessagePayloadV2({
        role: "user",
        content: "",
        attachmentRefs,
      })
    ).toThrow(/non-data/i);
    expect(attachmentGetterCalled).toBe(false);
  });

  test("returns owned immutable values rather than retaining caller aliases", () => {
    const metadata = { nested: { value: "initial" } };
    const payload: MessagePayloadV2 = {
      role: "user",
      content: "hello",
      sensitiveMetadata: metadata,
    };
    const bytes = encodeMessagePayloadV2(payload);
    metadata.nested.value = "mutated";

    const decoded = decodeMessagePayloadV2(bytes);
    expect(decoded.sensitiveMetadata).toEqual({
      nested: { value: "initial" },
    });
    expect(Object.isFrozen(decoded.sensitiveMetadata)).toBe(true);
    expect(
      Object.isFrozen(
        (decoded.sensitiveMetadata?.["nested"] as Record<string, unknown>),
      ),
    ).toBe(true);
  });

  test("treats prototype-shaped metadata keys as data, never object authority", () => {
    const metadata = Object.create(null) as Record<string, unknown>;
    metadata["__proto__"] = { polluted: true };
    const decoded = decodeMessagePayloadV2(
      encodeMessagePayloadV2({
        role: "system",
        content: "",
        sensitiveMetadata: metadata as never,
      }),
    );

    expect(decoded.sensitiveMetadata?.["__proto__"]).toEqual({
      polluted: true,
    });
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });
});
