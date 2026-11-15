import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ChatFocusedResourceRef, LiveMiniAppSessionCapability } from "@nautilo/types";
import {
  clearActiveMiniApp,
  publishActiveMiniApp,
  publishLiveMiniAppSession,
  readActiveMiniApp,
  readLiveMiniAppSession,
} from "../../src/adapters/mini-app-context-ref";
import { readRoomDocumentContext } from "../../src/adapters/room-document-context";

const openDocument: ChatFocusedResourceRef = { kind: "workspace-artifact", artifactId: "open-design" };
const liveSession: LiveMiniAppSessionCapability = {
  sessionId: "test-session",
  sessionToken: "synthetic-session-token",
  documentVersion: { kind: "artifact_revision", revision: 1 },
};

beforeEach(() => {
  publishActiveMiniApp({ appId: "nautilo-design", documentPath: "Example.design.html", updatedAt: Date.now() });
  publishLiveMiniAppSession(liveSession);
});
afterEach(clearActiveMiniApp);

describe("Room document context", () => {
  test("text sent to an external Room excludes open Design context without closing it", () => {
    const context = readRoomDocumentContext({
      externalContext: true,
      explicitFocusedResources: [],
      contextualFocusedResources: [openDocument],
      workspaceAttachmentResources: [],
    });
    const request = { content: "Hello", ...context };
    expect(request).toEqual({ content: "Hello", focusedResources: [] });
    expect(readActiveMiniApp()?.appId).toBe("nautilo-design");
    expect(readLiveMiniAppSession()).toEqual(liveSession);
  });

  test("regular Room sends still include the same open document and live session", () => {
    const context = readRoomDocumentContext({
      externalContext: false,
      explicitFocusedResources: [],
      contextualFocusedResources: [openDocument],
      workspaceAttachmentResources: [],
    });
    expect(context.activeMiniApp?.documentPath).toBe("Example.design.html");
    expect(context.liveMiniAppSession).toEqual(liveSession);
    expect(context.focusedResources).toEqual([openDocument]);
  });

  test("explicit focus and uploaded workspace documents survive external Room filtering", () => {
    const uploaded: ChatFocusedResourceRef = { kind: "workspace-artifact", artifactId: "explicit-upload" };
    const explicit = [openDocument];
    const contextual = [openDocument, { kind: "workspace-artifact", artifactId: "ambient-other" } as const];
    const context = readRoomDocumentContext({
      externalContext: true,
      explicitFocusedResources: explicit,
      contextualFocusedResources: contextual,
      workspaceAttachmentResources: [uploaded],
    });
    expect(context.focusedResources).toEqual([openDocument, uploaded]);
    expect(explicit).toEqual([openDocument]);
    expect(contextual).toHaveLength(2);
  });

  test("switching Room policy does not clear the document for the next regular send", () => {
    const input = { explicitFocusedResources: [], contextualFocusedResources: [openDocument], workspaceAttachmentResources: [] };
    expect(readRoomDocumentContext({ ...input, externalContext: false }).activeMiniApp).toBeDefined();
    expect(readRoomDocumentContext({ ...input, externalContext: true }).activeMiniApp).toBeUndefined();
    expect(readRoomDocumentContext({ ...input, externalContext: false }).focusedResources).toEqual([openDocument]);
  });
});
