import { expect, test } from "bun:test";
import {
  Annotation,
  Command,
  END,
  MemorySaver,
  START,
  StateGraph,
  interrupt,
} from "@langchain/langgraph";

import {
  assertProtectedTaskAdditionalAuthorityResumeAcknowledgementV1,
  createProtectedTaskAdditionalAuthorityResumeMapV1,
  type ProtectedTaskAdditionalAuthorityResumeBindingV1,
} from "../../src/graph/protected-task-additional-authority-resume";

const AUTHORIZATION_REQUEST_ID = "task-run-authorization:run-exact";
const OPERATION_ID = "memory-operation-exact";

function binding(
  interruptId: string,
): ProtectedTaskAdditionalAuthorityResumeBindingV1 {
  return {
    interruptId,
    authorizationRequestId: AUTHORIZATION_REQUEST_ID,
    effectDisposition: "not_started_v1",
    operationId: OPERATION_ID,
    requestDigest: new Uint8Array(32).fill(17),
    requiredAuthorityDigest: new Uint8Array(32).fill(29),
  };
}

function scenario(threadId: string) {
  const State = Annotation.Root({
    completed: Annotation<boolean>({
      reducer: (_, next) => next,
      default: () => false,
    }),
  });
  const saver = new MemorySaver();
  let predecessorEffects = 0;
  let protectedMutations = 0;
  const makeGraph = () => new StateGraph(State)
    .addNode("completed_predecessor", () => {
      predecessorEffects += 1;
      return {};
    })
    .addNode("protected_effect", () => {
      // Everything before interrupt is derived from immutable coordinates. It
      // remains safe when LangGraph restarts this node to deliver the reply.
      const expected = binding("unused-in-acknowledgement");
      const acknowledgement: unknown = interrupt({
        type: "protected_task_additional_authority",
        authorizationRequestId: expected.authorizationRequestId,
        effectDisposition: expected.effectDisposition,
        operationId: expected.operationId,
        requestDigest: expected.requestDigest,
        requiredAuthorityDigest: expected.requiredAuthorityDigest,
      });
      assertProtectedTaskAdditionalAuthorityResumeAcknowledgementV1(
        acknowledgement,
        expected,
      );
      protectedMutations += 1;
      return { completed: true };
    })
    .addEdge(START, "completed_predecessor")
    .addEdge("completed_predecessor", "protected_effect")
    .addEdge("protected_effect", END)
    .compile({ checkpointer: saver });
  const config = { configurable: { thread_id: threadId } };
  return {
    makeGraph,
    config,
    predecessorEffects: () => predecessorEffects,
    protectedMutations: () => protectedMutations,
  };
}

test("exact interrupt-keyed acknowledgement resumes once without predecessor replay", async () => {
  const run = scenario("additional-authority-exact");
  const initial = run.makeGraph();
  await initial.invoke({ completed: false }, run.config);
  const parked = await initial.getState(run.config);
  const interruptId = parked.tasks[0]?.interrupts[0]?.id;
  expect(typeof interruptId).toBe("string");
  if (typeof interruptId !== "string") throw new TypeError("missing interrupt");
  expect(run.predecessorEffects()).toBe(1);
  expect(run.protectedMutations()).toBe(0);

  const coordinates = binding(interruptId);
  const resume = createProtectedTaskAdditionalAuthorityResumeMapV1(coordinates);
  coordinates.requestDigest.fill(0);
  coordinates.requiredAuthorityDigest.fill(0);
  expect(resume[interruptId]?.requestDigest).toEqual(new Uint8Array(32).fill(17));
  expect(Object.keys(resume)).toEqual([interruptId]);

  const completed = await run.makeGraph().invoke(
    new Command({ resume }),
    run.config,
  );
  expect(completed.completed).toBe(true);
  expect(run.predecessorEffects()).toBe(1);
  expect(run.protectedMutations()).toBe(1);
});

test("malformed acknowledgement is rejected before the protected mutation", async () => {
  const run = scenario("additional-authority-malformed");
  const initial = run.makeGraph();
  await initial.invoke({ completed: false }, run.config);
  const parked = await initial.getState(run.config);
  const interruptId = parked.tasks[0]?.interrupts[0]?.id;
  if (typeof interruptId !== "string") throw new TypeError("missing interrupt");
  const exact = createProtectedTaskAdditionalAuthorityResumeMapV1(
    binding(interruptId),
  )[interruptId]!;
  expect(() => assertProtectedTaskAdditionalAuthorityResumeAcknowledgementV1(
    { ...exact, extra: true },
    binding(interruptId),
  )).toThrow("additional-authority acknowledgement is invalid");
  expect(() => createProtectedTaskAdditionalAuthorityResumeMapV1({
    ...binding(interruptId),
    extra: true,
  } as never)).toThrow("additional-authority resume binding is invalid");

  const failure = await run.makeGraph().invoke(new Command({
    resume: {
      [interruptId]: {
        ...exact,
        requestDigest: new Uint8Array(32).fill(99),
      },
    },
  }), run.config).then(
    () => null,
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain(
    "additional-authority acknowledgement is invalid",
  );
  expect(run.predecessorEffects()).toBe(1);
  expect(run.protectedMutations()).toBe(0);
});
