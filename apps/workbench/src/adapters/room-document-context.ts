import type { ChatFocusedResourceRef } from "@nautilo/types";
import { mergeFocusedResourcesForSend } from "./focused-resource-send";
import { readActiveMiniApp, readLiveMiniAppSession } from "./mini-app-context-ref";

/** Open work surfaces are ambient context, not attachments authored in a Room. */
export function readRoomDocumentContext(input: {
  externalContext: boolean;
  explicitFocusedResources: readonly ChatFocusedResourceRef[];
  contextualFocusedResources: readonly ChatFocusedResourceRef[];
  workspaceAttachmentResources: readonly ChatFocusedResourceRef[];
}) {
  const activeMiniApp = input.externalContext ? null : readActiveMiniApp();
  const liveMiniAppSession = input.externalContext ? null : readLiveMiniAppSession();
  return {
    ...(activeMiniApp ? { activeMiniApp } : {}),
    ...(liveMiniAppSession ? { liveMiniAppSession } : {}),
    focusedResources: mergeFocusedResourcesForSend(
      input.explicitFocusedResources,
      [
        ...(input.externalContext ? [] : input.contextualFocusedResources),
        ...input.workspaceAttachmentResources,
      ],
    ),
  };
}
