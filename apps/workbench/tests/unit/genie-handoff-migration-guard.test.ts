import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";

const workbenchRoot = resolve(import.meta.dir, "../..");
const source = (path: string) => readFileSync(resolve(workbenchRoot, path), "utf8");

function sourceFiles(path: string): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = resolve(path, entry.name);
    return entry.isDirectory() ? sourceFiles(child) : [child];
  });
}

describe("Genie handoff migration guard", () => {
  test("removes the process-global adapter and its test", () => {
    expect(existsSync(resolve(workbenchRoot, "src/adapters/send-to-genie-ref.ts"))).toBe(false);
    expect(existsSync(resolve(workbenchRoot, "tests/unit/send-to-genie-ref.test.ts"))).toBe(false);
  });

  test("keeps retired sentinel families and bespoke recovery adapters deleted", () => {
    for (const retiredPath of [
      "src/components/launch-customization-listener.tsx",
      "src/components/tool-card/launch-customization-action.ts",
      "src/components/tool-card/google-workspace-connect.ts",
      "src/components/tool-card/GoogleWorkspaceConnectDialog.tsx",
      "src/components/tool-card/GoogleWorkspaceConnectPrompt.tsx",
    ]) {
      expect(existsSync(resolve(workbenchRoot, retiredPath))).toBe(false);
    }

    const retired = /NAUTILO_ACTION:|launch-customization-action|google-workspace-connect|workbenchHrefForUiTarget|openWorkbenchCustomizationRecovery|openGuideUserCustomization/u;
    for (const path of sourceFiles(resolve(workbenchRoot, "src"))) {
      expect(readFileSync(path, "utf8")).not.toMatch(retired);
    }
  });

  test("keeps bridge ownership in the shell and removes forbidden imports", () => {
    const shell = source("src/layouts/workbench-shell.tsx");
    const saas = source("src/apps/saas-app-surface.tsx");
    const conversation = source("src/components/conversation.tsx");
    expect(shell).toContain("createGenieHandoffBridge");
    expect(shell).toContain("onSendToGenie={genieHandoffBridge.deliverBrowserPageDraft}");
    expect(shell).toContain("registerSendToGenieDraftDispatcher={genieHandoffBridge.registerBrowserPageDraftDispatcher}");
    expect(saas).toContain("onSendToGenie?:");
    expect(saas).not.toContain("send-to-genie-ref");
    expect(saas).not.toContain("createRoom");
    expect(saas).not.toContain("sendOrdinaryRoomMessage");
    expect(conversation).toContain("createBrowserPageDraftDispatcher");
    expect(conversation).not.toContain("send-to-genie-ref");

    const retired = /send-to-genie-ref|setSendToGenieDispatcher|requestSendToGenie|installSendToGenieDraftDispatcher|getSendToGenieDispatcherSnapshot/u;
    for (const path of sourceFiles(resolve(workbenchRoot, "src"))) {
      expect(readFileSync(path, "utf8")).not.toMatch(retired);
    }
  });
});
