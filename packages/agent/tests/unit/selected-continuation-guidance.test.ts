import { describe, expect, test } from "bun:test";
import type { StructuredTool } from "@langchain/core/tools";
import { buildSystemPrompt } from "../../src/prompts/templates";

const tools = [] as StructuredTool[];

function renderPrompt(params: {
  assistantName?: string;
  isGuest?: boolean;
  explicitlySelected?: boolean;
} = {}): string {
  return buildSystemPrompt({
    assistantName: params.assistantName ?? "Juniper",
    isGuest: params.isGuest ?? false,
    ...(params.explicitlySelected === undefined ? {} : { explicitlySelected: params.explicitlySelected }),
    tools,
  });
}

describe("explicitly selected continuation guidance", () => {
  test("interprets current-run narration and successful tools as already-delivered progress", () => {
    const prompt = renderPrompt({ explicitlySelected: true });

    expect(prompt).toMatch(/latest accepted Human request/i);
    expect(prompt).toContain("Completed progress in the current logical turn");
    expect(prompt).toMatch(/earlier assistant responses[\s\S]*already delivered to (?:the )?Human/i);
    expect(prompt).toMatch(/successful tool results[\s\S]*already executed actions/i);
  });

  test("closes briefly only after fulfillment and continues unfinished or later input", () => {
    const prompt = renderPrompt({ explicitlySelected: true });

    expect(prompt).toMatch(
      /if[^.]*latest request[^.]*fulfilled[^.]*required tools[^.]*succeeded[^.]*brief closing remark/i,
    );
    expect(prompt).toMatch(/do not repeat[^.]*full answer[^.]*recap[^.]*Memory save/i);
    expect(prompt).toMatch(/unfinished[^.]*must continue/i);
    expect(prompt).toMatch(/later accepted Human (?:input|request)[^.]*must continue/i);
    expect(prompt).toMatch(/surrounding Room activity[^.]*not[^.]*your own completion/i);
    expect(prompt).not.toContain("do not defer to another assistant or stay silent");
  });

  test("uses the runtime assistant identity instead of a hard-coded assistant name", () => {
    const prompt = renderPrompt({
      assistantName: "Juniper",
      explicitlySelected: true,
    });

    expect(prompt).toContain("You are Juniper");
    expect(prompt).toContain("Completed progress in the current logical turn");
    expect(prompt).toMatch(/your name and handle/i);
    expect(prompt).not.toContain("Sage");
  });

  test("keeps continuation guidance gated to explicitly selected owner turns", () => {
    const notSelected = renderPrompt({ explicitlySelected: false });
    const selectedGuest = renderPrompt({
      explicitlySelected: true,
      isGuest: true,
    });

    for (const prompt of [notSelected, selectedGuest]) {
      expect(prompt).not.toContain("Completed progress in the current logical turn");
      expect(prompt).not.toMatch(/latest accepted Human request/i);
      expect(prompt).not.toMatch(/brief closing remark/i);
    }
    expect(selectedGuest).toContain("guest mode with restricted access");
  });
});
