import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { parseHumanTerminalOperation } from "../../../../types/src/human-terminal";

export const humanTerminalSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("read"), cursor: z.number().int().nonnegative().safe().optional() }).strict(),
  z.object({ action: z.literal("run"), command: z.string().min(1) }).strict(),
  z.object({ action: z.literal("write"), data: z.string() }).strict(),
]).superRefine((args, context) => {
  if (!parseHumanTerminalOperation(args)) context.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid Human Terminal operation" });
});

export function createHumanTerminalTool() {
  return new DynamicStructuredTool({
    name: "human_terminal",
    schema: humanTerminalSchema,
    description: "Use the exact existing Human terminal explicitly handed to this Genie in this conversation. read returns retained output since cursor (UTF-16 code units), with truncated and availableFrom indicating lost output. run sends command text plus one Enter to the current terminal program; it does not force a shell and only confirms input submission, never command completion or exit status. write sends raw input, including control characters, without Enter. run/write return only a submission receipt and a pre-input cursor; call read with that cursor to observe output. On capacity_reached, a fresh explicit Human handoff is required; never automatically retry input. No session selection, spawn, list or kill. If consent is absent or the Human takes control, stop and ask them to hand over the terminal again; do not retry an uncertain input.",
    func: () => Promise.reject(new Error("human_terminal requires the admitted Desktop Human terminal")),
  });
}
