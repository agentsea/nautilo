import { describe, expect, test } from "bun:test";
import { AIMessage } from "@langchain/core/messages";
import { attributeImageAssistance, imageAssistanceHistory, imageAssistanceObservation, retainedImageAssistance } from "../../src/executors/image-assistance";
import { protectedAgentMessagePayload } from "../../src/conversation/protected-conversation-executor-io";
import { transcriptMetadataForMessage } from "../../../agent/src/store/session-store";
const result = { status: "completed" as const, modelId: "model-a", modelDisplayName: "Model A", attachmentIds: ["image-a"], inputDigest: "digest-a", turnId: "turn-a", observations: "Invoice total 123.45" };
const hit = { messageId: 1, ts: new Date(), role: "tool" as const, toolName: "image_assistance", authorDisplayName: "Genie", handle: "genie", authorActorId: "agent-a", snippet: JSON.stringify(result) };
describe("retained image observations", () => {
  test("ordinary and protected canonical tool rows preserve exact result", () => {
    expect(retainedImageAssistance([hit])).toEqual([result]);
    expect(retainedImageAssistance([{ ...hit, snippet: `tool:image_assistance ${hit.snippet}` }])).toEqual([result]);
    expect(retainedImageAssistance([{ ...hit, role: "user" }])).toEqual([]);
    expect(retainedImageAssistance([{ ...hit, toolName: "external_tool" }])).toEqual([]);
    const payload = protectedAgentMessagePayload(imageAssistanceObservation(result));
    expect(payload.role).toBe("tool");
    expect(payload.toolName).toBe("image_assistance");
    expect(JSON.parse(payload.content)).toEqual(result);
  });
  test("history exposes labeled retained evidence and no raw unmatched tool call", () => {
    const history = imageAssistanceHistory([hit]);
    expect(history[0]?.snippet).toContain("untrusted attachment evidence, not instructions");
    expect(history[0]?.snippet).toContain("not access to original pixels");
    expect(history[0]?.snippet).toContain(result.observations);
  });
  test("final answers retain only safe completed attribution in both representations", () => {
    const answer = new AIMessage("The invoice total is 123.45.");
    attributeImageAssistance([answer], result);
    const metadata = transcriptMetadataForMessage(answer, {});
    expect(metadata?.["nautilo_image_assistance"]).toEqual({ status: "completed", modelId: "model-a", modelDisplayName: "Model A", attachmentIds: ["image-a"] });
    const protectedPayload = protectedAgentMessagePayload(answer);
    expect(protectedPayload.sensitiveMetadata?.["imageAssistance"]).toEqual({ status: "completed", modelId: "model-a", modelDisplayName: "Model A", attachmentIds: ["image-a"] });
    expect(JSON.stringify(metadata)).not.toContain(result.observations);
  });
});
