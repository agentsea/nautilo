import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { setLogOutput } from "@nautilo/logger";
import { setConfigOverrides } from "@nautilo/config";
import { generateSoulFileFallback, normalizeSoulFileInput } from "../../src/index";
import * as soulModule from "../../src/soul/generate-soul-file";
import { __setStubModelForTests } from "../../src/providers/universal";
import type { ChatModel } from "../../src/providers/types";
import { ServerProviderCredentialsDeniedError } from "@nautilo/trust";

const SOUL_AUTHORIZATION = {
  humanUserId: "user-1",
  assertServerProviderCredentials: async () => {},
} as const;

let originalOpenRouterKey: string | undefined;

beforeEach(() => {
  originalOpenRouterKey = process.env["OPENROUTER_API_KEY"];
  process.env["OPENROUTER_API_KEY"] = "test-openrouter-key";
});

afterEach(() => {
  setConfigOverrides({});
  if (process.env["NAUTILO_TEST_MODE"] === "stub") {
    __setStubModelForTests(null);
  }
  delete process.env["NAUTILO_TEST_MODE"];
  if (originalOpenRouterKey === undefined) delete process.env["OPENROUTER_API_KEY"];
  else process.env["OPENROUTER_API_KEY"] = originalOpenRouterKey;
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
});
