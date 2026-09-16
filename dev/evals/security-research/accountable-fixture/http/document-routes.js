import { preview, previewMany } from "../documents/preview.js";
import { downloadBundle } from "../documents/bundles.js";
import { issueShare, readShared } from "../documents/sharing.js";
import { listFolders, renameFolder } from "../uploads/folders.js";

export function documentRoutes(ctx, route) {
  route("GET", "/projects/:projectId/documents/:documentId", (actor, p) => preview(ctx, actor, p.projectId, p.documentId));
  route("POST", "/projects/:projectId/previews", (actor, p, body) => previewMany(ctx, actor, p.projectId, body.documentIds));
  route("POST", "/projects/:projectId/bundles", (actor, p, body) => downloadBundle(ctx, actor, p.projectId, body));
  route("POST", "/projects/:projectId/shares", (actor, p, body) => issueShare(ctx, actor, p.projectId, body));
  route("POST", "/shared/:documentId", (_actor, p, body) => readShared(ctx, body.token, p.documentId), { public: true });
  route("GET", "/projects/:projectId/folders", (actor, p) => listFolders(ctx, actor, p.projectId));
  route("PATCH", "/projects/:projectId/folders/:folderId", (actor, p, body) => renameFolder(ctx, actor, p.projectId, p.folderId, body));
}
