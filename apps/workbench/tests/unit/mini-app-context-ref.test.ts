import { describe, expect, test } from "bun:test";
import type { ActiveMiniAppContext } from "../../src/apps/app-bridge";
import {
  ACTIVE_MINI_APP_CONTEXT_TTL_MS,
  clearActiveMiniApp,
  mapActiveMiniAppContext,
  publishActiveMiniApp,
  readActiveMiniApp,
} from "../../src/adapters/mini-app-context-ref";

const baseContext: ActiveMiniAppContext = {
  appId: "sample-app",
  target: {
    kind: "artifact",
    id: "internal-artifact-id",
    path: "budget.document.json",
    mimeType: "application/vnd.nautilo.document+json",
    roomId: "room-uuid",
  },
  summary: {
    title: "Budget",
    documentPath: "budget.document.json",
    selection: { sheetName: "Sheet1", range: "A1:C12" },
    summary: {
      document: {
        sheetName: "Sheet1",
        usedRange: "A1:F40",
        dirty: false,
        lastSavedAt: "14:32",
        summary: "revenue/cost worksheet with 40 rows.",
      },
    },
  },
  updatedAt: 1_700_000_000_000,
};

describe("mini-app-context-ref", () => {
  test("mapActiveMiniAppContext maps target to targetKind only", () => {
    const mapped = mapActiveMiniAppContext(baseContext, "Sample App");
    expect(mapped).toEqual({
      appId: "sample-app",
      appName: "Sample App",
      documentPath: "budget.document.json",
      targetKind: "artifact",
      selection: { sheetName: "Sheet1", range: "A1:C12" },
      summary: {
        document: {
          sheetName: "Sheet1",
          usedRange: "A1:F40",
          dirty: false,
          lastSavedAt: "14:32",
          summary: "revenue/cost worksheet with 40 rows.",
        },
      },
      updatedAt: 1_700_000_000_000,
    });
    expect(mapped).not.toHaveProperty("artifactId");
    expect(mapped).not.toHaveProperty("roomId");
  });

  test("readActiveMiniApp returns fresh snapshot and omits stale context", () => {
    clearActiveMiniApp();
    publishActiveMiniApp(mapActiveMiniAppContext(baseContext));

    const fresh = readActiveMiniApp(baseContext.updatedAt + 1_000);
    expect(fresh?.appId).toBe("sample-app");

    const stale = readActiveMiniApp(baseContext.updatedAt + ACTIVE_MINI_APP_CONTEXT_TTL_MS + 1);
    expect(stale).toBeNull();
  });

  test("clearActiveMiniApp resets the ref", () => {
    publishActiveMiniApp(mapActiveMiniAppContext(baseContext));
    clearActiveMiniApp();
    expect(readActiveMiniApp()).toBeNull();
  });
});
