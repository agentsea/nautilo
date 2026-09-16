import { invariant, requiredString } from "../core/errors.js";
import { requireMembership } from "../identity/membership.js";

export function findFolder(ctx, folderId) {
  const folder = ctx.store.folders.get(folderId);
  invariant(folder && !folder.archived, 404, "folder_missing", "Folder was not found");
  return folder;
}
export function folderInProject(ctx, projectId, folderId) {
  const folder = findFolder(ctx, folderId);
  invariant(folder.projectId === projectId, 404, "folder_missing", "Folder was not found in this project");
  return folder;
}
export function renameFolder(ctx, actor, projectId, folderId, body) {
  requireMembership(ctx, actor.userId, projectId, "write");
  const folder = folderInProject(ctx, projectId, folderId);
  const updated = ctx.store.folders.update(folder.id, { name: requiredString(body.name, "name") });
  return { folderId: updated.id, name: updated.name };
}
export function listFolders(ctx, actor, projectId) {
  requireMembership(ctx, actor.userId, projectId, "read");
  return ctx.store.folders.all().filter((folder) => folder.projectId === projectId && !folder.archived);
}
