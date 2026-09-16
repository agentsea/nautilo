import type { OpenFileTarget } from "../components/browser-column/open-file-target";
import { apiClient } from "../lib/api";
import { desktopAPI } from "../lib/desktop";
import { HTML_VIEWER_MAX_BYTES } from "../viewers/html/adapter";

const ASSOCIATION_SNIFF_MAX_BYTES = HTML_VIEWER_MAX_BYTES;

export async function readFileTextForAssociation(file: OpenFileTarget): Promise<string | null> {
  if (file.kind === "artifact") {
    const blob =
      file.roomId !== undefined
        ? await apiClient.getWorkspaceArtifactBytes(file.id, { roomId: file.roomId })
        : await apiClient.getWorkspaceArtifactBytes(file.id);
    if (blob.size > ASSOCIATION_SNIFF_MAX_BYTES) return null;
    return blob.text();
  }

  if (!desktopAPI) return null;
  const stat = await desktopAPI.fs.stat(file.path);
  if (!stat.exists || !stat.isFile || stat.size > ASSOCIATION_SNIFF_MAX_BYTES) return null;
  return desktopAPI.fs.readFile(file.path);
}
