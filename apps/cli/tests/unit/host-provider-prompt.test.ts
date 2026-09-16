import { describe, expect, test } from "bun:test";

import {
  createHostProviderPrompter,
  type HostProviderPromptIo,
} from "../../src/lib/host-provider-prompt.ts";

function promptIo(lines: readonly string[], secrets: readonly string[]): {
  readonly io: HostProviderPromptIo;
  readonly output: string[];
  readonly prompts: string[];
} {
  const output: string[] = [];
  const prompts: string[] = [];
  let lineIndex = 0;
  let secretIndex = 0;
  return {
    io: {
      write: (value) => output.push(value),
      readLine: async (prompt) => {
        prompts.push(prompt);
        return lines[lineIndex++] ?? "";
      },
      readSecret: async (prompt) => {
        prompts.push(prompt);
        return secrets[secretIndex++] ?? "";
      },
    },
    output,
    prompts,
  };
}

describe("Railway interactive provider prompt", () => {
  test("collects only selected canonical provider values through hidden input", async () => {
    const openRouter = `sk-or-v1-${"o".repeat(40)}`;
    const tavily = `tvly-${"t".repeat(20)}`;
    const fixture = promptIo(["m", "tavily,openrouter"], [openRouter, tavily]);

    const result = await createHostProviderPrompter(fixture.io).choose({
      detectedProviders: ["openrouter"],
    });

    expect(result).toEqual({
      kind: "manual",
      providers: new Map([
        ["openrouter", openRouter],
        ["tavily", tavily],
      ]),
    });
    expect(fixture.prompts).toContain("OpenRouter API key (input hidden): ");
    expect(fixture.prompts).toContain("Tavily API key (input hidden): ");
    expect(fixture.output.join("")).not.toContain(openRouter);
    expect(fixture.output.join("")).not.toContain(tavily);
  });

  test("allows an explicit TOML path and a deliberate skip without reading a secret", async () => {
    const tomlPath = "/private/providers.toml";
    const toml = promptIo(["f"], [tomlPath]);
    const tomlResult = await createHostProviderPrompter(toml.io).choose({ detectedProviders: [] });
    expect(tomlResult).toEqual({
      kind: "toml",
      providerConfigPath: "/private/providers.toml",
    });
    expect(toml.output.join("")).not.toContain(tomlPath);
    expect(toml.prompts).toContain("Provider TOML path (input hidden): ");

    const skip = promptIo(["s"], []);
    const skipResult = await createHostProviderPrompter(skip.io).choose({ detectedProviders: ["tavily"] });
    expect(skipResult).toEqual({
      kind: "skip",
    });
    expect(skip.prompts.some((prompt) => prompt.includes("API key"))).toBe(false);
  });

  test("keeps repair bounded to the original selected providers", async () => {
    const openRouter = `sk-or-v1-${"r".repeat(40)}`;
    const fixture = promptIo(["yes"], [openRouter]);
    const result = await createHostProviderPrompter(fixture.io).repair({ providers: ["openrouter"] });

    expect(result).toEqual(new Map([["openrouter", openRouter]]));
    expect(fixture.prompts).toEqual([
      "Enter those keys now? [y/N]: ",
      "OpenRouter API key (input hidden): ",
    ]);
    expect(fixture.output.join("")).not.toContain(openRouter);
  });
});
