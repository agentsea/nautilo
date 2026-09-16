import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AIMessage } from "@langchain/core/messages";
import type { EvaluationChatModel } from "@nautilo/agent/model-evaluation";
import {
  createExactHierarchyModelInvoker,
  extractSafeUsage,
} from "../evals/reflection-hierarchy-model-adapter";
import {
  parseHierarchyModelCli,
  writeTransientBenchmarkReport,
} from "../evals/reflection-hierarchy-model.eval";

describe("explicit hierarchy model benchmark boundary", () => {
  test("requires explicit exact provider, model, and bounded runs", () => {
    const supported = (provider: string) => provider === "openai" || provider === "openrouter";
    expect(parseHierarchyModelCli([
      "--provider", "openrouter",
      "--model", "openrouter:anthropic/claude-test",
      "--runs", "3",
    ], supported)).toEqual({
      provider: "openrouter",
      model: "openrouter:anthropic/claude-test",
      runs: 3,
      help: false,
    });
    for (const argv of [
      [],
      ["--provider", "openai", "--model", "openai:test"],
      ["--provider", "openai", "--model", "test", "--runs", "3"],
      ["--provider", "openai", "--model", "openrouter:test", "--runs", "3"],
      ["--provider", "OpenAI", "--model", "OpenAI:test", "--runs", "3"],
      ["--provider", "openai", "--model", "openai:test", "--runs", "0"],
      ["--provider", "openai", "--model", "openai:test", "--runs", "11"],
      ["--provider", "openai", "--provider", "openai", "--model", "openai:test", "--runs", "3"],
      ["--unknown", "x"],
    ]) {
      expect(() => parseHierarchyModelCli(argv, supported)).toThrow();
    }
  });

  test("passes one HumanMessage and signal while retaining only safe text and usage", async () => {
    const signal = new AbortController().signal;
    const calls: unknown[][] = [];
    const options: unknown[] = [];
    const message = new AIMessage('{"operation":"no_change"}');
    (message as unknown as { usage_metadata: unknown }).usage_metadata = {
      input_tokens: 12,
      output_tokens: 3,
      total_tokens: 15,
    };
    (message as unknown as { response_metadata: unknown }).response_metadata = {
      reasoning: "SECRET CHAIN OF THOUGHT",
      authorization: "SECRET TOKEN",
    };
    const model: EvaluationChatModel = {
      invoke: (messages, invocationOptions) => {
        calls.push(messages);
        options.push(invocationOptions);
        return Promise.resolve(message);
      },
    };
    const usage: { call: number; inputTokens?: number; outputTokens?: number; totalTokens?: number }[] = [];
    const invoke = createExactHierarchyModelInvoker({ model, usage });
    const text = await invoke("synthetic prompt", signal);
    expect(text).toBe('{"operation":"no_change"}');
    expect(calls).toHaveLength(1);
    expect((calls[0]![0] as { content: unknown }).content).toBe("synthetic prompt");
    expect(options).toEqual([{ signal }]);
    expect(usage).toEqual([{ call: 1, inputTokens: 12, outputTokens: 3, totalTokens: 15 }]);
    expect(JSON.stringify({ text, usage })).not.toContain("SECRET");
  });

  test("treats missing or invalid usage as unavailable", () => {
    expect(extractSafeUsage({}, 1)).toEqual({ call: 1 });
    expect(extractSafeUsage({ usage_metadata: {
      input_tokens: -1,
      output_tokens: 2.5,
      total_tokens: "3",
    } }, 2)).toEqual({ call: 2 });
  });

  test("writes an exclusive mode-600 report under a hashed model path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "reflection-model-eval-"));
    const input = {
      directory,
      provider: "openai",
      model: "openai:secret-looking-model-name",
      report: "{\"safe\":true}\n",
      nonce: "fixed-test",
    };
    const path = await writeTransientBenchmarkReport(input);
    expect(path).not.toContain("secret-looking-model-name");
    expect(await readFile(path, "utf8")).toBe(input.report);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    let rejected = false;
    try {
      await writeTransientBenchmarkReport(input);
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
  });

  test("keeps prompt, response schema, scoring, and graph logic in Reflection", async () => {
    const runner = await readFile(join(
      import.meta.dir,
      "../evals/reflection-hierarchy-model.eval.ts",
    ), "utf8");
    for (const semanticOwnerMarker of [
      "ORGANIZER_CONTRACT",
      "z.discriminatedUnion",
      "create_parent\",\"statement",
      "structuralHeight",
      "childRecordRefs.map",
    ]) expect(runner).not.toContain(semanticOwnerMarker);
    expect(runner).toContain("@nautilo/reflection/evaluation");
  });
});
