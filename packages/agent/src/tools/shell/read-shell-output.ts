import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { outputArtifactPageSchema, outputArtifactSearchSchema } from "./output-artifact-schema";

export const readShellOutputSchema = z.discriminatedUnion("operation", [
  outputArtifactPageSchema.extend({ operation: z.literal("page") }).strict(),
  outputArtifactSearchSchema,
]);

export function createReadShellOutputTool() {
  return new DynamicStructuredTool({
    name: "read_shell_output",
    schema: readShellOutputSchema,
    description:
      "Read or literally search retained output using an outputArtifact.reference from a prior shell result. " +
      "This never launches a command. For a known error, path, or test name, use operation:search; inspect its " +
      "stream-local match offsets and artifact offsets, then page nearby with operation:page as needed. " +
      "Continue pages with nextOffsetBytes. capturedBytes, totalBytes and truncated describe capture completeness; " +
      "a truncated capture cannot be recovered by paging. References are private to their original authenticated " +
      "Desktop session and expire as stated in the result. Missing or expired output is unavailable: never rerun " +
      "a command merely to recover it. delete_after_read removes an artifact only when the requested page reaches " +
      "the end; omit it when another read may be needed. For managed exec_command session_id results, use write_stdin.",
    func: () => Promise.reject(new Error("read_shell_output requires the admitted Desktop executor")),
  });
}
