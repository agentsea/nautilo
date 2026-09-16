import { describe, expect, test } from "bun:test";

import type { NautiloState } from "../agent/state";
import {
  decodeTransientAgentRuntimeConfiguration,
  runTransientProtectedModelDispatch,
} from "./protected-runtime-dispatch";

const SOUL_CANARY = "WAVE8-TRANSIENT-SOUL-CANARY";
const SKILL_CANARY = "WAVE8-TRANSIENT-SKILL-CANARY";

function encodedConfiguration(): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    formatVersion: 1,
    soulFile: SOUL_CANARY,
    memoryBrief: "",
    skills: [{
      id: "skill-1",
      name: "private-skill",
      description: "Synthetic encrypted skill",
      body: SKILL_CANARY,
      requiresTools: [],
    }],
    commands: [],
    onboardingAnswers: [],
  }));
}

function checkpointState(
  overrides: Partial<NautiloState> = {},
): NautiloState {
  return {
    soulFile: "",
    skills: [],
    memoryBrief: "",
    preparedMessages: [],
    messages: [],
    ...overrides,
  } as NautiloState;
}

describe("Wave 8 transient protected pre-model/model dispatch", () => {
  test("strictly decodes the bounded synthetic Runtime configuration", () => {
    expect(decodeTransientAgentRuntimeConfiguration(
      encodedConfiguration(),
    )).toEqual({
      formatVersion: 1,
      soulFile: SOUL_CANARY,
      memoryBrief: "",
      skills: [{
        id: "skill-1",
        name: "private-skill",
        description: "Synthetic encrypted skill",
        body: SKILL_CANARY,
        requiresTools: [],
      }],
      commands: [],
      onboardingAnswers: [],
    });

    const widened = JSON.parse(new TextDecoder().decode(
      encodedConfiguration(),
    )) as Record<string, unknown>;
    widened["serverKey"] = "must-not-be-accepted";
    expect(() =>
      decodeTransientAgentRuntimeConfiguration(
        new TextEncoder().encode(JSON.stringify(widened)),
      )
    ).toThrow("unknown field");
  });

  test("lends configuration to pre-model and model without returning checkpointable secrets", async () => {
    const state = checkpointState();
    const configuration =
      decodeTransientAgentRuntimeConfiguration(encodedConfiguration());
    const durableBefore = JSON.stringify(state);
    let preparedSawSecret = false;
    let modelSawPrepared = false;

    const result = await runTransientProtectedModelDispatch({
      checkpointState: state,
      configuration,
      prepareModelInput: (transientState) => {
        preparedSawSecret =
          transientState.soulFile === SOUL_CANARY
          && transientState.skills[0]?.body === SKILL_CANARY;
        return {
          preparedMessages: [{ content: SOUL_CANARY }] as never,
          toolNames: [],
        };
      },
      invokeModel: (transientState) => {
        modelSawPrepared =
          transientState.preparedMessages[0] !== undefined;
        return {
          messages: [{ content: "content-free model result" }] as never,
          model: "synthetic:model",
        };
      },
    });

    expect(preparedSawSecret).toBe(true);
    expect(modelSawPrepared).toBe(true);
    expect(JSON.stringify(state)).toBe(durableBefore);
    expect(JSON.stringify(state)).not.toContain(SOUL_CANARY);
    expect(JSON.stringify(state)).not.toContain(SKILL_CANARY);
    expect(JSON.stringify(result)).not.toContain(SOUL_CANARY);
    expect(JSON.stringify(result)).not.toContain(SKILL_CANARY);
    expect(result.model).toBe("synthetic:model");
    expect(result.messages).toHaveLength(1);
    expect((result.messages?.[0] as unknown as { content: string }).content)
      .toBe("content-free model result");
  });

  test("refuses a protected dispatch when plaintext Runtime fields already entered state", async () => {
    const configuration =
      decodeTransientAgentRuntimeConfiguration(encodedConfiguration());

    let prepared = false;
    let failure: unknown;
    try {
      await runTransientProtectedModelDispatch({
        checkpointState: checkpointState({ soulFile: "persisted plaintext" }),
        configuration,
        prepareModelInput: () => {
          prepared = true;
          return {};
        },
        invokeModel: () => ({}),
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toEqual(
      new Error("Protected Runtime plaintext is already present in graph state"),
    );
    expect(prepared).toBe(false);
  });

  test("rejects protected node results that try to return transient fields", async () => {
    const configuration =
      decodeTransientAgentRuntimeConfiguration(encodedConfiguration());

    let failure: unknown;
    try {
      await runTransientProtectedModelDispatch({
        checkpointState: checkpointState(),
        configuration,
        prepareModelInput: () => ({
          preparedMessages: [{ content: SOUL_CANARY }] as never,
        }),
        invokeModel: () => ({
          soulFile: SOUL_CANARY,
        }),
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toEqual(
      new Error("Protected model result contains transient Runtime fields"),
    );
  });
});
