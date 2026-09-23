export function isOwnHumanMessage(
  sourceUserId: string | undefined,
  viewerUserId: string | null,
): boolean {
  return sourceUserId != null
    && viewerUserId != null
    && sourceUserId === viewerUserId;
}

export function hasKnownHumanMessageAuthor(
  role: string,
  sourceUserId: string | undefined,
): boolean {
  return role !== "user" || sourceUserId != null;
}

export function resolveHumanMessageAuthorLabel(options: {
  sourceUserId: string | undefined;
  viewerUserId: string | null;
  labels?: ReadonlyMap<string, string>;
}): string {
  if (isOwnHumanMessage(options.sourceUserId, options.viewerUserId)) return "You";
  if (!options.sourceUserId) return "Unknown sender";
  return options.labels?.get(options.sourceUserId) ?? "Unknown sender";
}

export function isCurrentMessageDeleteConfirmation(
  confirmationScope: string | null,
  currentScope: string,
  canDelete: boolean,
): boolean {
  return canDelete && confirmationScope !== null && confirmationScope === currentScope;
}
