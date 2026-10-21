import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { AIMessage, AIMessageChunk } from "@langchain/core/messages";
import { setLogOutput } from "@nautilo/logger";
import { setConfigOverrides } from "@nautilo/config";
import * as db from "@nautilo/db";
import { generateSoulFileFallback, normalizeSoulFileInput } from "../../src/index";
import * as soulModule from "../../src/soul/generate-soul-file";
import { __setStubModelForTests } from "../../src/providers/universal";
import * as universalProvider from "../../src/providers/universal";
import type { ChatModel } from "../../src/providers/types";
import { ServerProviderCredentialsDeniedError } from "@nautilo/trust";
import { getUsageContext } from "../../src/usage/usage-context";
import * as surplusAttempt from "../../src/providers/surplus-attempt";
import * as personalAttempt from "../../src/usage/personal-llm-attempt";

const SOUL_AUTHORIZATION = {
  humanUserId: "user-1",
  assertServerProviderCredentials: async () => {},
} as const;

let originalOpenRouterKey: string | undefined;
let originalSurplusKey: string | undefined;

beforeEach(() => {
  originalOpenRouterKey = process.env["OPENROUTER_API_KEY"];
  originalSurplusKey = process.env["SURPLUS_API_KEY"];
  process.env["OPENROUTER_API_KEY"] = "test-openrouter-key";
  delete process.env["SURPLUS_API_KEY"];
});

afterEach(() => {
  setConfigOverrides({});
  if (process.env["NAUTILO_TEST_MODE"] === "stub") {
    __setStubModelForTests(null);
  }
  delete process.env["NAUTILO_TEST_MODE"];
  if (originalOpenRouterKey === undefined) delete process.env["OPENROUTER_API_KEY"];
  else process.env["OPENROUTER_API_KEY"] = originalOpenRouterKey;
  if (originalSurplusKey === undefined) delete process.env["SURPLUS_API_KEY"];
  else process.env["SURPLUS_API_KEY"] = originalSurplusKey;
  setLogOutput("stderr");
});

describe("soul file fallback", () => {
  test("uses Genie as the default name", () => {
    const normalized = normalizeSoulFileInput({});
    const soulFile = generateSoulFileFallback(normalized);

    expect(normalized.name).toBe("Genie");
    expect(soulFile).toContain("# Genie — Soul File");
    expect(soulFile).toContain("## Core Truths");
    expect(soulFile).toContain("## Continuity");
    expect(soulFile).toContain("Default name: Genie");
  });

  test("includes work/life mode, privacy, voice, and personal context", () => {
    const soulFile = generateSoulFileFallback({
      name: "Aria",
      language: "en",
      privacySpectrum: 75,
      workLifeMode: "both",
      voiceName: "Samantha",
      motherAnswer: "It is complicated but deeply important.",
    });

    expect(soulFile).toContain("# Aria");
    expect(soulFile).toContain("comfortable spanning both work and life");
    expect(soulFile).toContain('intended voice is "Samantha"');
    expect(soulFile).toContain("It is complicated but deeply important.");
    expect(soulFile).toContain("would actually want to talk to");
    expect(soulFile).toContain("Treat continuity as a bridge across modes");
  });

  // D220 — the legacy fallback opened every soul with a product-marketing
  // sentence ("is not a generic chatbot. ... chosen presence: grounded,
  // capable, emotionally real enough to matter, ..."). This test pins that
  // wording out so a future edit cannot accidentally restore it.
  test("does NOT include the legacy 'not a generic chatbot' boilerplate", () => {
    const soulFile = generateSoulFileFallback({
      name: "Nova",
      workLifeMode: "both",
    });

    expect(soulFile).not.toMatch(/is not a generic chatbot/i);
    expect(soulFile).not.toMatch(/chosen presence/i);
    expect(soulFile).not.toMatch(/emotionally real enough to matter/i);
  });

  // D220 — when the user gave a personality direction in their own words,
  // the fallback should quote it in the Essence section so the opening of
  // the soul is genuinely about THIS assistant, not a generic template.
  test("essence quotes the user's personality direction when present", () => {
    const personalityPrompt =
      "tactical, sardonic, deeply patient with code reviews, allergic to small talk";
    const soulFile = generateSoulFileFallback({
      name: "Vex",
      workLifeMode: "work",
      personalityPrompt,
    });

    expect(soulFile).toContain(personalityPrompt);
    expect(soulFile).toMatch(
      /Vex is the assistant the user described in their own words/i,
    );
  });
});

describe("soul module exports", () => {
  // Sanity guard: the prompt + fallback live in the same module the server
  // route imports. If someone splits the module or renames the exports,
  // this test fails loudly so the route doesn't silently regress to the
  // legacy boilerplate path.
  test("fallback + LLM generator are exported from the same module", () => {
    expect(typeof soulModule.generateSoulFile).toBe("function");
    expect(typeof soulModule.generateSoulFileFallback).toBe("function");
  });
});

describe("streaming soul generation safety", () => {
  test("returns a usable fallback when the configured model is unavailable", async () => {
    setConfigOverrides({
      nautilo_soul_generator_model: "venice:not-in-the-signed-catalog",
    });
    const stderr = spyOn(console, "error").mockImplementation(() => {});

    try {
      const soulFile = await soulModule.generateSoulFile({
        name: "Vex",
        personalityPrompt: "Patient, dry, and exacting",
      }, undefined, SOUL_AUTHORIZATION);
      expect(soulFile).toContain("# Vex — Soul File");
      expect(soulFile).toContain("Patient, dry, and exacting");

      const events = [];
      for await (const event of soulModule.generateSoulFileStream(
        { name: "Vex" }, undefined, SOUL_AUTHORIZATION,
      )) {
        events.push(event);
      }
      expect(events[0]).toEqual({ type: "started" });
      expect(events).toHaveLength(2);
      const terminal = events[1];
      if (!terminal || terminal.type !== "error") {
        throw new Error("expected the streaming fallback error event");
      }
      expect(terminal.error).toBe(soulModule.SOUL_GENERATION_FAILED_MESSAGE);
      expect(terminal.fallback).toContain("# Vex — Soul File");
    } finally {
      stderr.mockRestore();
    }
  });

  test("preserves the explicit default-model fallback contract for Soul generation", async () => {
    setConfigOverrides({
      nautilo_soul_generator_model: null,
      nautilo_model: "venice:unavailable-explicit-default",
    });
    const stderr = spyOn(console, "error").mockImplementation(() => {});

    try {
      const soulFile = await soulModule.generateSoulFile(
        { name: "Vex" }, undefined, SOUL_AUTHORIZATION,
      );
      expect(soulFile).toContain("# Vex — Soul File");

      const stream = soulModule.generateSoulFileStream(
        { name: "Vex" }, undefined, SOUL_AUTHORIZATION,
      );
      expect((await stream.next()).value).toEqual({ type: "started" });
      const terminal = await stream.next();
      expect(terminal.done).toBe(false);
      if (terminal.done || terminal.value.type !== "error") {
        throw new Error("expected the configured default model to use the stream fallback");
      }
      expect(terminal.value.fallback).toContain("# Vex — Soul File");
    } finally {
      stderr.mockRestore();
    }
  });

  test("sanitizes provider exceptions, retains the fallback, and forwards external abort", async () => {
    process.env["NAUTILO_TEST_MODE"] = "stub";
    const secret = "sk-provider-secret-must-not-cross-the-stream";
    let modelSignal: AbortSignal | undefined;
    let observeModelSignal: (() => void) | undefined;
    const modelSignalObserved = new Promise<void>((resolve) => {
      observeModelSignal = resolve;
    });
    const model: ChatModel = {
      async invoke() {
        return { content: "" };
      },
      async stream(_messages, options) {
        modelSignal = options?.["signal"] as AbortSignal | undefined;
        observeModelSignal?.();
        return {
          async *[Symbol.asyncIterator]() {
            yield { content: "" };
            await new Promise<void>((resolve) => {
              if (modelSignal?.aborted) {
                resolve();
                return;
              }
              modelSignal?.addEventListener("abort", () => resolve(), { once: true });
            });
            throw new Error(`provider rejected request: ${secret}`);
          },
        };
      },
    };
    __setStubModelForTests(model);
    setLogOutput("stderr");
    const stderr = spyOn(console, "error").mockImplementation(() => {});

    try {
      const externalAbort = new AbortController();
      const stream = soulModule.generateSoulFileStream(
        { name: "Vex" },
        externalAbort.signal,
        SOUL_AUTHORIZATION,
      );
      expect((await stream.next()).value).toEqual({ type: "started" });

      const errorEventPromise = stream.next();
      await modelSignalObserved;
      expect(modelSignal).toBeDefined();
      expect(modelSignal?.aborted).toBe(false);

      externalAbort.abort();
      const errorEvent = await errorEventPromise;

      expect(modelSignal?.aborted).toBe(true);
      expect(errorEvent.done).toBe(false);
      if (errorEvent.done || errorEvent.value.type !== "error") {
        throw new Error("expected a sanitized soul generation error event");
      }
      expect(errorEvent.value).toMatchObject({
        type: "error",
        error: soulModule.SOUL_GENERATION_FAILED_MESSAGE,
      });
      expect(errorEvent.value.fallback).toContain("# Vex — Soul File");
      expect(JSON.stringify(errorEvent.value)).not.toContain(secret);
      expect(stderr.mock.calls.flat().join(" ")).not.toContain(secret);
    } finally {
      stderr.mockRestore();
    }
  });

  test("threads external abort through the non-streaming fallback", async () => {
    process.env["NAUTILO_TEST_MODE"] = "stub";
    let modelSignal: AbortSignal | undefined;
    let observeModelSignal: (() => void) | undefined;
    const modelSignalObserved = new Promise<void>((resolve) => {
      observeModelSignal = resolve;
    });
    const model: ChatModel = {
      async invoke(_messages, options) {
        modelSignal = options?.["signal"] as AbortSignal | undefined;
        observeModelSignal?.();
        await new Promise<void>((resolve) => {
          if (modelSignal?.aborted) {
            resolve();
            return;
          }
          modelSignal?.addEventListener("abort", () => resolve(), { once: true });
        });
        throw new Error("provider failure after cancellation");
      },
    };
    __setStubModelForTests(model);
    setLogOutput("stderr");
    const stderr = spyOn(console, "error").mockImplementation(() => {});

    try {
      const externalAbort = new AbortController();
      const stream = soulModule.generateSoulFileStream(
        { name: "Vex" },
        externalAbort.signal,
        SOUL_AUTHORIZATION,
      );
      expect((await stream.next()).value).toEqual({ type: "started" });

      const completionEventPromise = stream.next();
      await modelSignalObserved;
      expect(modelSignal?.aborted).toBe(false);

      externalAbort.abort();
      const completionEvent = await completionEventPromise;

      expect(modelSignal?.aborted).toBe(true);
      expect(completionEvent.done).toBe(false);
      if (completionEvent.done || completionEvent.value.type !== "completed") {
        throw new Error("expected fallback completion after cancellation");
      }
      expect(completionEvent.value.soulFile).toContain("# Vex — Soul File");
      expect(stderr.mock.calls.flat().join(" ")).not.toContain("provider failure after cancellation");
    } finally {
      stderr.mockRestore();
    }
  });

  test("fails closed before dispatch when the initiating Human is missing", async () => {
    process.env["NAUTILO_TEST_MODE"] = "stub";
    let invoked = false;
    __setStubModelForTests({
      async invoke() {
        invoked = true;
        return { content: "## Essence\nEnough content to pass the soul-file shape check.\n## Tone\nExact." };
      },
    });

    let caught: unknown;
    try {
      await soulModule.generateSoulFile(
        { name: "Vex" },
        undefined,
        { humanUserId: "" },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ServerProviderCredentialsDeniedError);
    expect(invoked).toBeFalse();
  });

  test("fresh-checks revoked server funding before dispatch", async () => {
    process.env["NAUTILO_TEST_MODE"] = "stub";
    let invoked = false;
    __setStubModelForTests({
      async invoke() {
        invoked = true;
        return { content: "## Essence\nGenerated.\n## Tone\nExact." };
      },
    });
    let caught: unknown;
    try {
      await soulModule.generateSoulFile({ name: "Vex" }, undefined, {
        humanUserId: "user-1",
        assertServerProviderCredentials: async (humanUserId, origin) => {
          throw new ServerProviderCredentialsDeniedError(humanUserId, origin);
        },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ServerProviderCredentialsDeniedError);
    expect(invoked).toBeFalse();
  });

  test("uses the narrow own-Soul setup admission and records service funding", async () => {
    process.env["NAUTILO_TEST_MODE"] = "stub";
    const observedContexts: unknown[] = [];
    const admissionInputs: unknown[] = [];
    __setStubModelForTests({
      async invoke() {
        observedContexts.push(getUsageContext());
        return {
          content: "## Essence\nA precise and useful generated identity with enough detail.\n\n## Tone\nWarm and exact.",
        };
      },
      async stream() {
        observedContexts.push(getUsageContext());
        return {
          async *[Symbol.asyncIterator]() {
            observedContexts.push(getUsageContext());
            yield {
              content: "## Essence\nA precise and useful streamed identity with enough detail.\n\n## Tone\nWarm and exact.",
            };
          },
        };
      },
    });
    const authorization = {
      humanUserId: "user-1",
      agentId: "agent-own",
      admission: "own_soul_setup_service" as const,
      assertOwnSoulSetupService: async (input: unknown) => {
        admissionInputs.push(input);
      },
    };

    await soulModule.generateSoulFile({ name: "Vex" }, undefined, authorization);
    for await (const _event of soulModule.generateSoulFileStream(
      { name: "Vex" }, undefined, authorization,
    )) {
      // Exhaust the stream so its usage callbacks observe the ambient context.
    }

    expect(admissionInputs).toEqual([
      { humanUserId: "user-1", agentId: "agent-own", origin: "soul_generation" },
      { humanUserId: "user-1", agentId: "agent-own", origin: "soul_generation" },
    ]);
    for (const context of observedContexts) {
      expect(context).toMatchObject({
        callType: "soul",
        userId: "user-1",
        funding: { kind: "service", humanUserId: "user-1" },
        metadata: { agentId: "agent-own", service: "soul_generation" },
      });
    }
  });

  test("does not turn a revoked own-Soul setup admission into a stream fallback", async () => {
    process.env["NAUTILO_TEST_MODE"] = "stub";
    let streamed = false;
    __setStubModelForTests({
      async invoke() {
        return { content: "" };
      },
      async stream() {
        streamed = true;
        return { async *[Symbol.asyncIterator]() {} };
      },
    });
    const stream = soulModule.generateSoulFileStream({ name: "Vex" }, undefined, {
      humanUserId: "user-1",
      agentId: "agent-own",
      admission: "own_soul_setup_service",
      assertOwnSoulSetupService: async ({ humanUserId, origin }) => {
        throw new ServerProviderCredentialsDeniedError(humanUserId, origin);
      },
    });
    expect((await stream.next()).value).toEqual({ type: "started" });
    await Promise.resolve(expect(stream.next()).rejects.toBeInstanceOf(
      ServerProviderCredentialsDeniedError,
    ));
    expect(streamed).toBeFalse();
  });
});

describe("Surplus-funded soul generation", () => {
  const modelId = "openrouter:openai/gpt-5.6-sol";
  const generatedSoul = [
    "## Essence",
    "A precise and distinctive generated identity with enough detail to be useful.",
    "",
    "## Tone",
    "Warm, exact, and candid without becoming performative.",
  ].join("\n");

  function preferSurplus(enabled: boolean) {
    return spyOn(db, "getCachedServerModelConfigRow").mockReturnValue({
      preferSurplus: enabled,
    } as NonNullable<ReturnType<typeof db.getCachedServerModelConfigRow>>);
  }

  test("uses the selected Surplus-only system-task model in non-streaming mode", async () => {
    delete process.env["OPENROUTER_API_KEY"];
    process.env["SURPLUS_API_KEY"] = "synthetic-surplus-key";
    setConfigOverrides({ nautilo_soul_generator_model: modelId });
    const configSpy = preferSurplus(true);
    let observedContext: unknown;
    const attemptSpy = spyOn(surplusAttempt, "invokeSurplusChatAttempt")
      .mockImplementation(async (input) => {
        observedContext = getUsageContext();
        expect(input).toMatchObject({
          route: { catalogModelId: modelId },
          apiKey: "synthetic-surplus-key",
          funding: { kind: "service", humanUserId: "user-1", providerRoute: "surplus" },
          directFallbackPolicy: "pre_service_only",
        });
        const response = new AIMessage({
          content: generatedSoul,
          response_metadata: { finish_reason: "stop" },
        });
        expect(() => input.validateResponse?.(response)).not.toThrow();
        return { kind: "served", response };
      });

    try {
      expect(await soulModule.generateSoulFile(
        { name: "Vex" }, undefined, SOUL_AUTHORIZATION,
      )).toBe(generatedSoul);
      expect(attemptSpy).toHaveBeenCalledTimes(1);
      expect(observedContext).toMatchObject({
        callType: "soul",
        userId: "user-1",
        funding: { kind: "service", humanUserId: "user-1", providerRoute: "surplus" },
      });
    } finally {
      attemptSpy.mockRestore();
      configSpy.mockRestore();
    }
  });

  test("rejects malformed Surplus output inside the paid attempt boundary", async () => {
    delete process.env["OPENROUTER_API_KEY"];
    process.env["SURPLUS_API_KEY"] = "synthetic-surplus-key";
    setConfigOverrides({ nautilo_soul_generator_model: modelId });
    const configSpy = preferSurplus(true);
    const attemptSpy = spyOn(surplusAttempt, "invokeSurplusChatAttempt")
      .mockImplementation(async (input) => {
        const malformed = new AIMessage({
          content: "This is not a structured soul file.",
          response_metadata: { finish_reason: "stop" },
        });
        input.validateResponse?.(malformed);
        return { kind: "served", response: malformed };
      });
    const stderr = spyOn(console, "error").mockImplementation(() => {});

    try {
      const result = await soulModule.generateSoulFile(
        { name: "Vex" }, undefined, SOUL_AUTHORIZATION,
      );
      expect(result).toContain("# Vex — Soul File");
      expect(attemptSpy).toHaveBeenCalledTimes(1);
    } finally {
      stderr.mockRestore();
      attemptSpy.mockRestore();
      configSpy.mockRestore();
    }
  });

  test("stops before dispatch when the Surplus policy or credential changes during authorization", async () => {
    delete process.env["OPENROUTER_API_KEY"];
    process.env["SURPLUS_API_KEY"] = "synthetic-surplus-key";
    setConfigOverrides({ nautilo_soul_generator_model: modelId });
    let policyEnabled = true;
    const configSpy = spyOn(db, "getCachedServerModelConfigRow").mockImplementation(() => ({
      preferSurplus: policyEnabled,
    } as NonNullable<ReturnType<typeof db.getCachedServerModelConfigRow>>));
    const attemptSpy = spyOn(surplusAttempt, "invokeSurplusChatAttempt");
    const stderr = spyOn(console, "error").mockImplementation(() => {});

    try {
      const policyChanged = await soulModule.generateSoulFile({ name: "Vex" }, undefined, {
        humanUserId: "user-1",
        assertServerProviderCredentials: async () => {
          policyEnabled = false;
        },
      });
      expect(policyChanged).toContain("# Vex — Soul File");
      expect(attemptSpy).not.toHaveBeenCalled();

      policyEnabled = true;
      process.env["SURPLUS_API_KEY"] = "synthetic-surplus-key";
      const credentialChanged = await soulModule.generateSoulFile({ name: "Vex" }, undefined, {
        humanUserId: "user-1",
        assertServerProviderCredentials: async () => {
          process.env["SURPLUS_API_KEY"] = "replacement-surplus-key";
        },
      });
      expect(credentialChanged).toContain("# Vex — Soul File");
      expect(attemptSpy).not.toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
      attemptSpy.mockRestore();
      configSpy.mockRestore();
    }
  });

  test("streams Surplus deltas while retaining terminal metadata on the aggregate", async () => {
    delete process.env["OPENROUTER_API_KEY"];
    process.env["SURPLUS_API_KEY"] = "synthetic-surplus-key";
    setConfigOverrides({ nautilo_soul_generator_model: modelId });
    const configSpy = preferSurplus(true);
    let aggregate: AIMessage | undefined;
    const first = "## Essence\nA precise and distinctive generated identity ";
    const second = "with enough detail to be useful.\n\n## Tone\nWarm, exact, and candid.";
    const attemptSpy = spyOn(surplusAttempt, "invokeSurplusChatAttempt")
      .mockImplementation(async (input) => {
        aggregate = await input.invokeModel({
          async invoke() {
            throw new Error("streaming path must not call invoke");
          },
          async stream() {
            return {
              async *[Symbol.asyncIterator]() {
                yield new AIMessageChunk({ content: first });
                yield new AIMessageChunk({
                  content: second,
                  response_metadata: {
                    finish_reason: "stop",
                    usage: { prompt_tokens: 17, completion_tokens: 23, buyer_cost_micro: 41 },
                  },
                  usage_metadata: { input_tokens: 17, output_tokens: 23, total_tokens: 40 },
                } as never);
              },
            };
          },
        } as never, input.messages, input.config);
        return { kind: "served", response: aggregate };
      });

    try {
      const events = [];
      for await (const event of soulModule.generateSoulFileStream(
        { name: "Vex" }, undefined, SOUL_AUTHORIZATION,
      )) events.push(event);

      expect(events).toEqual([
        { type: "started" },
        { type: "delta", text: first },
        { type: "delta", text: second },
        { type: "completed", soulFile: first + second },
      ]);
      expect(aggregate?.response_metadata).toMatchObject({
        finish_reason: "stop",
        usage: { buyer_cost_micro: 41 },
      });
      expect(aggregate?.usage_metadata).toMatchObject({
        input_tokens: 17,
        output_tokens: 23,
        total_tokens: 40,
      });
    } finally {
      attemptSpy.mockRestore();
      configSpy.mockRestore();
    }
  });

  test("keeps policy-off Soul generation on the direct service-funded path", async () => {
    process.env["NAUTILO_TEST_MODE"] = "stub";
    process.env["SURPLUS_API_KEY"] = "synthetic-surplus-key";
    setConfigOverrides({ nautilo_soul_generator_model: modelId });
    const configSpy = preferSurplus(false);
    const attemptSpy = spyOn(surplusAttempt, "invokeSurplusChatAttempt");
    let observedContext: unknown;
    __setStubModelForTests({
      async invoke() {
        observedContext = getUsageContext();
        return new AIMessage({ content: generatedSoul });
      },
    });

    try {
      expect(await soulModule.generateSoulFile(
        { name: "Vex" }, undefined, SOUL_AUTHORIZATION,
      )).toBe(generatedSoul);
      expect(attemptSpy).not.toHaveBeenCalled();
      expect(observedContext).toMatchObject({
        callType: "soul",
        funding: { kind: "service", providerRoute: "openrouter" },
      });
    } finally {
      attemptSpy.mockRestore();
      configSpy.mockRestore();
    }
  });

  test("marks provider work observed when a direct stream emits before a 429", async () => {
    setConfigOverrides({ nautilo_soul_generator_model: modelId });
    const configSpy = preferSurplus(false);
    const partial = "## Essence\nVisible direct-provider output.";
    const providerError = Object.assign(new Error("late rate-limit response"), { status: 429 });
    const modelSpy = spyOn(universalProvider, "createUniversalModel").mockResolvedValue({
      async invoke() {
        throw new Error("streaming path must not call invoke");
      },
      async stream() {
        return {
          async *[Symbol.asyncIterator]() {
            yield new AIMessageChunk({ content: partial });
            throw providerError;
          },
        };
      },
    });
    let observedAtFailure = false;
    let failureClassification: ReturnType<typeof personalAttempt.classifyPersonalAttemptFailure> | undefined;
    const personalAttemptSpy = spyOn(personalAttempt, "runPersonalLlmAttempt")
      .mockImplementation(async (input) => {
        try {
          return await input.invoke();
        } catch (error) {
          observedAtFailure = input.hasObservedProviderWork?.() === true;
          failureClassification = personalAttempt.classifyPersonalAttemptFailure(
            error,
            false,
            observedAtFailure,
          );
          throw error;
        }
      });
    const stderr = spyOn(console, "error").mockImplementation(() => {});

    try {
      const events = [];
      for await (const event of soulModule.generateSoulFileStream(
        { name: "Vex" }, undefined, SOUL_AUTHORIZATION,
      )) events.push(event);
      expect(events[0]).toEqual({ type: "started" });
      expect(events[1]).toEqual({ type: "delta", text: partial });
      expect(events[2]).toMatchObject({
        type: "error",
        error: soulModule.SOUL_GENERATION_FAILED_MESSAGE,
      });
      expect(observedAtFailure).toBeTrue();
      expect(failureClassification).toEqual({
        outcome: "unknown",
        failureCode: "outcome_unknown",
        disposition: "terminal_unknown",
      });
      expect(personalAttemptSpy).toHaveBeenCalledTimes(1);
    } finally {
      stderr.mockRestore();
      personalAttemptSpy.mockRestore();
      modelSpy.mockRestore();
      configSpy.mockRestore();
    }
  });

  test("rechecks live authorization before a safe direct fallback", async () => {
    process.env["NAUTILO_TEST_MODE"] = "stub";
    process.env["SURPLUS_API_KEY"] = "synthetic-surplus-key";
    setConfigOverrides({ nautilo_soul_generator_model: modelId });
    const configSpy = preferSurplus(true);
    const attemptSpy = spyOn(surplusAttempt, "invokeSurplusChatAttempt")
      .mockResolvedValue({ kind: "direct_fallback" });
    let directInvoked = false;
    __setStubModelForTests({
      async invoke() {
        directInvoked = true;
        return new AIMessage({ content: generatedSoul });
      },
    });
    let checks = 0;

    try {
      await Promise.resolve(expect(soulModule.generateSoulFile({ name: "Vex" }, undefined, {
        humanUserId: "user-1",
        assertServerProviderCredentials: async (humanUserId, origin) => {
          checks++;
          if (checks > 1) throw new ServerProviderCredentialsDeniedError(humanUserId, origin);
        },
      })).rejects.toBeInstanceOf(ServerProviderCredentialsDeniedError));
      expect(checks).toBe(2);
      expect(directInvoked).toBeFalse();
    } finally {
      attemptSpy.mockRestore();
      configSpy.mockRestore();
    }
  });

  test("does not replay a streaming attempt after it delivered visible output", async () => {
    process.env["NAUTILO_TEST_MODE"] = "stub";
    process.env["SURPLUS_API_KEY"] = "synthetic-surplus-key";
    setConfigOverrides({ nautilo_soul_generator_model: modelId });
    const configSpy = preferSurplus(true);
    let directInvoked = false;
    __setStubModelForTests({
      async invoke() {
        directInvoked = true;
        return new AIMessage({ content: generatedSoul });
      },
    });
    const attemptSpy = spyOn(surplusAttempt, "invokeSurplusChatAttempt")
      .mockImplementation(async (input) => {
        await input.invokeModel({
          async invoke() {
            throw new Error("streaming path must not call invoke");
          },
          async stream() {
            return {
              async *[Symbol.asyncIterator]() {
                yield new AIMessageChunk({ content: "## Essence\nVisible partial output." });
              },
            };
          },
        } as never, input.messages, input.config);
        return { kind: "direct_fallback" };
      });

    try {
      const events = [];
      for await (const event of soulModule.generateSoulFileStream(
        { name: "Vex" }, undefined, SOUL_AUTHORIZATION,
      )) events.push(event);
      expect(events[0]).toEqual({ type: "started" });
      expect(events[1]).toEqual({ type: "delta", text: "## Essence\nVisible partial output." });
      expect(events[2]).toMatchObject({
        type: "error",
        error: soulModule.SOUL_GENERATION_FAILED_MESSAGE,
      });
      expect(directInvoked).toBeFalse();
      expect(attemptSpy).toHaveBeenCalledTimes(1);
    } finally {
      attemptSpy.mockRestore();
      configSpy.mockRestore();
    }
  });

  test("aborts a Surplus stream when its consumer closes after visible output", async () => {
    process.env["NAUTILO_TEST_MODE"] = "stub";
    process.env["SURPLUS_API_KEY"] = "synthetic-surplus-key";
    setConfigOverrides({ nautilo_soul_generator_model: modelId });
    const configSpy = preferSurplus(true);
    let directInvoked = false;
    let providerSignal: AbortSignal | undefined;
    __setStubModelForTests({
      async invoke() {
        directInvoked = true;
        return new AIMessage({ content: generatedSoul });
      },
    });
    const attemptSpy = spyOn(surplusAttempt, "invokeSurplusChatAttempt")
      .mockImplementation(async (input) => {
        providerSignal = input.config.signal;
        await input.invokeModel({
          async invoke() {
            throw new Error("streaming path must not call invoke");
          },
          async stream() {
            return {
              async *[Symbol.asyncIterator]() {
                yield new AIMessageChunk({ content: "## Essence\nVisible before close." });
                await new Promise<void>((resolve) => {
                  if (providerSignal?.aborted) resolve();
                  else providerSignal?.addEventListener("abort", () => resolve(), { once: true });
                });
                throw new Error("cancelled provider stream");
              },
            };
          },
        } as never, input.messages, input.config);
        throw new Error("expected cancellation");
      });

    try {
      const stream = soulModule.generateSoulFileStream(
        { name: "Vex" }, undefined, SOUL_AUTHORIZATION,
      );
      expect((await stream.next()).value).toEqual({ type: "started" });
      expect((await stream.next()).value).toEqual({
        type: "delta",
        text: "## Essence\nVisible before close.",
      });
      await stream.return(undefined);
      expect(providerSignal?.aborted).toBeTrue();
      expect(directInvoked).toBeFalse();
      expect(attemptSpy).toHaveBeenCalledTimes(1);
    } finally {
      attemptSpy.mockRestore();
      configSpy.mockRestore();
    }
  });
});
