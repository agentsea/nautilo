export type InlineEditKeyAction = "none" | "save" | "cancel";

export function inlineEditKeyAction(input: {
  key: string;
  shiftKey: boolean;
  isComposing: boolean;
}): InlineEditKeyAction {
  if (input.isComposing) return "none";
  if (input.key === "Escape") return "cancel";
  if (input.key === "Enter" && !input.shiftKey) return "save";
  return "none";
}

export type RemoteEditResolution = "none" | "close" | "conflict";

export function remoteEditResolution(input: {
  localBaseRevision: number;
  remoteRevision: number;
  localDraft: string;
  localBaseContent: string;
}): RemoteEditResolution {
  if (input.remoteRevision <= input.localBaseRevision) return "none";
  return input.localDraft === input.localBaseContent ? "close" : "conflict";
}
