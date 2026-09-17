/**
 * `PinChallengeProvider` reaches the credentials database in production.
 * Keep its module double in a dedicated Bun process: `mock.module` is sticky,
 * and ordinary unit tests must never require a live database.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import type { MemoryAccessEnvelope } from "@nautilo/trust";

const UUID_ALICE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const UUID_BOB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const NOT_ENROLLED_MESSAGE =
  "No PIN credential is configured. Identity verification is not available.";

const enrollmentSubjects: string[] = [];
const providerOptions: unknown[] = [];
const interruptPayloads: unknown[] = [];
let enrollmentOutcome: boolean | Error = false;
let interruptDecision: unknown = { verified: true };

function envelope(ownerId: string): MemoryAccessEnvelope {
  return {
    ownerId,
    actorId: "actor-anything",
    agentId: "agent-anything",
    roomId: "",
    readableNamespaces: [],
    mutableNamespaces: [],
    writableNamespaces: [],
    toolPolicy: {},
  } as unknown as MemoryAccessEnvelope;
}

let createVerifyIdentityTool: typeof import(
  "../../src/tools/trust/verify-identity"
)["createVerifyIdentityTool"];
let identityVerifiedMessage: string;

beforeAll(async () => {
  mock.module("@nautilo/trust", () => ({
    PinChallengeProvider: class PinChallengeProviderDouble {
      constructor(options: unknown) {
        providerOptions.push(options);
      }

      async isEnrolled(userId: string): Promise<boolean> {
        enrollmentSubjects.push(userId);
        if (enrollmentOutcome instanceof Error) throw enrollmentOutcome;
        return enrollmentOutcome;
      }
    },
  }));
  mock.module("@langchain/langgraph", () => ({
    interrupt: (payload: unknown) => {
      interruptPayloads.push(payload);
      return interruptDecision;
    },
  }));

  const subject = await import("../../src/tools/trust/verify-identity");
  createVerifyIdentityTool = subject.createVerifyIdentityTool;
  identityVerifiedMessage = subject.IDENTITY_VERIFIED_MESSAGE;
});

afterAll(() => {
  mock.restore();
});

beforeEach(() => {
  enrollmentSubjects.length = 0;
  providerOptions.length = 0;
  interruptPayloads.length = 0;
  enrollmentOutcome = false;
  interruptDecision = { verified: true };
});

describe("verify_identity envelope-derived PIN subject", () => {
  test("checks the exact envelope owner and interrupts for an enrolled user", async () => {
    enrollmentOutcome = true;
    const tool = createVerifyIdentityTool({
      memoryAccessEnvelope: envelope(UUID_ALICE),
    });

    const result = await tool.invoke({});

    expect(providerOptions).toEqual([{ persistPath: null }]);
    expect(enrollmentSubjects).toEqual([UUID_ALICE]);
    expect(interruptPayloads).toHaveLength(1);
    expect(interruptPayloads[0]).toMatchObject({
      type: "identity_challenge",
      userId: UUID_ALICE,
    });
    expect(result).toBe(identityVerifiedMessage);
  });

  test("checks the exact envelope owner and fails closed when not enrolled", async () => {
    enrollmentOutcome = false;
    const tool = createVerifyIdentityTool({
      memoryAccessEnvelope: envelope(UUID_ALICE),
    });

    const result = await tool.invoke({});

    expect(enrollmentSubjects).toEqual([UUID_ALICE]);
    expect(interruptPayloads).toEqual([]);
    expect(result).toBe(NOT_ENROLLED_MESSAGE);
  });

  test("checks the exact envelope owner and fails closed when enrollment lookup fails", async () => {
    enrollmentOutcome = new Error("database must not be reached by this test");
    const tool = createVerifyIdentityTool({
      memoryAccessEnvelope: envelope(UUID_BOB),
    });

    const result = await tool.invoke({});

    expect(enrollmentSubjects).toEqual([UUID_BOB]);
    expect(interruptPayloads).toEqual([]);
    expect(result).toBe(NOT_ENROLLED_MESSAGE);
  });
});
