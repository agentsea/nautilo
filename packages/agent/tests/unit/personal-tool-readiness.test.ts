import { describe, expect, test } from "bun:test";
import type { TaskFundingBinding } from "@nautilo/types";
import { ToolCatalog } from "@nautilo/catalog";

import {
  personalToolCallSupported,
  personalToolReady,
  personalToolUnavailable,
} from "../../src/runtime/personal-tool-readiness";
import {
  runWithCapabilityFundingSession,
  type CapabilityFundingSession,
} from "../../src/runtime/capability-funding";
import { registerAllTools } from "../../src/tools/register-all";

const binding: TaskFundingBinding = {
  kind: "personal",
  providerRoute: "openrouter",
  credentialId: "credential-a",
  credentialRevision: 1,
};

const capabilityFunding: CapabilityFundingSession = {
  humanUserId: "human-a",
  decisionModelId: "openrouter:example/model",
  async resolveModel() {
    return { modelId: "openrouter:example/model", preferenceRevision: 1 };
  },
  async openModel() {
    throw new Error("not used by readiness tests");
  },
  async openService() {
    return {
      binding,
      async runAttempt() { throw new Error("not used by readiness tests"); },
    };
  },
};

const serverCapabilityFunding: CapabilityFundingSession = {
  ...capabilityFunding,
  parentFundingKind: "server",
};

const call = (name: string, args: Record<string, unknown> = {}) => ({ name, args });

describe("personal tool readiness", () => {
  test("ordinary file, local browser, conversion, research, and decision tools require trusted capability scope", () => {
    const admitted = [
      "file",
      "browser_snapshot",
      "convert",
      "run_deep_research",
      "evaluate_decisions",
    ];

    for (const name of admitted) {
      expect(personalToolReady(name)).toBe(false);
      expect(personalToolCallSupported(call(name), false)).toBe(false);
      expect(personalToolUnavailable(name)).toBeNull();
    }

    runWithCapabilityFundingSession(capabilityFunding, () => {
      for (const name of admitted) {
        expect(personalToolReady(name)).toBe(true);
        expect(personalToolCallSupported(call(name), false)).toBe(true);
        expect(personalToolUnavailable(name)).toBeNull();
      }
    });
  });

  test("deferred media, security, and paid multi-agent workflows remain denied inside capability scope", () => {
    runWithCapabilityFundingSession(capabilityFunding, () => {
      for (const name of [
        "generate_image",
        "generate_video",
        "transcribe_audio",
        "security_scan",
        "ask_peer",
        "in_scope",
        "in_private_namespace",
        "browse_web",
        "run_website_task",
      ]) {
        expect(personalToolReady(name)).toBe(false);
        expect(personalToolCallSupported(call(name), true)).toBe(false);
        expect(personalToolUnavailable(name)).toBe("Personal funding is not available for this workflow yet.");
      }
    });
  });

  test("server-funded parent scope keeps deferred tools on their ordinary readiness path", () => {
    runWithCapabilityFundingSession(serverCapabilityFunding, () => {
      for (const name of ["generate_image", "browse_web", "run_website_task"]) {
        expect(personalToolUnavailable(name)).toBeNull();
      }
    });
  });

  test("legacy personal text sessions retain only strict task controls", () => {
    expect(personalToolCallSupported(call("task", {
      command: "create",
      prompt: "Summarize this",
      model_id: "openrouter:example/model",
    }), true)).toBe(true);
    expect(personalToolCallSupported(call("discover_models", {
      command: "search",
      query: "small reasoning model",
      workload: "chat",
      output: "text",
    }), true)).toBe(true);

    expect(personalToolCallSupported(call("task", {
      command: "create",
      prompt: "Contact another Human",
      target_users: ["human-b"],
    }), true)).toBe(false);
    expect(personalToolCallSupported(call("discover_models", {
      command: "search",
      workload: "research",
    }), true)).toBe(false);
    expect(personalToolCallSupported(call("file", { command: "read" }), true)).toBe(false);
    expect(personalToolCallSupported(call("task", { command: "list" }), false)).toBe(false);
  });

  test("capability funding does not remove catalog permission or live-readiness gates", () => {
    const catalog = new ToolCatalog();
    registerAllTools(catalog, {
      officeCliAvailable: () => false,
      decisionModelsAvailable: () => true,
      mediaGenerationAvailable: () => false,
    });

    expect(catalog.get("file")?.requiredCapabilities).toEqual(["use_project_content"]);
    expect(catalog.get("convert")?.requiredCapabilities).toEqual(["use_project_content"]);
    expect(catalog.get("run_deep_research")?.requiredCapabilities).toEqual([
      "use_research_tools",
      "use_server_provider_credentials",
    ]);
    expect(catalog.get("evaluate_decisions")?.requiredCapabilities).toEqual([]);

    runWithCapabilityFundingSession(capabilityFunding, () => {
      const forbidden = catalog.getFiltered({
        file: "forbidden",
        convert: "forbidden",
        run_deep_research: "forbidden",
        evaluate_decisions: "forbidden",
      }).entries.map((entry) => entry.name);
      expect(forbidden).not.toContain("file");
      expect(forbidden).not.toContain("convert");
      expect(forbidden).not.toContain("run_deep_research");
      expect(forbidden).not.toContain("evaluate_decisions");

      expect(catalog.getUnavailableReasonForExposure("run_deep_research", {
        activatedToolNames: ["run_deep_research"],
        context: { deepResearchForegroundAvailable: false },
      })).toContain("cannot start from this turn");
    });
  });

  test("personal capability funding exposes decisions without a server decision key", () => {
    const catalog = new ToolCatalog();
    registerAllTools(catalog, {
      officeCliAvailable: () => false,
      decisionModelsAvailable: () => false,
      mediaGenerationAvailable: () => false,
    });

    const available = () => catalog.getFiltered(undefined, undefined, {
      context: { turnId: "turn-a", fullEncryptionOnly: false },
    }).entries.map((entry) => entry.name);
    expect(available()).not.toContain("evaluate_decisions");
    runWithCapabilityFundingSession(capabilityFunding, () => {
      expect(available()).toContain("evaluate_decisions");
    });
  });
});
