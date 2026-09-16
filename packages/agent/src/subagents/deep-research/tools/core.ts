import { interpolate } from "../prompts/interpolate";
import {
  CLARIFY_WITH_USER_PROMPT,
  LEAD_RESEARCHER_PROMPT,
  RESEARCH_SYSTEM_PROMPT,
  COMPRESS_RESEARCH_PROMPT,
  FINAL_REPORT_PROMPT,
} from "../prompts/templates";
import type { ClarifyWithUser, ConductResearch, ResearchComplete } from "../shared/types";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";

export function buildClarifyWithUserPrompt(messagesMarkdown: string): string {
  const date = new Date().toISOString().slice(0, 10);
  return interpolate(CLARIFY_WITH_USER_PROMPT, { date, messages: messagesMarkdown });
}

export function buildLeadResearcherPrompt(params: {
  max_researcher_iterations: number;
  max_concurrent_research_units: number;
}): string {
  const date = new Date().toISOString().slice(0, 10);
  return interpolate(LEAD_RESEARCHER_PROMPT, {
    date,
    max_researcher_iterations: String(params.max_researcher_iterations),
    max_concurrent_research_units: String(params.max_concurrent_research_units),
  });
}

export function buildResearchSystemPrompt(mcpPromptSection: string): string {
  const date = new Date().toISOString().slice(0, 10);
  return interpolate(RESEARCH_SYSTEM_PROMPT, { date, mcp_prompt: mcpPromptSection });
}

export function buildCompressResearchPrompt(): string {
  const date = new Date().toISOString().slice(0, 10);
  return interpolate(COMPRESS_RESEARCH_PROMPT, { date });
}

export function buildFinalReportPrompt(args: {
  research_brief: string;
  messages: string;
  findings: string;
  report_language: string;
}): string {
  const date = new Date().toISOString().slice(0, 10);
  return interpolate(FINAL_REPORT_PROMPT, { date, ...args });
}

export const researchCompleteTool = new DynamicStructuredTool({
  name: "ResearchComplete",
  description: "Call this when you have gathered sufficient information to thoroughly answer the research topic.",
  schema: z.object({}),
  func: () => Promise.resolve("Research task completed successfully."),
});

export const conductResearchTool = new DynamicStructuredTool({
  name: "ConductResearch",
  description: "Delegate a specific research topic to a specialized sub-agent researcher.",
  schema: z.object({
    research_topic: z.string().describe("Specific, focused research topic for the sub-agent to investigate thoroughly"),
  }),
  func: ({ research_topic }: { research_topic: string }) =>
    Promise.resolve(`Research delegated: ${research_topic}`),
});

export const thinkTool = new DynamicStructuredTool({
  name: "think_tool",
  description: "Strategic reflection tool for research planning. Use after receiving search results to analyze findings, assess gaps, evaluate quality, and decide next steps.",
  schema: z.object({
    reflection: z.string().describe("Your detailed analysis of current research progress"),
  }),
  func: ({ reflection }: { reflection: string }) =>
    Promise.resolve(`Reflection recorded: ${reflection}`),
});

export type { ClarifyWithUser, ConductResearch, ResearchComplete };
