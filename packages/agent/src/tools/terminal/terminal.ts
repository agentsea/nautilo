import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";

import { RETIRED_LOCAL_EXECUTION_MESSAGE } from "../shell/run-shell";

/** Narrow compatibility tombstone for persisted legacy calls. */
export function createRetiredTerminalTool() {
  return new DynamicStructuredTool({
    name: "terminal",
    description: RETIRED_LOCAL_EXECUTION_MESSAGE,
    schema: z.object({}).strict(),
    func: () => Promise.reject(new Error(RETIRED_LOCAL_EXECUTION_MESSAGE)),
  });
}
