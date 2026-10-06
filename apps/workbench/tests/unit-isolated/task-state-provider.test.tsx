import "../bun-dom-preload";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";

let legacyCalls = 0;
let contentCalls = 0;

mock.module("../../src/lib/api", () => ({
  apiClient: {
    listTasks: async () => {
      legacyCalls += 1;
      return [];
    },
    listTaskContentV1: async () => {
      contentCalls += 1;
      return [];
    },
    pauseTask: async () => ({}),
    unpauseTask: async () => ({}),
    stopTask: async () => ({}),
  },
}));

mock.module("../../src/hooks/use-auth", () => ({
  useAuth: () => ({
    viewerGeneration: 1,
    viewer: { isVerified: true },
  }),
}));

mock.module("../../src/lib/auth-transition", () => ({
  addAuthTransitionListener: () => () => {},
  shouldIgnoreCredentialOnlyTransition: () => false,
}));

const { TaskStateProvider } = await import(
  "../../src/contexts/task-state/task-state-context"
);

afterEach(() => cleanup());

describe("TaskStateProvider policy routing", () => {
  test("uses its explicit policy while mounted outside the policy context", async () => {
    legacyCalls = 0;
    contentCalls = 0;
    const bridgeRef = { current: null };
    const view = render(
      <TaskStateProvider
        wsState="closed"
        bridgeRef={bridgeRef}
        policyMode="plaintext_only"
      >
        <div>child</div>
      </TaskStateProvider>,
    );

    await waitFor(() => expect(legacyCalls).toBe(1));
    expect(contentCalls).toBe(0);

    view.rerender(
      <TaskStateProvider
        wsState="closed"
        bridgeRef={bridgeRef}
        policyMode="shadow_encryption"
      >
        <div>child</div>
      </TaskStateProvider>,
    );

    await waitFor(() => expect(contentCalls).toBe(1));
    expect(legacyCalls).toBe(1);
  });
});
