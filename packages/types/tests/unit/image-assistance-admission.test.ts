import { describe, expect, test } from "bun:test";

import {
  parseImageAssistanceAdmission,
  type ImageAssistanceAdmission,
} from "../../src/image-assistance-admission";

const admission = (): ImageAssistanceAdmission => ({
  formatVersion: 1,
  jobId: "job-1",
  humanUserId: "human-1",
  roomId: "room-1",
  agentId: "agent-1",
  turnId: "turn-1",
  entrypoint: "foreground.main",
  mainModelId: "openai:gpt-main",
  inputCommitment: `hmac-sha256:${"a".repeat(64)}`,
  operationId: "image-assistance:job-1",
  modelId: "openai:gpt-image-helper",
  preferenceRevision: 0,
  serverSelection: null,
  funding: { kind: "server", providerRoute: "openai" },
  state: "admitted",
});

describe("image assistance admission", () => {
  test("parses the exact non-content protocol and known funding binding", () => {
    expect(parseImageAssistanceAdmission(admission())).toEqual(admission());
    expect(parseImageAssistanceAdmission({
      ...admission(),
      entrypoint: "foreground.fork",
      preferenceRevision: 4,
      serverSelection: "server-default",
      funding: {
        kind: "personal",
        providerRoute: "openai",
        credentialId: "10000000-0000-4000-8000-000000000001",
        credentialRevision: 7,
      },
      state: "dispatched",
    })).toMatchObject({
      entrypoint: "foreground.fork",
      preferenceRevision: 4,
      serverSelection: "server-default",
      state: "dispatched",
      funding: { kind: "personal", credentialRevision: 7 },
    });
  });

  test("rejects widened, content-bearing, malformed, and nondeterministic shapes", () => {
    for (const value of [
      null,
      { ...admission(), question: "what is shown?" },
      { ...admission(), image: "data:image/png;base64,secret" },
      { ...admission(), inputCommitment: "a".repeat(64) },
      { ...admission(), inputCommitment: "A".repeat(64) },
      { ...admission(), inputCommitment: "a".repeat(63) },
      { ...admission(), operationId: "image-assistance:another-job" },
      { ...admission(), entrypoint: "background.task" },
      { ...admission(), preferenceRevision: -1 },
      { ...admission(), preferenceRevision: 1.5 },
      { ...admission(), modelId: "   " },
      { ...admission(), serverSelection: "" },
      { ...admission(), state: "completed" },
      { ...admission(), funding: { kind: "server", providerRoute: "openai", apiKey: "secret" } },
    ]) {
      expect(() => parseImageAssistanceAdmission(value)).toThrow(TypeError);
    }
  });
});
