import { afterEach, describe, expect, test } from "bun:test";
import {
  AgentInvocationRequiredError,
  ArtifactWriteRequiredError,
  NautiloApiClient,
} from "../../src/client";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function installResponse(body: unknown): void {
  const mockFetch = async () => new Response(JSON.stringify(body), {
    status: 403,
    headers: { "content-type": "application/json" },
  });
  globalThis.fetch = Object.assign(mockFetch, {
    preconnect: originalFetch.preconnect?.bind(originalFetch),
  }) as typeof fetch;
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return new Error("Expected request to reject");
  } catch (error: unknown) {
    return error;
  }
}

describe("M254 shared invocation denial projection", () => {
  test("projects the exact denial as the exported typed error", async () => {
    installResponse({
      error: "invoke_agents_required",
      code: "invoke_agents_required",
      capability: "invoke_agents",
    });
    const client = new NautiloApiClient("http://127.0.0.1:9");
    const error = await rejectionOf(client.createBackgroundJob({ task: "x" }));
    expect(error).toBeInstanceOf(AgentInvocationRequiredError);
    expect(error).toMatchObject({
      status: 403,
      code: "invoke_agents_required",
      capability: "invoke_agents",
    });
  });

  test("does not misclassify a partial or route-specific 403", async () => {
    installResponse({ error: "Forbidden", code: "invoke_agents_required" });
    const client = new NautiloApiClient("http://127.0.0.1:9");
    const error = await rejectionOf(client.createBackgroundJob({ task: "x" }));
    expect(error).not.toBeInstanceOf(AgentInvocationRequiredError);
    expect(error).toMatchObject({ status: 403, message: "Forbidden" });
  });

  test("applies to browser-facing message, Codex, resume, and ping methods", async () => {
    installResponse({
      error: "invoke_agents_required",
      code: "invoke_agents_required",
      capability: "invoke_agents",
    });
    const client = new NautiloApiClient("http://127.0.0.1:9");
    const calls = [
      client.sendRoomMessage("room", { content: "hello" }),
      client.codex.respondRequest("request", {
        kind: "command_approval_required",
        decision: "approve",
      }),
      client.approvalReply("once", "thread"),
      client.pingArtifactEvent("artifact", "topic", {}),
    ];
    const errors = await Promise.all(calls.map(rejectionOf));
    expect(errors.every((error) => error instanceof AgentInvocationRequiredError)).toBe(true);
  });
});

describe("M259 shared Artifact-write denial projection", () => {
  test("projects the exact denial before route-specific 403 handling", async () => {
    installResponse({
      error: "write_artifacts_required",
      code: "write_artifacts_required",
      capability: "write_artifacts",
    });
    const client = new NautiloApiClient("http://127.0.0.1:9");

    const errors = await Promise.all([
      client.setArtifactState("artifact", "key", true),
      client.emitArtifactEvent("artifact", "topic", {}),
      client.renameWorkspaceArtifact("artifact", "renamed.md"),
      client.deleteWorkspaceArtifact("artifact"),
    ].map(rejectionOf));

    expect(errors.every((error) => error instanceof ArtifactWriteRequiredError)).toBe(true);
    expect(errors[0]).toMatchObject({
      status: 403,
      code: "write_artifacts_required",
      capability: "write_artifacts",
    });
  });

  test("invalidates viewer authority once and never retries the denied mutation", async () => {
    let requests = 0;
    const mockFetch = async () => {
      requests += 1;
      return new Response(JSON.stringify({
        error: "write_artifacts_required",
        code: "write_artifacts_required",
        capability: "write_artifacts",
      }), { status: 403, headers: { "content-type": "application/json" } });
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: originalFetch.preconnect?.bind(originalFetch),
    }) as typeof fetch;
    const client = new NautiloApiClient("http://127.0.0.1:9");
    let invalidations = 0;
    client.setActionCapabilityDenialHandler(() => { invalidations += 1; });

    const error = await rejectionOf(client.deleteWorkspaceArtifact("artifact"));

    expect(error).toBeInstanceOf(ArtifactWriteRequiredError);
    expect(requests).toBe(1);
    expect(invalidations).toBe(1);
  });
});
