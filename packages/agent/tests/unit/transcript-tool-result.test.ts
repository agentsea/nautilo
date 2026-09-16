import { expect, test } from "bun:test";
import { AIMessage, ToolMessage } from "@langchain/core/messages";
import { transcriptMetadataForMessage, visibleTranscriptContent } from "../../src/store/session-store";
import { readTranscriptToolPresentation } from "../../src/store/transcript-tool-result";

test("actual tool failure survives persisted presentation metadata without altering canonical source", () => {
  for (const legacy of [false, true]) {
    const message = new ToolMessage({ name: "file", tool_call_id: "read-1", content: "Recovery is active. New investigation has not executed.",
      status: legacy ? "success" : "error", additional_kwargs: legacy ? { nautilo_tool_status: "error", privateSidecar: "hidden" } : {} });
    const before = message.toDict();
    const metadata = transcriptMetadataForMessage(message, { metadata: { task: "preserved" } });
    expect(readTranscriptToolPresentation(JSON.parse(JSON.stringify(metadata)))).toEqual({ toolCallId: "read-1", toolStatus: "error" });
    expect(metadata).toMatchObject({ task: "preserved" });
    expect(JSON.stringify(metadata)).not.toContain("privateSidecar");
    expect(visibleTranscriptContent(message)).toBe("Recovery is active. New investigation has not executed.");
    expect(message.toDict()).toEqual(before);
  }
});

test("success source containing error words remains success and absent legacy status remains unknown", () => {
  const message = new ToolMessage({ name: "file", tool_call_id: "read-2", status: "success", content: 'Error: this is literal source text' });
  expect(readTranscriptToolPresentation(transcriptMetadataForMessage(message, {}))).toEqual({ toolCallId: "read-2", toolStatus: "success" });
  expect(readTranscriptToolPresentation({})).toEqual({});
  expect(readTranscriptToolPresentation({ nautilo_tool_result: { toolStatus: "succeeded", privateSidecar: "hidden" } })).toEqual({});
  expect(transcriptMetadataForMessage(new AIMessage("tool failure"), {})).toBeNull();
});
