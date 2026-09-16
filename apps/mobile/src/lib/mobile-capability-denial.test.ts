import {
  AgentInvocationRequiredError,
  ArtifactWriteRequiredError,
} from "@nautilo/api-client/browser";
import { describe, expect, test } from "bun:test";

import {
  INVOKE_AGENTS_REQUIRED_COPY,
  WRITE_ARTIFACTS_REQUIRED_COPY,
  classifyMobileCapabilityDenial,
  recoverMobileCapabilityDenial,
  type MobileCapabilityScope,
} from "./mobile-capability-denial";

const scope: MobileCapabilityScope = { serverId: "server-a", userId: "user-a" };

describe("Mobile capability denial recovery", () => {
  test("recognizes typed and stable-code invocation denials before generic errors", () => {
    expect(classifyMobileCapabilityDenial(new AgentInvocationRequiredError())).toEqual({
      capability: "invoke_agents",
      message: INVOKE_AGENTS_REQUIRED_COPY,
    });
    expect(classifyMobileCapabilityDenial(new Error("invoke_agents_required"))).toEqual({
      capability: "invoke_agents",
      message: INVOKE_AGENTS_REQUIRED_COPY,
    });
  });

  test("recognizes typed and stable-code Artifact denials", () => {
    expect(classifyMobileCapabilityDenial(new ArtifactWriteRequiredError())).toEqual({
      capability: "write_artifacts",
      message: WRITE_ARTIFACTS_REQUIRED_COPY,
    });
    expect(classifyMobileCapabilityDenial({ code: "write_artifacts_required" })).toEqual({
      capability: "write_artifacts",
      message: WRITE_ARTIFACTS_REQUIRED_COPY,
    });
  });

  test("refreshes the exact still-active scope once and never receives a retry closure", async () => {
    let refreshes = 0;
    const result = await recoverMobileCapabilityDenial({
      error: new AgentInvocationRequiredError(),
      actionScope: scope,
      getCurrentScope: () => scope,
      refreshViewer: async () => {
        refreshes += 1;
        return "verified";
      },
    });
    expect(result).toEqual({ capability: "invoke_agents", message: INVOKE_AGENTS_REQUIRED_COPY });
    expect(refreshes).toBe(1);
  });

  test("makes old-server and old-Human denials inert before refresh", async () => {
    for (const current of [
      { serverId: "server-b", userId: "user-a" },
      { serverId: "server-a", userId: "user-b" },
      null,
    ]) {
      let refreshes = 0;
      const result = await recoverMobileCapabilityDenial({
        error: new AgentInvocationRequiredError(),
        actionScope: scope,
        getCurrentScope: () => current,
        refreshViewer: async () => {
          refreshes += 1;
          return "verified";
        },
      });
      expect(result).toBeNull();
      expect(refreshes).toBe(0);
    }
  });

  test("makes a completion inert if the scope changes during refresh", async () => {
    let current: MobileCapabilityScope | null = scope;
    const result = await recoverMobileCapabilityDenial({
      error: new ArtifactWriteRequiredError(),
      actionScope: scope,
      getCurrentScope: () => current,
      refreshViewer: async () => {
        current = { serverId: "server-b", userId: "user-a" };
        return "stale";
      },
    });
    expect(result).toBeNull();
  });

  test("does not refresh generic failures", async () => {
    let refreshes = 0;
    expect(await recoverMobileCapabilityDenial({
      error: new Error("offline"),
      actionScope: scope,
      getCurrentScope: () => scope,
      refreshViewer: async () => {
        refreshes += 1;
        return "failed";
      },
    })).toBeNull();
    expect(refreshes).toBe(0);
  });
});
