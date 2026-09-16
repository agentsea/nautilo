import { describe, expect, test } from "bun:test";
import {
  countCodePoints,
  EVENT_STATEMENT_MAX_CHARS,
  projectStenographerEvidence as projectReflectionEvidence,
  ROOM_EVENT_KINDS,
  validateStenographerOutput as validateReflectionOutput,
  validateStenographerOutputWithRepair as validateReflectionOutputWithRepair,
  type StenographerEvidenceRow as ReflectionEvidenceRow,
  type StenographerProposal,
} from "@nautilo/reflection";
import {
  mapStenographerProposal,
  type ProposalMappingContext,
} from "../../src/stenographer";

interface StenographerEvidenceRow extends ReflectionEvidenceRow {
  messageId: number;
}

type StenographerValidationContext = ProposalMappingContext;

function projectStenographerEvidence(input: {
  rows: readonly StenographerEvidenceRow[];
  priorRows?: readonly Omit<ReflectionEvidenceRow, "conversationalBoundary">[];
  journalContext?: string;
  inputMaxCodePoints?: number;
}) {
  const projected = projectReflectionEvidence({
    rows: input.rows.map(({ messageId: _messageId, ...row }) => row),
    ...(input.priorRows ? { priorRows: input.priorRows } : {}),
    ...(input.journalContext ? { journalContext: input.journalContext } : {}),
    ...(input.inputMaxCodePoints !== undefined
      ? { inputMaxCodePoints: input.inputMaxCodePoints }
      : {}),
  });
  if (!projected.ok) return projected;
  return {
    ...projected,
    visibleReferences: projected.visibleReferences.map((reference) => ({
      localReference: reference.localReference,
      messageId: input.rows[reference.sourcePosition]!.messageId,
    })),
  };
}

function semanticContext(context: StenographerValidationContext) {
  return {
    visibleSourceReferences: context.visibleSourceReferences.map(
      (reference) => reference.localReference,
    ),
    visibleEventReferences: context.visibleEventReferences.map((event) => ({
      localReference: event.localReference,
      active: event.active,
    })),
  };
}

function mapProposal(
  proposal: StenographerProposal,
  context: StenographerValidationContext,
) {
  const mapped = mapStenographerProposal(proposal, context);
  return mapped.ok
    ? { ok: true as const, output: mapped.output }
    : {
        ok: false as const,
        errorCode: "invalid_output" as const,
        reason: mapped.reason,
      };
}

function validateStenographerOutput(
  response: unknown,
  context: StenographerValidationContext,
) {
  const validated = validateReflectionOutput(response, semanticContext(context));
  return validated.ok
    ? mapProposal(validated.proposal, context)
    : validated;
}

async function validateStenographerOutputWithRepair(input: {
  initialResponse: unknown;
  context: StenographerValidationContext;
  repair: (
    invalidResponse: unknown,
    failure: { readonly reason: string },
  ) => Promise<unknown>;
}) {
  const validated = await validateReflectionOutputWithRepair({
    initialResponse: input.initialResponse,
    context: semanticContext(input.context),
    validateProposal: (proposal) => {
      const mapped = mapStenographerProposal(proposal, input.context);
      return mapped.ok ? { ok: true } : mapped;
    },
    repair: input.repair,
  });
  if (!validated.ok) return validated;
  return {
    ...mapProposal(validated.proposal, input.context),
    attempts: validated.attempts,
  };
}

const TS = new Date("2026-07-27T12:00:00.000Z");

function evidence(
  messageId: number,
  overrides: Partial<StenographerEvidenceRow> = {},
): StenographerEvidenceRow {
  return {
    messageId,
    createdAt: new Date(TS.getTime() + messageId),
    role: "user",
    displayLabel: "Human: Casey",
    text: `message ${messageId}`,
    conversationalBoundary: true,
    ...overrides,
  };
}

describe("projectStenographerEvidence", () => {
  test("short source rows are unchanged", () => {
    const projected = projectStenographerEvidence({ rows: [evidence(10)] });
    expect(projected.ok).toBe(true);
    if (!projected.ok) return;
    expect(projected.prompt).toContain("message 10");
    expect(projected.visibleReferences).toEqual([
      { localReference: "M1", messageId: 10 },
    ]);
  });

  test("long rows keep head and tail with the exact marker", () => {
    const text = `HEAD${"x".repeat(20_000)}TAIL`;
    const projected = projectStenographerEvidence({
      rows: [evidence(1, { text })],
    });
    expect(projected.ok).toBe(true);
    if (!projected.ok) return;
    expect(projected.prompt).toContain("HEAD");
    expect(projected.prompt).toContain("TAIL");
    expect(projected.prompt).toContain("[... evidence elided ...]");
    expect(projected.prompt).not.toContain("x".repeat(12_001));
    expect(
      countCodePoints(projected.prompt.split("\n\n").at(-1)!),
    ).toBeLessThanOrEqual(12_000);
  });

  test("per-row and total limits count emoji as code points", () => {
    const projected = projectStenographerEvidence({
      rows: [evidence(1, { text: "😀".repeat(20_000) })],
    });
    expect(projected.ok).toBe(true);
    if (!projected.ok) return;
    expect(projected.codePoints).toBeLessThanOrEqual(80_000);
    expect(countCodePoints(projected.prompt)).toBe(projected.codePoints);
  });

  test("all conversational boundaries survive while excess tools become markers", () => {
    const rows = [
      evidence(1, { text: "first boundary" }),
      evidence(2, {
        role: "tool",
        text: "x".repeat(20_000),
        conversationalBoundary: false,
      }),
      evidence(3, {
        role: "tool",
        text: "y".repeat(20_000),
        conversationalBoundary: false,
      }),
      evidence(4, { text: "second boundary" }),
    ];
    const minimum = projectStenographerEvidence({
      rows: [rows[0]!, rows[3]!],
    });
    expect(minimum.ok).toBe(true);
    if (!minimum.ok) return;
    const projected = projectStenographerEvidence({
      rows,
      inputMaxCodePoints: minimum.codePoints + 120,
    });
    expect(projected.ok).toBe(true);
    if (!projected.ok) return;
    expect(projected.prompt).toContain("first boundary");
    expect(projected.prompt).toContain("second boundary");
    expect(projected.prompt).toContain("omitted (source positions 2-3)");
    expect(projected.omittedToolRowCount).toBe(2);
  });

  test("tools nearest boundaries are selected first with stable local references", () => {
    const rows = [
      evidence(1),
      evidence(2, {
        role: "tool",
        text: "near".repeat(100),
        conversationalBoundary: false,
      }),
      evidence(3, {
        role: "tool",
        text: "far".repeat(2_000),
        conversationalBoundary: false,
      }),
      evidence(4),
    ];
    const baseline = projectStenographerEvidence({
      rows: [rows[0]!, rows[3]!],
    });
    expect(baseline.ok).toBe(true);
    if (!baseline.ok) return;
    const projected = projectStenographerEvidence({
      rows,
      inputMaxCodePoints: baseline.codePoints + 1_000,
    });
    expect(projected.ok).toBe(true);
    if (!projected.ok) return;
    expect(projected.visibleReferences).toContainEqual({
      localReference: "M2",
      messageId: 2,
    });
    expect(projected.visibleReferences).not.toContainEqual({
      localReference: "M3",
      messageId: 3,
    });
  });

  test("raw UUIDs are redacted from labels, evidence, and journal text", () => {
    const uuid = "7b6cd9ec-471a-4fd7-9277-4fc40598f6d8";
    const projected = projectStenographerEvidence({
      journalContext: `room ${uuid}`,
      rows: [
        evidence(1, {
          displayLabel: uuid,
          text: `actor ${uuid}`,
        }),
      ],
    });
    expect(projected.ok).toBe(true);
    if (!projected.ok) return;
    expect(projected.prompt).not.toContain(uuid);
    expect(projected.prompt).toContain("[uuid redacted]");
  });

  test("labels prior context separately and never exposes P rows as citable references", () => {
    const projected = projectStenographerEvidence({
      priorRows: [{
        createdAt: new Date(TS.getTime() - 1),
        role: "assistant",
        displayLabel: "Agent: Ada",
        text: "Previously established constraint.",
      }],
      rows: [evidence(10, { text: "New durable decision." })],
    });
    expect(projected.ok).toBe(true);
    if (!projected.ok) return;
    expect(projected.prompt).toContain(
      "[PRIOR CONTEXT — already processed; interpretation only; never cite P references]",
    );
    expect(projected.prompt).toContain(
      "[NEW EVIDENCE — only these M references may support new operations]",
    );
    expect(projected.prompt.indexOf("Previously established constraint.")).toBeLessThan(
      projected.prompt.indexOf("New durable decision."),
    );
    expect(projected.prompt).toContain("P1");
    expect(projected.visibleReferences).toEqual([
      { localReference: "M1", messageId: 10 },
    ]);
  });

  test("budget keeps new evidence before prior context and prefers newest prior rows", () => {
    const newOnly = projectStenographerEvidence({
      rows: [evidence(10, { text: "New evidence must survive." })],
    });
    expect(newOnly.ok).toBe(true);
    if (!newOnly.ok) return;
    const projected = projectStenographerEvidence({
      priorRows: [
        {
          createdAt: new Date(TS.getTime() - 2),
          role: "user",
          displayLabel: "Human: Casey",
          text: `oldest-prior-${"a".repeat(500)}`,
        },
        {
          createdAt: new Date(TS.getTime() - 1),
          role: "assistant",
          displayLabel: "Agent: Ada",
          text: `newest-prior-${"b".repeat(500)}`,
        },
      ],
      rows: [evidence(10, { text: "New evidence must survive." })],
      inputMaxCodePoints: newOnly.codePoints + 750,
    });
    expect(projected.ok).toBe(true);
    if (!projected.ok) return;
    expect(projected.prompt).toContain("New evidence must survive.");
    expect(projected.prompt).toContain("newest-prior-");
    expect(projected.prompt).not.toContain("oldest-prior-");
    expect(projected.omittedPriorContextRowCount).toBe(1);
  });

  test("irreducibly oversized framing fails with input_too_large", () => {
    const projected = projectStenographerEvidence({
      rows: [evidence(1, { text: "required boundary" })],
      inputMaxCodePoints: 10,
    });
    expect(projected).toMatchObject({
      ok: false,
      errorCode: "input_too_large",
    });
  });
});

const validationContext: StenographerValidationContext = {
  roomId: "room-a",
  fromMessageIdExclusive: 10,
  throughMessageIdInclusive: 30,
  visibleSourceReferences: [
    { localReference: "M1", messageId: 20, roomId: "room-a" },
    { localReference: "M2", messageId: 25, roomId: "room-a" },
  ],
  visibleEventReferences: [
    {
      localReference: "E1",
      eventSequence: 7,
      roomId: "room-a",
      active: true,
    },
  ],
};

function append(statement = "A supported fact") {
  return {
    operations: [
      {
        op: "append",
        kind: "fact",
        statement,
        sourceMessageIds: ["M2", "M1"],
      },
    ],
  };
}

describe("validateStenographerOutput", () => {
  test("accepts zero operations", () => {
    expect(
      validateStenographerOutput({ operations: [] }, validationContext),
    ).toEqual({ ok: true, output: { operations: [] } });
  });

  test.each([...ROOM_EVENT_KINDS])("accepts append kind %s", (kind) => {
    const result = validateStenographerOutput(
      {
        operations: [
          {
            op: "append",
            kind,
            statement: "supported",
            sourceMessageIds: ["M1"],
          },
        ],
      },
      validationContext,
    );
    expect(result.ok).toBe(true);
  });

  test("rejects more than one transition of the same active event", () => {
    const result = validateStenographerOutput(
      {
        operations: [
          {
            op: "supersede",
            eventSequence: "E1",
            kind: "decision",
            statement: "The replacement",
            sourceMessageIds: ["M1"],
          },
          {
            op: "resolve",
            eventSequence: "E1",
            statement: "The question was answered",
            sourceMessageIds: ["M2"],
          },
        ],
      },
      validationContext,
    );
    expect(result).toMatchObject({ ok: false, reason: "event_reused" });
  });

  test("repairs a proposal that transitions one event twice", async () => {
    let repairs = 0;
    const result = await validateStenographerOutputWithRepair({
      initialResponse: {
        operations: [
          {
            op: "supersede",
            eventSequence: "E1",
            kind: "decision",
            statement: "The replacement",
            sourceMessageIds: ["M1"],
          },
          {
            op: "resolve",
            eventSequence: "E1",
            statement: "The question was answered",
            sourceMessageIds: ["M2"],
          },
        ],
      },
      context: validationContext,
      repair: async (_response, failure) => {
        repairs += 1;
        expect(failure.reason).toBe("event_reused");
        return {
          operations: [{
            op: "supersede",
            eventSequence: "E1",
            kind: "decision",
            statement: "The replacement",
            sourceMessageIds: ["M1", "M2"],
          }],
        };
      },
    });
    expect(repairs).toBe(1);
    expect(result).toMatchObject({ ok: true, attempts: 2 });
  });

  test("canonicalizes source IDs to ascending DB IDs", () => {
    const result = validateStenographerOutput(
      append(),
      validationContext,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.output.operations[0]?.sourceMessageIds).toEqual([20, 25]);
  });

  test.each([
    ["unknown top-level field", { ...append(), surprise: true }],
    [
      "unknown operation field",
      {
        operations: [
          {
            ...append().operations[0],
            surprise: true,
          },
        ],
      },
    ],
    [
      "unknown kind",
      {
        operations: [{ ...append().operations[0], kind: "weather" }],
      },
    ],
    [
      "unknown op",
      {
        operations: [{ ...append().operations[0], op: "delete" }],
      },
    ],
    ["free-form text", "please record this"],
  ])("rejects %s", (_label, output) => {
    expect(validateStenographerOutput(output, validationContext).ok).toBe(false);
  });

  test("rejects a sixth operation", () => {
    expect(
      validateStenographerOutput(
        {
          operations: Array.from({ length: 6 }, () => append().operations[0]),
        },
        validationContext,
      ).ok,
    ).toBe(false);
  });

  test("uses exact Unicode statement boundaries", () => {
    expect(
      validateStenographerOutput(
        append("😀".repeat(EVENT_STATEMENT_MAX_CHARS)),
        validationContext,
      ).ok,
    ).toBe(true);
    expect(
      validateStenographerOutput(
        append("😀".repeat(EVENT_STATEMENT_MAX_CHARS + 1)),
        validationContext,
      ),
    ).toMatchObject({ ok: false, reason: "statement" });
    expect(
      validateStenographerOutput(append(" \n "), validationContext),
    ).toMatchObject({ ok: false, reason: "statement" });
  });

  test.each([
    ["empty", []],
    ["duplicate", ["M1", "M1"]],
    [
      "seventeenth",
      Array.from({ length: 17 }, (_, index) => `M${index + 1}`),
    ],
    ["malformed", ["M0"]],
    ["not visible", ["M99"]],
  ])("rejects %s source references", (_label, sourceMessageIds) => {
    const result = validateStenographerOutput(
      {
        operations: [
          {
            ...append().operations[0],
            sourceMessageIds,
          },
        ],
      },
      validationContext,
    );
    expect(result.ok).toBe(false);
  });

  test("rejects cross-Room and out-of-batch visible sources", () => {
    const crossRoom = {
      ...validationContext,
      visibleSourceReferences: [
        { localReference: "M1", messageId: 20, roomId: "room-b" },
      ],
    };
    expect(
      validateStenographerOutput(
        {
          operations: [
            { ...append().operations[0], sourceMessageIds: ["M1"] },
          ],
        },
        crossRoom,
      ),
    ).toMatchObject({ ok: false, reason: "source_cross_room" });

    const outside = {
      ...validationContext,
      visibleSourceReferences: [
        { localReference: "M1", messageId: 31, roomId: "room-a" },
      ],
    };
    expect(
      validateStenographerOutput(
        {
          operations: [
            { ...append().operations[0], sourceMessageIds: ["M1"] },
          ],
        },
        outside,
      ),
    ).toMatchObject({ ok: false, reason: "source_out_of_batch" });
  });

  test("rejects distinct local references that map to one DB source ID", () => {
    expect(
      validateStenographerOutput(append(), {
        ...validationContext,
        visibleSourceReferences: [
          { localReference: "M1", messageId: 20, roomId: "room-a" },
          { localReference: "M2", messageId: 20, roomId: "room-a" },
        ],
      }),
    ).toMatchObject({ ok: false, reason: "duplicate_source" });
  });

  test("only individually visible active Room events are addressable", () => {
    const operation = {
      operations: [
        {
          op: "resolve",
          eventSequence: "E2",
          statement: "resolved",
          sourceMessageIds: ["M1"],
        },
      ],
    };
    expect(
      validateStenographerOutput(operation, validationContext),
    ).toMatchObject({ ok: false, reason: "event_not_visible" });

    expect(
      validateStenographerOutput(
        {
          ...operation,
          operations: [
            { ...operation.operations[0], eventSequence: "E1" },
          ],
        },
        {
          ...validationContext,
          visibleEventReferences: [
            { ...validationContext.visibleEventReferences[0]!, active: false },
          ],
        },
      ),
    ).toMatchObject({ ok: false, reason: "event_not_active" });
  });

  test("repair is attempted exactly once and the second invalid output fails closed", async () => {
    let repairs = 0;
    const result = await validateStenographerOutputWithRepair({
      initialResponse: "not json",
      context: validationContext,
      repair: async () => {
        repairs += 1;
        return { operations: "still invalid" };
      },
    });
    expect(repairs).toBe(1);
    expect(result).toMatchObject({ ok: false, attempts: 2 });
  });

  test("a valid initial response does not invoke repair", async () => {
    let repairs = 0;
    const result = await validateStenographerOutputWithRepair({
      initialResponse: append(),
      context: validationContext,
      repair: async () => {
        repairs += 1;
        return append();
      },
    });
    expect(repairs).toBe(0);
    expect(result).toMatchObject({ ok: true, attempts: 1 });
  });
});
