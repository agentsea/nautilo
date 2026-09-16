import { describe, expect, test } from "bun:test";
import { ToolCatalog } from "@nautilo/catalog";
import {
  classifyHostScope,
  checkCategoricalHostAdmissionPrerequisite,
  isReviewedConnectionRelayTool,
  resolveToolCallHostScope,
} from "../../src/runtime/host-scoped-tools";
import { registerAllTools } from "../../src/tools/register-all";
import { isSupportedComputerUseToolName } from "../../src/runtime/computer-use-admission";

describe("D458 host-scoped Tool classification", () => {
  const localOrigin = {
    kind: "local_electron" as const,
    userId: "user-1",
    actorId: "actor-1",
    relayId: "relay-1",
    desktopSessionId: "desktop-session-1",
    pairingGeneration: "pairing-1",
    requestId: "request-1",
  };

  test("categorically denies a required host tool with no verified origin", () => {
    expect(checkCategoricalHostAdmissionPrerequisite({
      hostScope: "required",
      toolName: "terminal",
      verifiedOrdinaryOrigin: null,
    })).toEqual({
      status: "denied",
      reason: "host-scoped tools require a verified authorized-computer origin",
    });
  });

  test("allows local Electron host admission to continue to exact selection", () => {
    expect(checkCategoricalHostAdmissionPrerequisite({
      hostScope: "required",
      toolName: "terminal",
      verifiedOrdinaryOrigin: localOrigin,
    })).toEqual({ status: "allowed" });
  });

  test("retains the paired-mobile browser release denial", () => {
    expect(checkCategoricalHostAdmissionPrerequisite({
      hostScope: "required",
      toolName: "browser_snapshot",
      verifiedOrdinaryOrigin: {
        kind: "paired_mobile",
        serverInstanceId: "server-1",
        serverBindingGeneration: 1,
        userId: "user-1",
        actorId: "actor-1",
        controllerInstallationId: "controller-1",
        installationGeneration: 1,
        requestId: "request-1",
      },
    })).toEqual({
      status: "denied",
      reason: "browser tools are not available from paired mobile in this release",
    });
  });
  test.each([
    "run_shell",
    "terminal",
    "browser_snapshot",
    "unknown_future_relay_tool",
  ])("%s requires a paired host when Relay-executed", (toolName) => {
    expect(classifyHostScope({ toolName, executor: "relay" })).toBe("required");
  });

  test("a Relay-hosted local MCP Tool is host-scoped even when its name is unknown", () => {
    expect(
      classifyHostScope({
        toolName: "third_party_local_tool",
        executor: "relay",
        hostedBy: "relay-owned-host",
      }),
    ).toBe("required");
  });

  test.each(["google_workspace", "hue_lights"])(
    "%s remains Connection-owned rather than pairing-gated",
    (toolName) => {
      expect(isReviewedConnectionRelayTool(toolName)).toBe(true);
      expect(classifyHostScope({ toolName, executor: "relay" })).toBe(
        "not_host_scoped",
      );
    },
  );

  test.each(["file", "apply_patch"])(
    "%s defers host scope until its trusted target router resolves",
    (toolName) => {
      expect(classifyHostScope({ toolName, executor: "cloud" })).toBe(
        "conditional",
      );
    },
  );

  test("ordinary server Tools do not acquire host scope", () => {
    expect(
      classifyHostScope({ toolName: "search_memory", executor: "cloud" }),
    ).toBe("not_host_scoped");
  });

  test.each([
    [{ command: "read", zone: "current", path: "notes.md" }, "required"],
    [{ command: "read", zone: "absolute", path: "/tmp/notes.md" }, "required"],
    [{ command: "read", zone: "workspace", path: "notes.md" }, "not_host_scoped"],
    [{ command: "read", zone: "home", path: "notes.md" }, "not_host_scoped"],
    [{ command: "read", zone: "scratch", path: "notes.md" }, "not_host_scoped"],
    [{ command: "read", zone: "future_zone", path: "notes.md" }, "required"],
    [{ command: "pin_revision", revisionId: "local:relay:1" }, "required"],
    [{ command: "list_revisions", path: "/tmp/notes.md" }, "required"],
    [{ command: "list_revisions", path: "notes.md" }, "not_host_scoped"],
  ] as const)("resolves file args %j to %s", (args, expected) => {
    expect(resolveToolCallHostScope({
      classified: "conditional",
      toolName: "file",
      args,
      currentFolder: "/Users/test/project",
    })).toBe(expected);
  });

  test.each([
    [{ target: "current" }, "/Users/test/project", "required"],
    [{ target: "workspace" }, "/Users/test/project", "not_host_scoped"],
    [{ target: "future_target" }, "/Users/test/project", "required"],
    [{}, "/Users/test/project", "required"],
    [{}, "", "not_host_scoped"],
  ] as const)("resolves apply_patch args %j with folder %s to %s", (args, currentFolder, expected) => {
    expect(resolveToolCallHostScope({
      classified: "conditional",
      toolName: "apply_patch",
      args,
      currentFolder,
    })).toBe(expected);
  });

  test("every built-in Relay Tool is either host-scoped or an explicit Connection exception", () => {
    const catalog = new ToolCatalog();
    registerAllTools(catalog, { officeCliAvailable: () => false });

    const relayEntries = catalog.query({ executor: "relay" });
    expect(relayEntries.length).toBeGreaterThan(0);

    for (const entry of relayEntries) {
      const scope = classifyHostScope({
        toolName: entry.name,
        executor: "relay",
        hostedBy: entry.hostedBy,
      });
      if (scope === "not_host_scoped") {
        // Exactly two reviewed exception families may skip D458 host
        // resolution: Connection-owned integrations, and D516 semantic
        // computer tools whose exact host binding is established by the
        // computer-use admission resolver and re-fenced at dispatch/Electron.
        expect(
          isReviewedConnectionRelayTool(entry.name)
            || isSupportedComputerUseToolName(entry.name),
        ).toBe(true);
      } else {
        expect(scope).toBe("required");
      }
    }
  });
});
