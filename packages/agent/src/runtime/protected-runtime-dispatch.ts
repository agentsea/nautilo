import type { RunnableConfig } from "@langchain/core/runnables";

import type { NautiloState } from "../agent/state";
import { agentNode } from "../nodes/agent";
import { preModelNode } from "../nodes/pre-model";
import type { SkillBody } from "../skills/select-skills-for-turn";

const MAX_RUNTIME_CONFIGURATION_BYTES = 2 * 1024 * 1024;
const MAX_RUNTIME_ITEMS = 256;

export interface TransientAgentRuntimeCommand {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly body: string;
}

export interface TransientAgentRuntimeOnboardingAnswer {
  readonly questionId: string;
  readonly answer: string;
}

export interface TransientAgentRuntimeConfiguration {
  readonly formatVersion: 1;
  readonly soulFile: string;
  readonly memoryBrief: string;
  readonly skills: readonly SkillBody[];
  readonly commands: readonly TransientAgentRuntimeCommand[];
  readonly onboardingAnswers:
    readonly TransientAgentRuntimeOnboardingAnswer[];
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactFields(
  value: Record<string, unknown>,
  fields: readonly string[],
  label: string,
): void {
  const expected = new Set(fields);
  for (const field of Object.keys(value)) {
    if (!expected.has(field)) {
      throw new TypeError(`${label} contains unknown field ${field}`);
    }
  }
  if (fields.some((field) => !(field in value))) {
    throw new TypeError(`${label} is missing a required field`);
  }
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be text`);
  }
  return value;
}

function textArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_RUNTIME_ITEMS) {
    throw new TypeError(`${label} must be a bounded array`);
  }
  return Object.freeze(
    value.map((item, index) => text(item, `${label}[${index}]`)),
  );
}

function itemArray<Value>(
  value: unknown,
  label: string,
  decode: (item: unknown, index: number) => Value,
): readonly Value[] {
  if (!Array.isArray(value) || value.length > MAX_RUNTIME_ITEMS) {
    throw new TypeError(`${label} must be a bounded array`);
  }
  return Object.freeze(value.map(decode));
}

function decodeSkill(value: unknown, index: number): SkillBody {
  const item = record(value, `Runtime skill[${index}]`);
  exactFields(
    item,
    ["id", "name", "description", "body", "requiresTools"],
    `Runtime skill[${index}]`,
  );
  return Object.freeze({
    id: text(item["id"], `Runtime skill[${index}].id`),
    name: text(item["name"], `Runtime skill[${index}].name`),
    description:
      text(item["description"], `Runtime skill[${index}].description`),
    body: text(item["body"], `Runtime skill[${index}].body`),
    requiresTools:
      [...textArray(
        item["requiresTools"],
        `Runtime skill[${index}].requiresTools`,
      )],
  });
}

function decodeCommand(
  value: unknown,
  index: number,
): TransientAgentRuntimeCommand {
  const item = record(value, `Runtime command[${index}]`);
  exactFields(
    item,
    ["id", "name", "description", "body"],
    `Runtime command[${index}]`,
  );
  return Object.freeze({
    id: text(item["id"], `Runtime command[${index}].id`),
    name: text(item["name"], `Runtime command[${index}].name`),
    description:
      text(item["description"], `Runtime command[${index}].description`),
    body: text(item["body"], `Runtime command[${index}].body`),
  });
}

function decodeOnboardingAnswer(
  value: unknown,
  index: number,
): TransientAgentRuntimeOnboardingAnswer {
  const item = record(value, `Runtime onboarding answer[${index}]`);
  exactFields(
    item,
    ["questionId", "answer"],
    `Runtime onboarding answer[${index}]`,
  );
  return Object.freeze({
    questionId:
      text(item["questionId"], `Runtime onboarding answer[${index}].questionId`),
    answer:
      text(item["answer"], `Runtime onboarding answer[${index}].answer`),
  });
}

export function decodeTransientAgentRuntimeConfiguration(
  bytes: Uint8Array,
): TransientAgentRuntimeConfiguration {
  if (
    !(bytes instanceof Uint8Array)
    || bytes.length === 0
    || bytes.length > MAX_RUNTIME_CONFIGURATION_BYTES
  ) {
    throw new TypeError(
      "Protected Runtime configuration must be bounded non-empty bytes",
    );
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new TypeError("Protected Runtime configuration is not canonical JSON");
  }
  const value = record(decoded, "Protected Runtime configuration");
  exactFields(
    value,
    [
      "formatVersion",
      "soulFile",
      "memoryBrief",
      "skills",
      "commands",
      "onboardingAnswers",
    ],
    "Protected Runtime configuration",
  );
  if (value["formatVersion"] !== 1) {
    throw new TypeError("Protected Runtime configuration version is invalid");
  }
  return Object.freeze({
    formatVersion: 1,
    soulFile: text(value["soulFile"], "Runtime soul file"),
    memoryBrief: text(value["memoryBrief"], "Runtime memory brief"),
    skills: itemArray(value["skills"], "Runtime skills", decodeSkill),
    commands: itemArray(value["commands"], "Runtime commands", decodeCommand),
    onboardingAnswers: itemArray(
      value["onboardingAnswers"],
      "Runtime onboarding answers",
      decodeOnboardingAnswer,
    ),
  });
}

const transientResultFields = new Set([
  "soulFile",
  "skills",
  "memoryBrief",
  "preparedMessages",
  "preparedStableSystemPrefixLength",
]);

function assertNoTransientResultFields(
  value: Partial<NautiloState>,
  allowPreparedMessages: boolean,
): void {
  for (const field of Object.keys(value)) {
    if (
      transientResultFields.has(field)
      && (
        !allowPreparedMessages
        || (field !== "preparedMessages" && field !== "preparedStableSystemPrefixLength")
      )
    ) {
      throw new Error(
        "Protected model result contains transient Runtime fields",
      );
    }
  }
}

/**
 * Supply decrypted Runtime configuration to exactly one pre-model/model
 * dispatch without writing it or its prepared SystemMessage back to graph
 * state. The callbacks are injected so this contract remains DB/model-free in
 * unit tests; `runNautiloTransientProtectedModelDispatch` binds the real nodes.
 */
export async function runTransientProtectedModelDispatch(
  input: Readonly<{
    readonly checkpointState: NautiloState;
    readonly configuration: TransientAgentRuntimeConfiguration;
    readonly prepareModelInput: (
      transientState: NautiloState,
    ) => Partial<NautiloState> | PromiseLike<Partial<NautiloState>>;
    readonly invokeModel: (
      transientState: NautiloState,
    ) => Partial<NautiloState> | PromiseLike<Partial<NautiloState>>;
  }>,
): Promise<Partial<NautiloState>> {
  if (
    input.checkpointState.soulFile !== ""
    || input.checkpointState.skills.length !== 0
    || input.checkpointState.memoryBrief !== ""
    || input.checkpointState.preparedMessages.length !== 0
  ) {
    throw new Error(
      "Protected Runtime plaintext is already present in graph state",
    );
  }

  const transientState = {
    ...input.checkpointState,
    soulFile: input.configuration.soulFile,
    skills: [...input.configuration.skills],
    memoryBrief: input.configuration.memoryBrief,
    preparedMessages: [],
    preparedStableSystemPrefixLength: 0,
  };
  const prepared = await input.prepareModelInput(transientState);
  assertNoTransientResultFields(prepared, true);
  if (
    !Array.isArray(prepared.preparedMessages)
    || prepared.preparedMessages.length === 0
  ) {
    throw new Error("Protected pre-model did not prepare model input");
  }
  const modelResult = await input.invokeModel({
    ...transientState,
    ...prepared,
  });
  assertNoTransientResultFields(modelResult, false);
  return modelResult;
}

export function runNautiloTransientProtectedModelDispatch(input: Readonly<{
  readonly checkpointState: NautiloState;
  readonly configuration: TransientAgentRuntimeConfiguration;
  readonly invocationConfig?: RunnableConfig;
}>): Promise<Partial<NautiloState>> {
  return runTransientProtectedModelDispatch({
    checkpointState: input.checkpointState,
    configuration: input.configuration,
    prepareModelInput: preModelNode,
    invokeModel: (state) => agentNode(state, input.invocationConfig),
  });
}
