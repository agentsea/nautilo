import { readFileSync } from "node:fs";

import { describe, expect, test } from "bun:test";

const EXECUTORS = [
  "../../src/executors/langgraph-executor.ts",
  "../../src/executors/fork-langgraph-executor.ts",
] as const;

function executorSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

describe("foreground entity crypto executor parity", () => {
  test("main and fork executors protect every foreground context family", () => {
    for (const relativePath of EXECUTORS) {
      const source = executorSource(relativePath);
      expect(source).toContain("enforceLiveShadowForegroundHistoryBoundary");
      expect(source).toContain("resolveForegroundHistoryMessages");
      expect(source).toContain("protectLiveShadowForegroundMemories");
      expect(source).toContain("protectLiveShadowForegroundRecordContext");
      expect(source).toContain("protectLiveShadowForegroundRecordRecall");
      expect(source).not.toContain("createLiveShadowForegroundMemorySearchPort");
      expect(source).toContain("prepareForegroundEncryptedContext");
    }
  });

  test("main and fork executors finish context protection before image-model work", () => {
    for (const relativePath of EXECUTORS) {
      const source = executorSource(relativePath);
      const memoryProtection = source.lastIndexOf(
        "protectLiveShadowForegroundMemories(",
      );
      const imageModel = source.lastIndexOf(
        "maybeSummarizeImagesWithVisionFallback({",
      );
      expect(memoryProtection).toBeGreaterThan(-1);
      expect(imageModel).toBeGreaterThan(memoryProtection);
    }
  });

  test("main and fork commit Memory overflow only after all retryable context", () => {
    for (const relativePath of EXECUTORS) {
      const source = executorSource(relativePath);
      const historyProtection = source.lastIndexOf(
        "resolveForegroundHistoryMessages({",
      );
      const overflowCommit = source.lastIndexOf(
        "commitPromptBriefMemoryOverflow(",
      );
      const imageModel = source.lastIndexOf(
        "maybeSummarizeImagesWithVisionFallback({",
      );
      expect(historyProtection).toBeGreaterThan(-1);
      expect(overflowCommit).toBeGreaterThan(historyProtection);
      expect(imageModel).toBeGreaterThan(overflowCommit);
    }
  });

  test("checkpoint construction stays behind foreground context protection", () => {
    for (const relativePath of EXECUTORS) {
      const source = executorSource(relativePath);
      const historyProtection = source.lastIndexOf(
        "resolveForegroundHistoryMessages({",
      );
      const checkpointConstruction = source.lastIndexOf(
        "checkpointSaverForConversationExecution(",
      );
      expect(historyProtection).toBeGreaterThan(-1);
      expect(checkpointConstruction).toBeGreaterThan(historyProtection);
    }
  });

  test("protected fork history excludes its already-persisted Human trigger", () => {
    const source = executorSource(
      "../../src/executors/fork-langgraph-executor.ts",
    );
    const historyCall = source.slice(
      source.indexOf("resolveForegroundHistoryMessages({"),
      source.indexOf("buildProtectedRoomTranscriptContext("),
    );
    expect(source).toContain(
      'typeof input["currentMessageId"] === "number"',
    );
    expect(historyCall).toContain(
      "...(currentMessageId != null ? { currentMessageId } : {})",
    );
  });

  test("fork initial Record selection uses the live Human query and signal", () => {
    const source = executorSource(
      "../../src/executors/fork-langgraph-executor.ts",
    );
    const historyCall = source.slice(
      source.indexOf("resolveForegroundHistoryMessages({"),
      source.indexOf("buildProtectedRoomTranscriptContext("),
    );
    expect(historyCall).toContain("currentHumanText: message");
    expect(historyCall).toContain("recordContext: initialRecordContext");
    expect(historyCall).toContain("signal,");
  });

  test("main and fork route only Strict Shadow graph state through encrypted checkpoints", () => {
    for (const relativePath of EXECUTORS) {
      const source = executorSource(relativePath);
      const encryptedConstruction = source.lastIndexOf(
        "createLiveShadowCheckpointSaver({",
      );
      const ordinaryFallback = source.lastIndexOf(
        "?? checkpointSaverForConversationExecution(undefined)",
      );
      expect(encryptedConstruction).toBeGreaterThan(-1);
      expect(ordinaryFallback).toBeGreaterThan(encryptedConstruction);
      expect(source).toContain(
        "requiresEncryptedForegroundCheckpoint(",
      );
      expect(source).toContain(
        "boundaryId: \"conversation.write.foreground_checkpoint\"",
      );
    }
  });
});
